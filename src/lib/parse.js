// Parse SRT / VTT / ASS subtitle files into dialogue lines.

const TIME_RE = /(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/;
const SPEAKER_RE = /^[-–\s]*[A-ZÑÇÁÉÍÓÚÜ][A-ZÑÇÁÉÍÓÚÜ0-9 .'’]{1,24}:\s*/u;
const SOUND_RE = /\[[^\]]*\]|\([^)]*\)/g;
const ASS_HEADER_RE = /^\[(Script Info|V4\+? Styles|Events)\]|^(Format|Style):/;
const DEDUPE_WINDOW = 4;

/** Seconds from "00:01:02,500", "01:02.5" or ASS "0:01:02.50". */
export function parseTimestamp(text) {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const [, h, mi, sec, frac] = m;
  return +(h || 0) * 3600 + +mi * 60 + +sec + (frac ? +frac / 10 ** frac.length : 0);
}

/** Like Python's str.split(sep, maxsplit): the last part keeps the remainder. */
function splitN(text, sep, max) {
  const parts = [];
  let rest = text;
  while (parts.length < max) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  parts.push(rest);
  return parts;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
let decoder;
function unescapeHtml(text) {
  if (!text.includes('&')) return text;
  if (typeof document !== 'undefined') {
    // <textarea> content is parsed as plain text, so only entities are decoded.
    decoder ??= document.createElement('textarea');
    decoder.innerHTML = text;
    return decoder.value;
  }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/** Decode file bytes as UTF-8, falling back to Windows-1252 (Latin-1). */
export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Dialogue lines from SRT / VTT / ASS content as {t: start seconds or null, text}. */
export function parseCues(text) {
  const cues = [];
  const recent = [];
  let start = null;
  text = text.replace(/^﻿/, '').normalize('NFC');
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(WEBVTT|NOTE|STYLE|Kind:|Language:)/.test(line)) continue;
    if (line.includes('-->')) {
      start = parseTimestamp(line.split('-->')[0]);
      continue;
    }
    if (/^\d+$/.test(line)) continue;
    if (line.startsWith('Dialogue:')) {
      const parts = splitN(line, ',', 9);
      start = parts.length === 10 ? parseTimestamp(parts[1]) : null;
      line = parts.length === 10 ? parts[9] : '';
    } else if (ASS_HEADER_RE.test(line)) {
      continue;
    }
    line = line.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '');
    line = unescapeHtml(line);
    line = line.replaceAll('\\N', ' ').replaceAll('\\n', ' ').replaceAll('\\h', ' ');
    line = line.replace(/[♪♫]/g, '');
    line = line.replace(SOUND_RE, '').trim();
    line = line.replace(SPEAKER_RE, '').trim();
    const letters = line.match(/\p{L}/gu) || [];
    if (letters.length < 4 || !letters.some(c => /\p{Ll}/u.test(c))) continue; // signs, credits
    const key = line.toLowerCase();
    if (recent.includes(key)) continue; // overlapping cues / auto-caption repeats
    recent.push(key);
    if (recent.length > DEDUPE_WINDOW) recent.shift();
    cues.push({ t: start, text: line });
  }
  return cues;
}
