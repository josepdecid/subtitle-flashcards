"""Pre-filter candidate words with Jev (typesafe/jev on OpenRouter) before the LLM lemmatizes them.

For each word, Jev answers two yes/no questions with a probability:
  is_proper_name  - person, place or brand rather than a common word
  is_useful       - a real Basque content word worth studying (not a typo, filler, auxiliary or function word)
Set JEV_MODEL to change the model (default: typesafe/jev-1.13).
"""
import os
from concurrent.futures import ThreadPoolExecutor

from net import ApiError, post_json
from translate import CACHE, load_env, save_cache

JEV_URL = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_JEV_MODEL = "typesafe/jev-1.13"
MAX_NAME_PROB = 0.5

QUESTIONS = {
    "is_proper_name": {
        "type": "noul",
        "instructions": "Is `word`, as used in `subtitle_line`, a proper name (person, place, brand, title) rather than a common word?",
    },
    "is_useful": {
        "type": "noul",
        "instructions": (
            "Is `word`, as used in `subtitle_line`, a real Basque noun, verb, adjective or adverb "
            "worth a language learner studying? Answer no for typos, non-Basque words, interjections, "
            "filler, conjugated auxiliary verbs, pronouns, particles and other function words."
        ),
    },
}


def _ask(item: dict, key: str, model: str) -> dict:
    payload = {
        "model": model,
        "state": {"language": "Basque", "word": item["word"], "subtitle_line": item["example"]},
        "questions": QUESTIONS,
    }

    def parse(data):
        answers = data["answers"]
        return {"name": float(answers["is_proper_name"]["noul"]), "useful": float(answers["is_useful"]["noul"])}

    return post_json(JEV_URL, payload, key, parse=parse, timeout=30)


def filter_candidates(words: list[dict], min_useful: float = 0.5) -> tuple[list[dict], dict]:
    """Drop proper names and unhelpful words; return (kept, info). Words Jev can't judge are kept."""
    load_env()
    key = os.environ["OPENROUTER_API_KEY"]
    model = os.environ.get("JEV_MODEL", DEFAULT_JEV_MODEL)
    scores: dict[int, dict | None] = {}
    todo = []
    for i, item in enumerate(words):
        cached = CACHE.get(f"jev|{model}|{item['word']}|{item['example']}")
        scores[i] = cached
        if not cached:
            todo.append(i)

    error = None

    def run(i):
        try:
            return i, _ask(words[i], key, model), None
        except ApiError as e:
            return i, None, str(e)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, res, err in pool.map(run, todo):
            error = error or err
            if res:
                scores[i] = res
                CACHE[f"jev|{model}|{words[i]['word']}|{words[i]['example']}"] = res
    save_cache()

    kept = []
    for i, item in enumerate(words):
        s = scores[i]
        if s and (s["name"] > MAX_NAME_PROB or s["useful"] < min_useful):
            continue
        kept.append(item)
    return kept, {"jevModel": model, "jevDropped": len(words) - len(kept), "jevError": error}
