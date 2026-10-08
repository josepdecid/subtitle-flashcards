"""Core logic: parse subtitles, extract Basque words, translate them."""
import html
import re
import unicodedata
from collections import Counter, deque
from pathlib import Path

from jev import filter_candidates, reject_reason, score_candidates
from translate import LEMMA_RE, lemmatize_translate, llm_available, translate_all

ROOT = Path(__file__).parent
KNOWN_FILE = ROOT / "known_words.txt"

# Basque function words (and common inflected forms, for the regex tokenizer) that aren't worth studying.
STOPWORDS = set(
    """
    eta edo ez bai ba bada baita ezta baina ere ordea aldiz berriz ala al ote omen bait zeren ezen baldin nahiz
    oso hain asko gutxi gehiago gehien guztiz bakarrik jada dagoeneko noski agian hala horrela honela orduan
    hemen han hor hona hara horra hemendik handik hortik orain gero beti inoiz nehoiz behin oraindik
    bat bi hiru lau bost sei zazpi zortzi bederatzi hamar
    gabe baino bezala bezain arte buruz zehar gain azpi aurrean atzean
    guztia guztiak guztiek guztien guztiei batzuk batzuek batzuei edozein edonor edonon edonoiz zenbait zenbat
    ezer inor inon inork ezertarako ezein bestea bestelako beste
    ni nik niri nire nigan zu zuk zuri zure zugan hura hark hari haren hau honek honi honen hori horrek horri horren
    hauek hauen hauei horiek horien horiei haiek haien haiei gu guk guri gure zuek zuei zuen
    bere beren geure zeure
    zer zein nor nork nori noren non nola noiz zergatik zertarako nondik nora
    izan ukan egon edin ezan ahal behar nahi
    da dira zen ziren naiz zara gara zarete nintzen zinen ginen zineten dela direla zela zirela naizela zarela garela
    du dut duzu dugu duzue dute zuen nuen zenuen genuen zenuten zuten dudan duen dutela duela
    dago daude zegoen zeuden dagoen daudenak dauka daukat daukazu daukagu dauzka dauzkat
    izango izateko izatea izaten izanda izanik egongo
    """.split()
)

# Letters only, so apostrophes and hyphens split tokens (Basque compounds like "ikus-entzunezko").
TOKEN_RE = re.compile(r"[^\W\d_]+")

SPEAKER_RE = re.compile(r"^[-–\s]*[A-ZÑÇÁÉÍÓÚÜ][A-ZÑÇÁÉÍÓÚÜ0-9 .'’]{1,24}:\s*")
SOUND_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)")
DEDUPE_WINDOW = 4

EXAMPLE_MIN, EXAMPLE_MAX = 20, 60


TIME_RE = re.compile(r"(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?")


def parse_timestamp(text: str) -> float | None:
    """Seconds from "00:01:02,500", "01:02.5" or ASS "0:01:02.50"."""
    m = TIME_RE.search(text)
    if not m:
        return None
    h, mi, sec, frac = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(sec) + (int(frac) / 10 ** len(frac) if frac else 0)


def parse_cues(text: str) -> list[dict]:
    """Return the dialogue lines from SRT / VTT / ASS content as {"t": start seconds or None, "text": str}."""
    cues = []
    recent: deque[str] = deque(maxlen=DEDUPE_WINDOW)
    start = None
    text = unicodedata.normalize("NFC", text.lstrip("\ufeff"))
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith(("NOTE", "STYLE", "Kind:", "Language:")):
            continue
        if "-->" in line:
            start = parse_timestamp(line.split("-->")[0])
            continue
        if re.fullmatch(r"\d+", line):
            continue
        if line.startswith("Dialogue:"):  # ASS/SSA
            parts = line.split(",", 9)
            start = parse_timestamp(parts[1]) if len(parts) == 10 else None
            line = parts[9] if len(parts) == 10 else ""
        elif re.match(r"^\[(Script Info|V4\+? Styles|Events)\]|^(Format|Style):", line):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # html-ish tags
        line = re.sub(r"\{[^}]*\}", "", line)  # ASS override tags
        line = html.unescape(line)
        line = line.replace("\\N", " ").replace("\\n", " ").replace("\\h", " ")
        line = re.sub(r"[♪♫]", "", line)
        line = SOUND_RE.sub("", line).strip()  # [musika], (barrez)
        line = SPEAKER_RE.sub("", line).strip()  # JON: ...
        letters = [c for c in line if c.isalpha()]
        if len(letters) < 4 or not any(c.islower() for c in letters):  # signs, credits
            continue
        key = line.casefold()
        if key in recent:  # overlapping cues / auto-caption repeats
            continue
        recent.append(key)
        cues.append({"t": start, "text": line})
    return cues


