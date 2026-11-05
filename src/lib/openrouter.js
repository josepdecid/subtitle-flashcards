// OpenRouter access with the visitor's own key: OAuth PKCE sign-in, manual key entry, and JSON POSTs with retries.

import { session, settings } from './storage.js';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const AUTH_URL = 'https://openrouter.ai/auth';
const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';

export class ApiError extends Error {}

export const getKey = () => settings.get('openrouter-key');
export const setKey = key => settings.set('openrouter-key', key.trim());
export const getModel = () => settings.get('openrouter-model') || DEFAULT_MODEL;
export const setModel = model => settings.set('openrouter-model', model.trim());
export const llmAvailable = () => Boolean(getKey());

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const callbackUrl = () => location.origin + location.pathname;

/** Send the visitor to OpenRouter to approve a key for this app; they come back with ?code=…&state=…. */
export async function startOAuth() {
  const verifier = random(32), state = random(16);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  session.set('pkce', JSON.stringify({ verifier, state }));
  const query = new URLSearchParams({
    callback_url: callbackUrl(),
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    state,
    key_label: 'Subtitle Flashcards',
  });
  location.assign(`${AUTH_URL}?${query}`);
}

/** If the page was opened by the OAuth callback, exchange the code for a key. Returns true when a key was saved. */
export async function finishOAuth() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;
  history.replaceState(null, '', callbackUrl() + location.hash);
  const saved = JSON.parse(session.get('pkce') || 'null');
  session.set('pkce', '');
  if (!saved || params.get('state') !== saved.state)
    throw new ApiError('The OpenRouter sign-in could not be verified. Try connecting again.');
  const r = await fetch(KEYS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.key) throw new ApiError(`OpenRouter sign-in failed (HTTP ${r.status}). Try connecting again.`);
  setKey(data.key);
  return true;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** POST JSON with the stored key, retrying transient failures; `parse(data)` runs inside the retry loop. */
export async function postJson(url, payload, { parse = d => d, timeout = 90, attempts = 3 } = {}) {
  const key = getKey();
  if (!key) throw new ApiError('Not connected to OpenRouter.');
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'subtitle-flashcards' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (r.ok) return parse(await r.json());
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      last = new ApiError(`OpenRouter HTTP ${r.status}: ${detail}`);
      if (!RETRY_STATUS.has(r.status)) break;
    } catch (e) {
      last = new ApiError(`${e.name}: ${e.message}`);
    }
    if (attempt < attempts - 1) await sleep(1000 * 2 ** attempt);
  }
  throw last;
}

/** Run `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
