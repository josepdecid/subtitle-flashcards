"""Translate Basque words to Spanish using their subtitle line as context.

Uses OpenRouter when OPENROUTER_API_KEY is set (in the environment or in a .env file).
Set OPENROUTER_MODEL to change the model (default: google/gemini-2.5-flash).
Without a key it falls back to MyMemory, which is much less accurate.

`lemmatize_translate` additionally asks the model for the Basque dictionary headword of each inflected form.
"""
import json
import os
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from net import SSL_CTX, ApiError, post_json

ROOT = Path(__file__).parent
CACHE_FILE = ROOT / "translations_cache.json"
CACHE = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-2.5-flash"
BATCH_SIZE = 25
# Dictionary forms (lemmas) may legitimately contain hyphens.
LEMMA_RE = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*")

SYSTEM_PROMPT = """You are a Basque-Spanish lexicographer helping a learner build flashcards from TV subtitles.
You receive a JSON list of entries: {"id", "word", "context"}.
"word" is a Basque headword (normally the dictionary form; if it looks inflected, translate its dictionary form).
"context" is the subtitle line where it occurs; use it to pick the sense that fits.
Reply with JSON only: {"translations": {"<id>": "<Spanish translation>"}}.
Rules for each translation:
- 1 to 3 short Spanish equivalents separated by ", ", most fitting sense first.
- Lowercase; verbs in infinitive, nouns in singular, adjectives in masculine singular.
- No explanations, no part-of-speech labels, never repeat the Basque word.
- If the word is a proper name, a typo or not Basque, use an empty string."""

LEMMA_PROMPT = """You are a Basque-Spanish lexicographer helping a learner build flashcards from TV subtitles.
You receive a JSON list of entries: {"id", "word", "context"}.
"word" is a Basque word exactly as it appears in the subtitle line "context" (usually inflected).
Reply with JSON only: {"entries": {"<id>": {"lemma": "<Basque headword>", "translation": "<Spanish>"}}}.
Rules:
- "lemma" is the standard dictionary headword (Euskaltzaindia / Elhuyar style) with every suffix removed:
  nouns and adjectives without article, case or number (emakumeak -> emakume, etxeetan -> etxe);
  verbs as the participle (dut/dira are auxiliaries, but ikusi, egin, joan are headwords);
  keep derivational roots and hyphenated compounds as headwords. Use the context to resolve ambiguity.
- "translation" is 1 to 3 short Spanish equivalents of the lemma separated by ", ", most fitting sense first.
  Use root dictionary forms only: lowercase, verbs in infinitive, nouns in singular without article,
  adjectives in masculine singular. No explanations, no part-of-speech labels, never repeat the Basque word.
- Use {"lemma": "", "translation": ""} when the word is a proper name, a typo, not Basque, an interjection,
  a conjugated auxiliary/light-verb form, or a function word (pronoun, particle, postposition, numeral)."""


def load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def save_cache() -> None:
    CACHE_FILE.write_text(json.dumps(CACHE, ensure_ascii=False, indent=1))


def _clean(value, word: str) -> str:
    text = str(value or "").strip().strip(".").lower()
    return "" if text == word else text


def _parse_json(content: str) -> dict:
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in response")
    return json.loads(content[start:end + 1])


def _chat_json(system: str, entries: list[dict], key: str, model: str, field: str) -> dict:
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(entries, ensure_ascii=False)},
        ],
    }
    return post_json(
        OPENROUTER_URL, payload, key,
        parse=lambda data: _parse_json(data["choices"][0]["message"]["content"])[field],
    )


def _llm_batch(batch: list[dict], key: str, model: str) -> list[str]:
    entries = [{"id": str(i), "word": it["word"], "context": it["example"]} for i, it in enumerate(batch)]
    result = _chat_json(SYSTEM_PROMPT, entries, key, model, "translations")
    return [_clean(result.get(str(i)), it["word"]) for i, it in enumerate(batch)]


