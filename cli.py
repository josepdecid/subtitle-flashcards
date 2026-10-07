#!/usr/bin/env python3
"""Extract Basque words from a subtitle file/URL and print RemNote flashcards.

Run: python3 cli.py subs.srt [--json] [--mark-known]
"""
import argparse
import json
import sys

from core import add_known, format_remnote, process
from net import fetch_url


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("source", help="subtitle file path, URL, or '-' for stdin")
    p.add_argument("--min-len", type=int, default=4)
    p.add_argument("--min-freq", type=int, default=1)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--no-lemmatize", action="store_true", help="skip stanza lemmatization (use plain word forms)")
    p.add_argument("--include-known", action="store_true", help="don't hide words from known_words.txt")
    p.add_argument("--mark-known", action="store_true", help="add the printed words to known_words.txt")
    p.add_argument("--no-translate", action="store_true")
    p.add_argument("--no-examples", action="store_true", help="omit example sentences")
    p.add_argument("--json", action="store_true", help="output JSON instead of RemNote text")
    args = p.parse_args()

    if args.source == "-":
        text = sys.stdin.read()
    elif args.source.startswith(("http://", "https://")):
        text = fetch_url(args.source)
    else:
        with open(args.source, encoding="utf-8-sig", errors="replace") as f:
            text = f.read()

    result = process(
        text,
        min_len=args.min_len,
        min_freq=args.min_freq,
        limit=args.limit,
        lemmatize=not args.no_lemmatize,
        do_translate=not args.no_translate,
        use_known=not args.include_known,
    )
    if result["stanzaMissing"]:
        print("warning: stanza not installed; used regex tokenizer", file=sys.stderr)
    if result.get("translateError"):
        print(f"warning: {result['translateError']}", file=sys.stderr)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_remnote(result["words"], examples=not args.no_examples))
    if args.mark_known:
        n = add_known([w["word"] for w in result["words"]])
        print(f"marked {n} new words as known", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
