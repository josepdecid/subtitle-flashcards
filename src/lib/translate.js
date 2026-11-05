// Translate Basque words to Spanish using their subtitle line as context.
//
// Uses OpenRouter when the visitor has connected a key; otherwise falls back to MyMemory, which is much less accurate.
// `lemmatizeTranslate` additionally asks the model for the Basque dictionary headword of each inflected form.

import { getModel, getKey, mapPool, postJson } from './openrouter.js';
import { cache, cachePut } from './storage.js';
import { LEMMA_RE } from './words.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const BATCH_SIZE = 25;

const SYSTEM_PROMPT = `You are a Basque-Spanish lexicographer helping a learner build flashcards from TV subtitles.
You receive a JSON list of entries: {"id", "word", "context"}.
"word" is a Basque headword (normally the dictionary form; if it looks inflected, translate its dictionary form).
"context" is the subtitle line where it occurs; use it to pick the sense that fits.
Reply with JSON only: {"translations": {"<id>": "<Spanish translation>"}}.
Rules for each translation:
- 1 to 3 short Spanish equivalents separated by ", ", most fitting sense first.
- Lowercase; verbs in infinitive, nouns in singular, adjectives in masculine singular.
- No explanations, no part-of-speech labels, never repeat the Basque word.
- If the word is a proper name, a typo or not Basque, use an empty string.`;

const LEMMA_PROMPT = `You are a Basque-Spanish lexicographer helping a learner build flashcards from TV subtitles.
You receive a JSON list of entries: {"id", "word", "context"}.
"word" is a Basque word exactly as it appears in the subtitle line "context" (usually inflected).
Reply with JSON only: {"entries": {"<id>": {"lemma": "<Basque headword>", "translation": "<Spanish>"}}}.
Rules:
- "lemma" is the standard dictionary headword (Euskaltzaindia / Elhuyar style) with every suffix removed:
  nouns and adjectives without article, case or number (emakumeak -> emakume, etxeetan -> etxe);
  verbs as the participle (dut/dira are auxiliaries, but ikusi, egin, joan are headwords);
  keep derivational roots and hyphenated compounds as headwords. Use the context to resolve ambiguity.
- "translation" is 1 to 3 short Spanish equivalents of the lemma separated by ", ", most fitting sense first.
  Use root dictionary forms only: lowercase, verbs in infinitive, nouns in singular without article,
  adjectives in masculine singular. No explanations, no part-of-speech labels, never repeat the Basque word.
- Use {"lemma": "", "translation": ""} when the word is a proper name, a typo, not Basque, an interjection,
  a conjugated auxiliary/light-verb form, or a function word (pronoun, particle, postposition, numeral).`;

function clean(value, word) {
  const text = String(value || '').trim().replace(/^\.+|\.+$/g, '').trim().toLowerCase();
  return text === word ? '' : text;
}

function parseJsonObject(content) {
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in response');
  return JSON.parse(content.slice(start, end + 1));
}

function chatJson(system, entries, model, field) {
  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(entries) },
    ],
  };
  return postJson(OPENROUTER_URL, payload, {
    parse: data => {
      const value = parseJsonObject(data.choices[0].message.content)[field];
      if (!value || typeof value !== 'object') throw new Error(`response has no "${field}" object`);
      return value;
    },
  });
}

const toEntries = batch => batch.map((it, i) => ({ id: String(i), word: it.word, context: it.example }));

async function llmBatch(batch, model) {
  const result = await chatJson(SYSTEM_PROMPT, toEntries(batch), model, 'translations');
  return batch.map((it, i) => clean(result[String(i)], it.word));
}

async function lemmaBatch(batch, model) {
  const result = await chatJson(LEMMA_PROMPT, toEntries(batch), model, 'entries');
  return batch.map((_, i) => {
    const entry = result[String(i)];
    if (!entry || typeof entry !== 'object') return null;
    const lemma = String(entry.lemma || '').trim().toLowerCase();
    if (!LEMMA_RE.test(lemma)) return { lemma: '', translation: '' };
    return { lemma, translation: clean(entry.translation, lemma) };
  });
}

/** Run fn over batches of `todo` (4 at a time); calls onBatch(batch, results) per success; returns the first error. */
async function runBatches(todo, fn, onBatch) {
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));
  let error = null;
  await mapPool(batches, 4, async batch => {
    try {
      onBatch(batch, await fn(batch));
    } catch (e) {
      error ??= e.message;
    }
  });
  return error;
}

const isLemmaEntry = v => v && typeof v === 'object' && typeof v.lemma === 'string' && typeof v.translation === 'string';

/**
 * Set item.lemma and item.translation on each word using the LLM.
 * lemma "" means the model rejected the word (name, typo, auxiliary, ...); null means it could not be processed.
 */
export async function lemmatizeTranslate(words) {
  const model = getModel();
  const cacheKey = it => `lemma|${model}|${it.word}|${it.example}`;
  const todo = [];
  for (const item of words) {
    const cached = cache.get(cacheKey(item));
    if (isLemmaEntry(cached)) Object.assign(item, { lemma: cached.lemma, translation: cached.translation });
    else {
      Object.assign(item, { lemma: null, translation: '' });
      todo.push(item);
    }
  }
  const error = await runBatches(todo, batch => lemmaBatch(batch, model), (batch, results) => {
    const fresh = [];
    batch.forEach((item, i) => {
      const res = results[i];
      if (!res) return;
      Object.assign(item, res);
      fresh.push([cacheKey(item), res]);
    });
    cachePut(fresh);
  });
  return { translator: `openrouter:${model}`, translateError: error };
}

async function translateOpenrouter(words, model) {
  const cacheKey = it => `${model}|${it.word}|${it.example}`;
  const todo = [];
  for (const item of words) {
    const cached = cache.get(cacheKey(item));
    item.translation = typeof cached === 'string' ? cached : '';
    if (!item.translation) todo.push(item);
  }
  return runBatches(todo, batch => llmBatch(batch, model), (batch, results) => {
    const fresh = [];
    batch.forEach((item, i) => {
      item.translation = results[i];
      if (results[i]) fresh.push([cacheKey(item), results[i]]);
    });
    cachePut(fresh);
  });
}

async function mymemory(word) {
  const key = `mymemory|${word}`;
  if (typeof cache.get(key) === 'string') return cache.get(key);
  const url = 'https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: word, langpair: 'eu|es' });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await r.json();
    if (data.responseStatus != 200) return '';
    const result = clean(data.responseData.translatedText, word);
    if (!result || result.includes('mymemory')) return '';
    cachePut([[key, result]]);
    return result;
  } catch {
    return '';
  }
}

/** Fill in item.translation for every word; return info about the translator used. */
export async function translateAll(words) {
  if (getKey()) {
    const model = getModel();
    const error = await translateOpenrouter(words, model);
    return { translator: `openrouter:${model}`, translateError: error };
  }
  const results = await mapPool(words, 8, item => mymemory(item.word));
  words.forEach((item, i) => { item.translation = results[i]; });
  return { translator: 'mymemory', translateError: 'Not connected to OpenRouter; used MyMemory (low quality).' };
}
