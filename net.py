"""Shared HTTP helpers."""
import json
import ssl
import time
import urllib.error
import urllib.request

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()


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


class ApiError(Exception):
    pass


RETRY_STATUS = {429, 500, 502, 503, 504}
PARSE_ERRORS = (ValueError, KeyError, IndexError, AttributeError, TypeError)


def post_json(url: str, payload: dict, key: str, parse=None, timeout: int = 90, attempts: int = 3):
    """POST JSON with a bearer key, retrying transient failures; `parse(data)` runs inside the retry loop."""
    body = json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": "subtitle-flashcards",
    }
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                data = json.load(r)
            return parse(data) if parse else data
        except urllib.error.HTTPError as e:
            detail = e.read()[:200].decode("utf-8", "replace")
            last = ApiError(f"OpenRouter HTTP {e.code}: {detail}")
            if e.code not in RETRY_STATUS:
                break
        except (*PARSE_ERRORS, urllib.error.URLError, TimeoutError) as e:
            last = ApiError(f"{type(e).__name__}: {e}")
        time.sleep(2 ** attempt)
    raise last