def _lemma_batch(batch: list[dict], key: str, model: str) -> list[dict | None]:
    entries = [{"id": str(i), "word": it["word"], "context": it["example"]} for i, it in enumerate(batch)]
    result = _chat_json(LEMMA_PROMPT, entries, key, model, "entries")
    out = []
    for i in range(len(batch)):
        entry = result.get(str(i))
        if not isinstance(entry, dict):
            out.append(None)
            continue
        lemma = str(entry.get("lemma") or "").strip().lower()
        if not LEMMA_RE.fullmatch(lemma):
            out.append({"lemma": "", "translation": ""})
        else:
            out.append({"lemma": lemma, "translation": _clean(entry.get("translation"), lemma)})
    return out


def _run_batches(todo: list[dict], fn) -> tuple[list, str | None]:
    """Run fn over batches of `todo` concurrently; return ([(item, result)], first error)."""
    batches = [todo[i:i + BATCH_SIZE] for i in range(0, len(todo), BATCH_SIZE)]

    def run(batch):
        try:
            return batch, fn(batch), None
        except ApiError as e:
            return batch, [], str(e)

    pairs, error = [], None
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch, results, err in pool.map(run, batches):
            error = error or err
            pairs.extend(zip(batch, results))
    return pairs, error


def _translate_openrouter(words: list[dict], key: str, model: str) -> str | None:
    todo = []
    for item in words:
        cached = CACHE.get(f"{model}|{item['word']}|{item['example']}")
        item["translation"] = cached or ""
        if not cached:
            todo.append(item)
    pairs, error = _run_batches(todo, lambda batch: _llm_batch(batch, key, model))
    for item, tr in pairs:
        item["translation"] = tr
        if tr:
            CACHE[f"{model}|{item['word']}|{item['example']}"] = tr
    return error


def llm_available() -> bool:
    load_env()
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def lemmatize_translate(words: list[dict]) -> dict:
    """Set item["lemma"] and item["translation"] on each word using the LLM.

    lemma "" means the model rejected the word (name, typo, auxiliary, ...); None means it could not be processed.
    """
    load_env()
    key = os.environ["OPENROUTER_API_KEY"]
    model = os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
    todo = []
    for item in words:
        cached = CACHE.get(f"lemma|{model}|{item['word']}|{item['example']}")
        item["lemma"], item["translation"] = (cached["lemma"], cached["translation"]) if cached else (None, "")
        if not cached:
            todo.append(item)
    pairs, error = _run_batches(todo, lambda batch: _lemma_batch(batch, key, model))
    for item, res in pairs:
        if res is not None:
            item["lemma"], item["translation"] = res["lemma"], res["translation"]
            CACHE[f"lemma|{model}|{item['word']}|{item['example']}"] = res
    save_cache()
    return {"translator": f"openrouter:{model}", "translateError": error}


def _mymemory(word: str) -> str:
    cache_key = f"mymemory|{word}"
    if cache_key in CACHE:
        return CACHE[cache_key]
    url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode({"q": word, "langpair": "eu|es"})
    try:
        with urllib.request.urlopen(url, timeout=10, context=SSL_CTX) as r:
            data = json.load(r)
        if data.get("responseStatus") != 200:
            return ""
        result = _clean(data["responseData"]["translatedText"], word)
    except Exception:
        return ""
    if not result or "mymemory" in result:
        return ""
    CACHE[cache_key] = result
    return result


def translate_all(words: list[dict]) -> dict:
    """Fill in item["translation"] for every word; return info about the translator used."""
    load_env()
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        model = os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
        error = _translate_openrouter(words, key, model)
        info = {"translator": f"openrouter:{model}", "translateError": error}
    else:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for item, tr in zip(words, pool.map(lambda i: _mymemory(i["word"]), words)):
                item["translation"] = tr
        info = {
            "translator": "mymemory",
            "translateError": "OPENROUTER_API_KEY not set; used MyMemory (low quality).",
        }
    save_cache()
    return info
