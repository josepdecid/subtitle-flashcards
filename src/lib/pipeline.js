// The steps the UI runs: load subtitles, find candidate words, translate the chosen ones.

import { rejectReason, scoreCandidates } from './jev.js';
import { llmAvailable } from './openrouter.js';
import { decodeText } from './parse.js';
import { known } from './storage.js';
import { lemmatizeTranslate, translateAll } from './translate.js';
import { analyzeWords, mergeLemmas } from './words.js';

/** Download subtitles in the browser. Works only when the host allows cross-origin requests (CORS). */
export async function fetchSubtitles(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new Error("The browser couldn't download that URL. The site probably blocks requests from other sites (CORS). Download the file and use “Upload file” instead.");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} downloading the subtitles.`);
  return decodeText(await r.arrayBuffer());
}

/** "llm" (Jev filter + LLM lemma/translation) when connected and not turned off, otherwise "regex" (plain word forms). */
export function resolveEngine(engine) {
  return engine !== 'regex' && llmAvailable() ? 'llm' : 'regex';
}

/** Step 3: list every word with the reason it was discarded (null = will be translated). */
export async function findCandidates(lines, { minLen = 4, minFreq = 1, limit = 150, useKnown = true, engine = 'auto', jev = true, minUseful = 0.5 } = {}) {
  const chosen = resolveEngine(engine);
  const words = analyzeWords(lines, { minLen, minFreq, limit, known: useKnown ? known : new Set() });
  const result = { engine: chosen, llmMissing: engine !== 'regex' && chosen === 'regex' };
  if (chosen === 'llm' && jev) {
    const pending = words.filter(w => !w.reason);
    const { scores, ...info } = await scoreCandidates(pending);
    pending.forEach((w, i) => {
      w.scores = scores[i];
      w.reason = rejectReason(scores[i], minUseful);
    });
    Object.assign(result, info);
  }
  result.words = words;
  return result;
}

/** Step 4: lemmatize (LLM engine) and translate the chosen words. Words dropped on the way come back with a note. */
export async function translateWords(chosen, engine, useKnown = true) {
  const items = chosen.map(({ word, count, example }) => ({ word, count, example }));
  if (engine !== 'llm' || !llmAvailable()) {
    const info = await translateAll(items);
    return { words: items, ...info };
  }
  const knownSet = useKnown ? known : new Set();
  const info = await lemmatizeTranslate(items);
  const [words] = mergeLemmas(items, knownSet);
  for (const it of items) {
    const note = it.lemma === '' ? 'rejected by the LLM (name, typo, auxiliary or function word)'
      : knownSet.has(it.lemma) ? 'already in known words' : null;
    if (note) words.push({ word: it.word, count: it.count, translation: '', example: it.example, note });
  }
  return { words, ...info };
}
