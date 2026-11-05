// Small text helpers shared by the UI.

const pad = n => String(n).padStart(2, '0');

/** Seconds -> "m:ss" or "h:mm:ss"; empty for a missing time. */
export function fmtTime(s) {
  if (s == null) return '';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? `${h}:${pad(m)}` : `${m}`) + ':' + pad(s % 60);
}

/** "2:20" or "1:02:03" -> seconds; null when it isn't a valid time. */
export function parseTime(str) {
  const parts = str.trim().split(':').map(Number);
  if (!str.trim() || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
export const countWords = s => (s.match(/\p{L}+/gu) || []).length;