def parse_subtitles(text: str) -> list[str]:
    return [c["text"] for c in parse_cues(text)]


def load_known() -> set[str]:
    if not KNOWN_FILE.exists():
        return set()
    return {
        l.strip().lower()
        for l in KNOWN_FILE.read_text(encoding="utf-8").splitlines()
        if l.strip() and not l.startswith("#")
    }


def add_known(words: list[str]) -> int:
    """Append new words to the known-words file; return how many were added."""
    existing = load_known()
    new = sorted({w.strip().lower() for w in words if w.strip()} - existing)
    if new:
        with KNOWN_FILE.open("a", encoding="utf-8") as f:
            f.writelines(w + "\n" for w in new)
    return len(new)


KEEP_POS = {"NOUN", "VERB", "ADJ", "ADV"}  # drops PROPN, AUX, PRON, DET, NUM, INTJ, X, ...
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
    """Yield (line, [(token, capitalized_mid_sentence), ...])."""
    for line in lines:
        tokens = []
        for m in TOKEN_RE.finditer(line):
            before = line[:m.start()].rstrip(" -–—\"'“¿¡([")
            sentence_start = not before or before[-1] in ".!?…:"
            tokens.append((m.group().lower(), m.group()[0].isupper() and not sentence_start))
        yield line, tokens


def stanza_tokens(lines):
    import stanza

    nlp = get_nlp()
    docs = nlp([stanza.Document([], text=l) for l in lines])
    for line, doc in zip(lines, docs):
        tokens = []
        for sent in doc.sentences:
            for i, w in enumerate(sent.words):
                if w.upos in KEEP_POS and w.lemma and LEMMA_RE.fullmatch(w.lemma):
                    tokens.append((w.lemma.lower(), i > 0 and w.text[:1].isupper()))
        yield line, tokens


def example_penalty(line: str) -> int:
    n = len(line)
    return max(EXAMPLE_MIN - n, n - EXAMPLE_MAX, 0)


def analyze_words(lines: list[str], min_len: int, min_freq: int, limit: int, use_stanza=False, known=frozenset()):
    """Count every word and say why it is discarded: a dict per word with reason None (kept) or a reason code."""
    counts: Counter = Counter()
    examples: dict[str, tuple[int, str]] = {}
    name_like: dict[str, bool] = {}  # only ever seen capitalized mid-sentence => probably a name
    for line, tokens in (stanza_tokens(lines) if use_stanza else regex_tokens(lines)):
        seen = set()
        for w, mid_cap in tokens:
            counts[w] += 1
            name_like[w] = name_like.get(w, True) and mid_cap
            if w not in seen:
                seen.add(w)
                penalty = example_penalty(line)
                if w not in examples or penalty < examples[w][0]:
                    examples[w] = (penalty, line)
    items, kept = [], 0
    for w, c in counts.most_common():
        if w in STOPWORDS:
            reason = "stopword"
        elif len(w) < min_len:
            reason = "short"
        elif w in known:
            reason = "known"
        elif name_like[w]:
            reason = "name"
        elif c < min_freq:
            reason = "freq"
        elif kept >= limit:
            reason = "limit"
        else:
            reason, kept = None, kept + 1
        items.append({"word": w, "count": c, "example": examples[w][1], "reason": reason})
    return items


def extract_words(lines: list[str], min_len: int, min_freq: int, limit: int, use_stanza=False, known=frozenset()):
    items = analyze_words(lines, min_len, min_freq, limit, use_stanza, known)
    words = [{k: it[k] for k in ("word", "count", "example")} for it in items if not it["reason"]]
    return words, sum(it["reason"] == "known" for it in items)


OVERFETCH = 3  # candidate surface forms per wanted word; merging inflections shrinks the list


