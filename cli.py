#!/usr/bin/env python3
"""Extract Basque words from a subtitle file/URL and print RemNote flashcards.

Run: python3 cli.py subs.srt [--lemmatize] [--json]
"""
import argparse
import json
import sys

from core import fetch_url, format_remnote, process


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("source", help="subtitle file path, URL, or '-' for stdin")
    p.add_argument("--min-len", type=int, default=4)
    p.add_argument("--min-freq", type=int, default=1)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--lemmatize", action="store_true", help="use stanza lemmatization")
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
        lemmatize=args.lemmatize,
        do_translate=not args.no_translate,
    )
    if result["stanzaMissing"]:
        print("warning: stanza not installed; used regex tokenizer", file=sys.stderr)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_remnote(result["words"], examples=not args.no_examples))
    return 0


if __name__ == "__main__":
    sys.exit(main())
