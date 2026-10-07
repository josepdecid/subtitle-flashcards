#!/usr/bin/env python3
"""Extract Basque words from subtitle files and format them as RemNote flashcards.

Run: python3 server.py   then open http://localhost:8000
(For the command line, see cli.py.)
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core import ROOT, add_known, process
from net import fetch_url


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path not in ("/api/extract", "/api/known"):
            return self.send_error(404)
        try:
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/api/known":
                return self._json({"added": add_known(payload.get("words", []))})
            text = payload.get("text") or fetch_url(payload["url"])
            result = process(
                text,
                min_len=int(payload.get("minLen", 4)),
                min_freq=int(payload.get("minFreq", 1)),
                limit=int(payload.get("limit", 50)),
                lemmatize=bool(payload.get("lemmatize", True)),
                do_translate=bool(payload.get("translate", True)),
                use_known=bool(payload.get("useKnown", True)),
            )
            self._json(result)
        except Exception as e:
            self._json({"error": f"{type(e).__name__}: {e}"}, 400)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    args = parser.parse_args()
    print(f"Open http://localhost:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