def merge_lemmas(items: list[dict], known) -> tuple[list[dict], int]:
    """Group surface forms (sorted by count, descending) under their lemma."""
    merged: dict[str, dict] = {}
    known_hits: set[str] = set()
    for it in items:
        lemma = it["word"] if it.get("lemma") is None else it["lemma"]
        if not lemma:
            continue
        if lemma in known:
            known_hits.add(lemma)
            continue
        m = merged.get(lemma)
        if m is None:
            merged[lemma] = {
                "word": lemma, "count": it["count"], "translation": it["translation"],
                "example": it["example"], "forms": [it["word"]],
            }
            continue
        m["count"] += it["count"]
        m["forms"].append(it["word"])
        m["translation"] = m["translation"] or it["translation"]
        if example_penalty(it["example"]) < example_penalty(m["example"]):
            m["example"] = it["example"]
    return list(merged.values()), len(known_hits)


def resolve_engine(engine: str, lemmatize: bool, do_translate: bool) -> str:
    if not lemmatize or engine == "regex":
        return "regex"
    if engine in ("auto", "llm") and do_translate and llm_available():
        return "llm"
    return "stanza" if stanza_available() else "regex"


def process(
    text: str, min_len=4, min_freq=1, limit=50, lemmatize=True, do_translate=True, use_known=True,
    engine="auto", jev=True, min_useful=0.5,
) -> dict:
    """Run the full pipeline on subtitle text and return the result dict.

    engine: "llm" (Jev filter + LLM lemma/translation), "stanza", "regex" or "auto" (best available).
    """
    lines = parse_subtitles(text)
    known = load_known() if use_known else frozenset()
    chosen = resolve_engine(engine, lemmatize, do_translate)
    if chosen == "llm":
        candidates, known_skipped = extract_words(lines, min_len, 1, limit * OVERFETCH, False, known)
        result = {"lines": len(lines), "engine": "llm", "stanzaMissing": False, "candidates": len(candidates)}
        if jev:
            candidates, info = filter_candidates(candidates, min_useful)
            result.update(info)
        result.update(lemmatize_translate(candidates))
        words, lemma_known = merge_lemmas(candidates, known)
        words = [w for w in words if w["count"] >= min_freq][:limit]
        result.update(words=words, knownSkipped=known_skipped + lemma_known)
        return result

    words, known_skipped = extract_words(lines, min_len, min_freq, limit, chosen == "stanza", known)
    result = {
        "words": words,
        "lines": len(lines),
        "engine": chosen,
        "stanzaMissing": lemmatize and engine != "regex" and chosen == "regex",
        "knownSkipped": known_skipped,
    }
    if do_translate:
        result.update(translate_all(words))
    return result


def find_candidates(
    lines: list[str], min_len=4, min_freq=1, limit=150, use_known=True, engine="auto", jev=True, min_useful=0.5,
) -> dict:
    """Step 3: list every word with the reason it was discarded (None = will be translated)."""
    known = load_known() if use_known else frozenset()
    chosen = resolve_engine(engine, True, True)
    words = analyze_words(lines, min_len, min_freq, limit, chosen == "stanza", known)
    result = {"engine": chosen, "stanzaMissing": engine != "regex" and chosen == "regex"}
    if chosen == "llm" and jev:
        pending = [w for w in words if not w["reason"]]
        scores, info = score_candidates(pending)
        for w, score in zip(pending, scores):
            w["scores"] = score
            w["reason"] = reject_reason(score, min_useful)
        result.update(info)
    result["words"] = words
    return result


def translate_words(items: list[dict], engine: str, use_known=True) -> dict:
    """Step 4: lemmatize (LLM engine) and translate the chosen words. Words dropped on the way come back with a note."""
    items = [dict(it) for it in items]
    if engine != "llm" or not llm_available():
        result = translate_all(items)
        return {"words": items, **result}
    known = load_known() if use_known else frozenset()
    result = lemmatize_translate(items)
    words, _ = merge_lemmas(items, known)
    for it in items:
        lemma = it.get("lemma")
        note = "rejected by the LLM (name, typo, auxiliary or function word)" if lemma == "" else (
            "already in known words" if lemma in known else None)
        if note:
            words.append({"word": it["word"], "count": it["count"], "translation": "", "example": it["example"], "note": note})
    return {"words": words, **result}


def format_remnote(words: list[dict], examples=True) -> str:
    out = []
    for w in words:
        s = f"{w['word']} :: {w.get('translation') or ''}"
        if examples and w["example"]:
            s += f"\n    {w['example']}"
        out.append(s)
    return "\n".join(out)
