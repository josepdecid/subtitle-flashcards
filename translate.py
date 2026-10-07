"""Translate Basque words to Spanish using their subtitle line as context.

Uses OpenRouter when OPENROUTER_API_KEY is set (in the environment or in a .env file).
Set OPENROUTER_MODEL to change the model (default: google/gemini-2.5-flash).
Without a key it falls back to MyMemory, which is much less accurate.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from net import SSL_CTX

ROOT = Path(__file__).parent
CACHE_FILE = ROOT / "translations_cache.json"
CACHE = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-2.5-flash"
BATCH_SIZE = 25
RETRY_STATUS = {429, 500, 502, 503, 504}

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


class TranslationError(Exception):
    pass


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


def _llm_batch(batch: list[dict], key: str, model: str) -> list[str]:
    entries = [{"id": str(i), "word": it["word"], "context": it["example"]} for i, it in enumerate(batch)]
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(entries, ensure_ascii=False)},
        ],
    }).encode()
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": "subtitle-flashcards",
    }
    last: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(OPENROUTER_URL, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=90, context=SSL_CTX) as r:
                data = json.load(r)
            result = _parse_json(data["choices"][0]["message"]["content"])["translations"]
            return [_clean(result.get(str(i)), it["word"]) for i, it in enumerate(batch)]
        except urllib.error.HTTPError as e:
            detail = e.read()[:200].decode("utf-8", "replace")
            last = TranslationError(f"OpenRouter HTTP {e.code}: {detail}")
            if e.code not in RETRY_STATUS:
                break
        except (ValueError, KeyError, IndexError, AttributeError, urllib.error.URLError, TimeoutError) as e:
            last = TranslationError(f"{type(e).__name__}: {e}")
        time.sleep(2 ** attempt)
    raise last


def _translate_openrouter(words: list[dict], key: str, model: str) -> str | None:
    todo = []
    for item in words:
        cached = CACHE.get(f"{model}|{item['word']}|{item['example']}")
        item["translation"] = cached or ""
        if not cached:
            todo.append(item)
    batches = [todo[i:i + BATCH_SIZE] for i in range(0, len(todo), BATCH_SIZE)]

    def run(batch):
        try:
            return batch, _llm_batch(batch, key, model), None
        except TranslationError as e:
            return batch, [], str(e)

    error = None
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch, translations, err in pool.map(run, batches):
            error = error or err
            for item, tr in zip(batch, translations):
                item["translation"] = tr
                if tr:
                    CACHE[f"{model}|{item['word']}|{item['example']}"] = tr
    return error


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
