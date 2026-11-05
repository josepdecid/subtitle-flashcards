// Pre-filter candidate words with Jev (typesafe/jev on OpenRouter) before the LLM lemmatizes them.
//
// For each word, Jev answers two yes/no questions with a probability:
//   is_proper_name - person, place or brand rather than a common word
//   is_useful      - a real content word in the subtitle language worth studying (not a typo, filler or function word)
// When the learner described the show, it goes along as `show_context` to help recognise its names.

import { langName, lessonKey } from './languages.js';
import { mapPool, postJson } from './openrouter.js';
import { cache, cachePut } from './storage.js';

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
const MAX_NAME_PROB = 0.5;

function questions(withContext) {
  const ctx = withContext ? ' `show_context` describes the show or film the subtitles come from.' : '';
  return {
    is_proper_name: {
      type: 'noul',
      instructions: 'Is `word`, as used in `subtitle_line`, a proper name (person, place, brand, title) rather than a common word?' +
        (withContext ? ctx + ' Treat the characters, places and brands it mentions as proper names.' : ''),
    },
    is_useful: {
      type: 'noul',
      instructions:
        'Is `word`, as used in `subtitle_line`, a real noun, verb, adjective or adverb in `language` ' +
        'worth a language learner studying? Answer no for typos, words from other languages, interjections, ' +
        'filler, conjugated auxiliary verbs, pronouns, particles and other function words.' +
        (withContext ? ctx + ' Vocabulary central to its setting or theme is especially worth studying.' : ''),
    },
  };
}

function ask(item, lesson) {
  const state = { language: langName(lesson.source), word: item.word, subtitle_line: item.example };
  if (lesson.context) state.show_context = lesson.context;
  const payload = { model: JEV_MODEL, state, questions: questions(Boolean(lesson.context)) };
  return postJson(JEV_URL, payload, {
    timeout: 30,
    parse: data => {
      const score = { name: Number(data.answers.is_proper_name.noul), useful: Number(data.answers.is_useful.noul) };
      if (Number.isNaN(score.name) || Number.isNaN(score.useful)) throw new Error('Jev returned no probabilities');
      return score;
    },
  });
}

const isScore = v => v && typeof v.name === 'number' && typeof v.useful === 'number';

/** Ask Jev about each word; returns {scores aligned with `words` (null when Jev couldn't judge), jevModel, jevError}. */
export async function scoreCandidates(words, lesson) {
  const scope = lessonKey(lesson);
  const cacheKey = it => `jev|${JEV_MODEL}|${scope}${it.word}|${it.example}`;
  const scores = words.map(it => (isScore(cache.get(cacheKey(it))) ? cache.get(cacheKey(it)) : null));
  const todo = words.map((_, i) => i).filter(i => !scores[i]);
  let error = null;
  await mapPool(todo, 8, async i => {
    try {
      scores[i] = await ask(words[i], lesson);
      cachePut([[cacheKey(words[i]), scores[i]]]);
    } catch (e) {
      error ??= e.message;
    }
  });
  return { scores, jevModel: JEV_MODEL, jevError: error };
}

export function rejectReason(score, minUseful = 0.5) {
  if (!score) return null;
  if (score.name > MAX_NAME_PROB) return 'jev_name';
  if (score.useful < minUseful) return 'jev_useless';
  return null;
}
