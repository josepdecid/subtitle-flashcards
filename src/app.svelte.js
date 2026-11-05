// App-wide reactive state and the actions that move the learner through the four steps.
// Components read and write `app` directly; anything that touches several steps lives here.

import { SvelteSet } from 'svelte/reactivity';
import { countWords, plural } from './lib/format.js';
import { getLangs, setLangs, SOURCE_LANGS, TARGET_LANGS } from './lib/languages.js';
import { finishOAuth, getKey, setKey, startOAuth } from './lib/openrouter.js';
import { findCandidates, translateWords } from './lib/pipeline.js';
import { deleteShow, loadData, saveShow, settings, shows } from './lib/storage.js';

// Pastel tints that cycle through stat tiles and word cards.
export const TINTS = ['bg-butter', 'bg-mint', 'bg-lilac', 'bg-peach'];

class AppState {
  step = $state(1);
  maxStep = $state(1);

  // The lesson: language pair plus the show's name and notes.
  source = $state(getLangs().source);
  target = $state(getLangs().target);
  showName = $state('');
  notes = $state('');
  /** Name of the saved show being edited; '' for a new one. */
  show = $state('');

  key = $state(getKey());
  /** Bumped whenever known words, saved shows or the cache change, since storage keeps them in plain Maps/Sets. */
  rev = $state(0);

  lines = $state.raw([]);        // {t, s, w}
  sections = $state([]);         // {a, b, label}
  expanded = new SvelteSet();    // first line index of expanded skipped runs
  filters = $state({ limit: 150, minLen: 4, minFreq: 1, minUseful: 0.5, engine: 'auto', jev: true, useKnown: true });
  cands = $state([]);            // {word, count, example, reason, scores, override}
  words = $state([]);            // {word, translation, count, example, keep, note}
  cardQuery = $state('');

  status = $state({});           // step -> {msg, kind}
  toast = $state('');
  toastOn = $state(false);

  // Signatures of the inputs behind cands/words, so going forward again reuses them when nothing changed.
  candKey = '';
  wordKey = '';
  engine = 'auto';
}

export const app = new AppState();

// ---------- feedback ----------
export function setStatus(step, msg, kind = 'info') {
  app.status[step] = msg ? { msg, kind } : null;
}

let toastTimer;
export function toast(msg) {
  app.toast = msg;
  app.toastOn = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { app.toastOn = false; }, 2000);
}

