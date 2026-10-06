"""Core logic: parse subtitles, extract Basque words, translate them."""
import json
import re
import ssl
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent
CACHE_FILE = ROOT / "translations_cache.json"
CACHE = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

# Very common Basque function words that aren't worth studying.
STOPWORDS = set(
    """eta ez bai da dira du dute zen ziren zuen zuten dut duzu dugu duzue naiz
    zara gara zarete nire zure bere gure zuen hau hori hura hauek horiek haiek
    nik zuk hark guk zuek haiek ni zu hura gu zer nor non noiz nola zergatik
    baina edo ere oso hemen han orain gero beti inoiz behin bat bi hiru
    izan egin du dago daude zegoen zeuden dago dela direla zela ziren
    ba bada baita bere beren ezta nahi behar""".split()
)

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

TOKEN_RE = re.compile(r"[a-zñçü]+(?:['’-][a-zñçü]+)*", re.IGNORECASE)


def parse_subtitles(text: str) -> list[str]:
    """Return the dialogue lines from SRT / VTT / ASS content."""
    lines = []
    text = text.lstrip("\ufeff")
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith(("NOTE", "STYLE", "Kind:", "Language:")):
            continue
        if "-->" in line or re.fullmatch(r"\d+", line):
            continue
        if line.startswith("Dialogue:"):  # ASS/SSA
            parts = line.split(",", 9)
            line = parts[9] if len(parts) == 10 else ""
        elif re.match(r"^\[(Script Info|V4\+? Styles|Events)\]|^(Format|Style):", line):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # html-ish tags
        line = re.sub(r"\{[^}]*\}", "", line)  # ASS override tags
        line = line.replace("\\N", " ").replace("\\n", " ")
        line = re.sub(r"[♪♫]", "", line).strip()
        if line:
            lines.append(line)
    return lines


KEEP_POS = {"NOUN", "VERB", "ADJ", "ADV"}
_NLP = None


def stanza_available() -> bool:
    try:
        import stanza  # noqa: F401
        return True
    except ImportError:
        return False


def get_nlp():
    global _NLP
    if _NLP is None:
        import stanza

        stanza.download("eu", processors="tokenize,pos,lemma", verbose=False)
        _NLP = stanza.Pipeline("eu", processors="tokenize,pos,lemma", verbose=False)
    return _NLP


def regex_tokens(lines):
    for line in lines:
        yield line, [t.lower() for t in TOKEN_RE.findall(line)]


def stanza_tokens(lines):
    import stanza

    nlp = get_nlp()
    docs = nlp([stanza.Document([], text=l) for l in lines])
    for line, doc in zip(lines, docs):
        lemmas = []
        for sent in doc.sentences:
            for w in sent.words:
                if w.upos in KEEP_POS and w.lemma and TOKEN_RE.fullmatch(w.lemma):
                    lemmas.append(w.lemma.lower())
        yield line, lemmas


def extract_words(lines: list[str], min_len: int, min_freq: int, limit: int, use_stanza=False):
    counts: Counter = Counter()
    examples: dict[str, str] = {}
    for line, tokens in (stanza_tokens(lines) if use_stanza else regex_tokens(lines)):
        seen = set()
        for w in tokens:
            if len(w) < min_len or w in STOPWORDS:
                continue
            counts[w] += 1
            if w not in seen and (w not in examples or len(line) < len(examples[w]) and len(line) > 15):
                examples[w] = line
            seen.add(w)
    items = [(w, c) for w, c in counts.most_common() if c >= min_freq][:limit]
    return [{"word": w, "count": c, "example": examples.get(w, "")} for w, c in items]


def translate(word: str) -> str:
    if word in CACHE:
        return CACHE[word].lower()
    url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode(
        {"q": word, "langpair": "eu|es"}
    )
    try:
        with urllib.request.urlopen(url, timeout=10, context=SSL_CTX) as r:
            data = json.load(r)
        result = data["responseData"]["translatedText"].strip()
        if data.get("responseStatus") != 200 or result.lower() == word:
            return ""
    except Exception:
        return ""
    CACHE[word] = result.lower()
    return CACHE[word]


def fetch_url(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20, context=SSL_CTX) as r:
        raw = r.read()
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def save_cache() -> None:
    CACHE_FILE.write_text(json.dumps(CACHE, ensure_ascii=False, indent=1))


def translate_all(words: list[dict]) -> None:
    with ThreadPoolExecutor(max_workers=8) as pool:
        for item, tr in zip(words, pool.map(lambda i: translate(i["word"]), words)):
            item["translation"] = tr
    save_cache()


def process(text: str, min_len=4, min_freq=1, limit=50, lemmatize=False, do_translate=True) -> dict:
    """Run the full pipeline on subtitle text and return the result dict."""
    lines = parse_subtitles(text)
    use_stanza = lemmatize and stanza_available()
    words = extract_words(lines, min_len, min_freq, limit, use_stanza)
    if do_translate:
        translate_all(words)
    return {
        "words": words,
        "lines": len(lines),
        "engine": "stanza" if use_stanza else "regex",
        "stanzaMissing": lemmatize and not use_stanza,
    }


def format_remnote(words: list[dict], examples=True) -> str:
    out = []
    for w in words:
        s = f"{w['word']} :: {w.get('translation') or ''}"
        if examples and w["example"]:
            s += f"\n    {w['example']}"
        out.append(s)
    return "\n".join(out)
