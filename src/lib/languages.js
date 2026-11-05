// Languages the app can work with, and the "lesson" (language pair + show context) every step shares.

import { settings } from './storage.js';

// Subtitle languages must separate words with spaces, since tokenizing is a plain \p{L}+ split.
export const SOURCE_LANGS = [
  'eu', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'gl', 'hu', 'id', 'it', 'ko',
  'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk',
];
export const TARGET_LANGS = [...SOURCE_LANGS, 'ar', 'he', 'hi', 'ja', 'th', 'vi', 'zh'];

const names = new Intl.DisplayNames(['en'], { type: 'language' });
/** English name of a language code, e.g. "eu" -> "Basque". */
export const langName = code => names.of(code) || code;

export const DEFAULT_SOURCE = 'eu';
export const DEFAULT_TARGET = 'es';

export function getLangs() {
  const source = settings.get('source-lang', DEFAULT_SOURCE);
  const target = settings.get('target-lang', DEFAULT_TARGET);
  return {
    source: SOURCE_LANGS.includes(source) ? source : DEFAULT_SOURCE,
    target: TARGET_LANGS.includes(target) ? target : DEFAULT_TARGET,
  };
}

export function setLangs({ source, target }) {
  settings.set('source-lang', source);
  settings.set('target-lang', target);
}

/**
 * Cache-key segment for results that depend on the language pair and show context.
 * Empty for Basque -> Spanish without context, so caches built before languages were selectable stay valid.
 */
export function lessonKey({ source, target, context = '' }) {
  if (source === 'eu' && target === 'es' && !context) return '';
  let h = 5381;
  for (const ch of context) h = (h * 33 + ch.codePointAt(0)) >>> 0;
  return `${source}>${target}|${context ? h.toString(36) : ''}|`;
}