export function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- navigation ----------
export function go(n) {
  app.step = n;
  app.maxStep = Math.max(app.maxStep, n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- lesson & saved shows ----------
/** The language pair and show title + notes that steps 3 and 4 work with. */
export function lesson() {
  const name = app.showName.trim(), notes = app.notes.trim();
  const context = [name && `Title: ${name}`, notes].filter(Boolean).join('\n');
  return { source: app.source, target: app.target, context };
}
const lessonSig = () => JSON.stringify(lesson());

/** Words and cards depend on the lesson, so editing it sends the learner back through "Find words". */
export function lessonChanged() {
  app.candKey = app.wordKey = '';
  if (app.lines.length) app.maxStep = Math.min(app.maxStep, 2);
}

function selectShow(name) {
  app.show = shows.has(name) ? name : '';
  settings.set('show', app.show);
}

/** Fill in a saved show's name, notes and languages ('' starts a new show). */
export function pickShow(name) {
  const show = shows.get(name);
  app.showName = show?.name || '';
  app.notes = show?.context || '';
  if (show) {
    if (SOURCE_LANGS.includes(show.source)) app.source = show.source;
    if (TARGET_LANGS.includes(show.target)) app.target = show.target;
    setLangs(lesson());
  }
  selectShow(name);
  lessonChanged();
}

/** Save the name, notes and languages as a show. Editing the name of the selected show renames it. */
export function rememberShow() {
  const name = app.showName.trim(), current = app.show;
  if (!name) { if (current) selectShow(''); return; }
  if (current && current !== name && !shows.has(name)) deleteShow(current);
  saveShow({ name, context: app.notes.trim(), source: app.source, target: app.target });
  app.rev++;
  selectShow(name);
}

export function removeShow(name) {
  deleteShow(name);
  app.rev++;
  if (name === app.show) pickShow('');
}

// ---------- OpenRouter ----------
export const connect = () => startOAuth().catch(e => toast('Error: ' + e.message));
export function saveKey(key) {
  setKey(key);
  app.key = getKey();
}

// ---------- step 2: subtitles & skips ----------
export function loadLines(cues) {
  app.lines = cues.map(c => ({ t: c.t, s: c.text, w: countWords(c.text) }));
  app.sections = [];
  app.expanded.clear();
  app.candKey = app.wordKey = '';
  app.maxStep = 1;
}

/** true for every line inside a skipped section. */
export function skipMask() {
  const mask = new Array(app.lines.length).fill(false);
  for (const s of app.sections) for (let i = s.a; i <= s.b; i++) mask[i] = true;
  return mask;
}

// ---------- step 3: candidate words ----------
export const included = c => c.override ?? !c.reason;
const num = (v, fallback) => Number.isFinite(v) ? v : fallback;

async function loadCandidates() {
  const mask = skipMask();
  const lines = app.lines.filter((_, i) => !mask[i]).map(l => l.s);
  const f = app.filters;
  setStatus(3, 'Analysing words — this can take a moment…');
  const data = await findCandidates(lines, lesson(), {
    limit: num(f.limit, 150), minLen: num(f.minLen, 4), minFreq: num(f.minFreq, 1),
    minUseful: num(f.minUseful, 0.5), engine: f.engine, jev: f.jev, useKnown: f.useKnown,
  });
  app.rev++; // scores may have been cached
  app.cands = data.words.map(w => ({ ...w, override: null }));
  app.engine = data.engine;
  const warn = [];
  if (data.jevError) warn.push('Jev warning: ' + data.jevError);
  if (data.llmMissing) warn.push('Not connected to OpenRouter, so plain word forms were used. Connect in Settings to get root words.');
  const kept = app.cands.filter(c => !c.reason).length;
  setStatus(3, [`${lines.length} lines · ${app.cands.length} distinct words · ${kept} to translate · engine: ${data.engine}`, ...warn].join('\n'), warn.length ? 'info' : 'ok');
}

export async function findWords() {
  const key = lessonSig() + JSON.stringify(app.sections.map(s => [s.a, s.b]));
  go(3);
  if (key === app.candKey && app.cands.length) return;
  try {
    await loadCandidates();
    app.candKey = key;
    app.wordKey = '';
  } catch (e) {
    setStatus(3, 'Error: ' + e.message, 'error');
  }
}

export async function rerunFilters() {
  try {
    await loadCandidates();
    app.wordKey = '';
  } catch (e) {
    setStatus(3, 'Error: ' + e.message, 'error');
  }
}

// ---------- step 4: translations ----------
export async function translate() {
  const chosen = app.cands.filter(included);
  const key = lessonSig() + app.engine + '|' + chosen.map(c => c.word).join(',');
  go(4);
  if (key === app.wordKey && app.words.length) return;
  setStatus(4, 'Translating — this can take a moment…');
  try {
    const data = await translateWords(chosen, lesson(), app.engine, app.filters.useKnown);
    app.rev++; // translations are cached
    app.words = data.words.map(w => ({ ...w, keep: !w.note }));
    app.wordKey = key;
    app.cardQuery = '';
    const warn = [];
    if (data.translateError) warn.push('Translation warning: ' + data.translateError);
    const dropped = app.words.filter(w => w.note).length;
    const info = [plural(app.words.length - dropped, 'word')];
    if (dropped) info.push(`${dropped} removed after lemmatizing (shown unticked)`);
    if (data.translator) info.push(`translated by ${data.translator}`);
    setStatus(4, info.join(' · ') + (warn.length ? '\n' + warn.join(' ') : ''), warn.length ? 'info' : 'ok');
  } catch (e) {
    setStatus(4, 'Error: ' + e.message, 'error');
  }
}

// ---------- start ----------
export async function init() {
  const persistent = await loadData();
  app.rev++;
  if (!persistent) setStatus(1, "This browser isn't saving data (private mode?). Known words, shows and translations won't be kept.", 'info');
  if (shows.has(settings.get('show'))) pickShow(settings.get('show'));
  else selectShow('');
  try {
    if (await finishOAuth()) {
      app.key = getKey();
      toast('Connected to OpenRouter');
    }
  } catch (e) {
    setStatus(1, e.message, 'error');
  }
}
