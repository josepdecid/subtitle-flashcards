import './style.css';
import { DEFAULT_MODEL, finishOAuth, getKey, getModel, setKey, setModel, startOAuth } from './lib/openrouter.js';
import { decodeText, parseCues } from './lib/parse.js';
import { fetchSubtitles, findCandidates, translateWords } from './lib/pipeline.js';
import { addKnown, cache, exportData, importData, known, loadData } from './lib/storage.js';

const $ = id => document.getElementById(id);
const el = (tag, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const num = (id, fallback) => {
  const v = Number($(id).value);
  return $(id).value.trim() && Number.isFinite(v) ? v : fallback;
};

const state = {
  step: 1, maxStep: 1,
  lines: [],          // {t, s, w}
  sections: [],       // {a, b, label}
  expanded: new Set(),// first line index of expanded skipped runs
  cands: [],          // {word, count, example, reason, scores, override}
  candKey: '', engine: 'auto',
  words: [],          // {word, translation, count, example, keep, note}
  wordKey: '',
  generated: false,
};

// ---------- helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('opacity-0', 'translate-y-4');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('opacity-0', 'translate-y-4'), 2000);
}

function setStatus(n, msg, kind = 'info') {
  const e = $('status' + n);
  e.textContent = msg;
  e.style.whiteSpace = 'pre-line';
  e.className = 'text-sm ' + (msg ? 'rounded-lg px-3 py-2 ' + ({
    info: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    error: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  })[kind] : '');
}

async function busy(btn, label, fn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
}

const pad = n => String(n).padStart(2, '0');
function fmtTime(s) {
  if (s == null) return '';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? `${h}:${pad(m)}` : `${m}`) + ':' + pad(s % 60);
}
function parseTime(str) {
  const parts = str.trim().split(':').map(Number);
  if (!str.trim() || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const countWords = s => (s.match(/\p{L}+/gu) || []).length;

// ---------- stepper ----------
const STEPS = ['Source', 'Preview', 'Words', 'Flashcards'];
function renderStepper() {
  const ol = $('stepper');
  ol.innerHTML = '';
  STEPS.forEach((name, i) => {
    const n = i + 1;
    const reachable = n <= state.maxStep;
    const b = el('button', 'flex items-center gap-2 rounded-full px-2 py-1 transition ' +
      (n === state.step ? 'font-semibold' : reachable ? 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800' : 'cursor-default text-slate-400'));
    b.disabled = !reachable;
    const dot = el('span', 'flex h-6 w-6 items-center justify-center rounded-full text-xs ' +
      (n === state.step ? 'bg-indigo-600 text-white' : n < state.step ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'),
      n < state.step ? '✓' : String(n));
    b.append(dot, el('span', 'hidden sm:inline', name));
    b.onclick = () => go(n);
    const li = el('li');
    li.append(b);
    ol.append(li);
  });
}

function go(n) {
  state.step = n;
  state.maxStep = Math.max(state.maxStep, n);
  for (let i = 1; i <= 4; i++) $('step' + i).hidden = i !== n;
  renderStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(+b.dataset.go));

// ---------- step 1: source ----------
let mode = 'url';
const ACTIVE = ['bg-white', 'shadow-xs', 'dark:bg-slate-900'];
function setMode(m) {
  mode = m;
  $('paneUrl').hidden = m !== 'url';
  $('paneFile').hidden = m !== 'file';
  for (const [id, on] of [['tabUrl', m === 'url'], ['tabFile', m === 'file']])
    ACTIVE.forEach(c => $(id).classList.toggle(c, on));
}
$('tabUrl').onclick = () => setMode('url');
$('tabFile').onclick = () => setMode('file');
setMode('url');

function setFile(f) { $('fileName').textContent = f ? f.name : 'Drop a file or click to browse'; }
$('file').onchange = () => setFile($('file').files[0]);
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('border-indigo-400'); };
$('drop').ondragleave = () => $('drop').classList.remove('border-indigo-400');
$('drop').ondrop = e => {
  e.preventDefault();
  $('drop').classList.remove('border-indigo-400');
  if (e.dataTransfer.files.length) { $('file').files = e.dataTransfer.files; setFile(e.dataTransfer.files[0]); }
};

$('load').onclick = () => busy($('load'), 'Loading…', async () => {
  const file = mode === 'file' ? $('file').files[0] : null;
  const url = mode === 'url' ? $('url').value.trim() : '';
  if (!file && !url) { setStatus(1, mode === 'file' ? 'Choose a subtitle file first.' : 'Enter a subtitle URL first.', 'error'); return; }
  setStatus(1, 'Loading subtitles…');
  try {
    const cues = parseCues(file ? decodeText(await file.arrayBuffer()) : await fetchSubtitles(url));
    if (!cues.length) throw new Error('No dialogue lines found in that file.');
    state.lines = cues.map(c => ({ t: c.t, s: c.text, w: countWords(c.text) }));
    state.sections = [];
    state.expanded.clear();
    state.candKey = state.wordKey = '';
    state.maxStep = 1;
    setStatus(1, '');
    $('skipError').textContent = '';
    updateSkipForm();
    renderPreview();
    go(2);
  } catch (e) {
    setStatus(1, 'Error: ' + e.message, 'error');
  }
});

// ---------- step 2: preview & skips ----------
const hasTimes = () => state.lines.some(l => l.t != null);

function skipMask() {
  const mask = new Array(state.lines.length).fill(false);
  for (const s of state.sections) for (let i = s.a; i <= s.b; i++) mask[i] = true;
  return mask;
}

function updateSkipForm() {
  const timed = hasTimes();
  for (const id of ['fromType', 'toType'])
    [...$(id).options].forEach(o => { if (o.value === 'time') o.disabled = !timed; });
  for (const [t, v] of [['fromType', 'fromVal'], ['toType', 'toVal']]) {
    const type = $(t).value;
    $(v).hidden = type === 'start' || type === 'end';
    $(v).placeholder = type === 'time' ? 'e.g. 2:20' : 'e.g. SHOW TITLE';
  }
}
$('fromType').onchange = $('toType').onchange = updateSkipForm;

function resolveSection(from, to, incl) {
  const L = state.lines, n = L.length;
  const find = (q, start) => {
    q = q.toLowerCase();
    for (let i = start; i < n; i++) if (L[i].s.toLowerCase().includes(q)) return i;
    return -1;
  };
  let a = 0, b = n - 1;
  if (from.type === 'time') {
    a = L.findIndex(l => l.t != null && l.t >= from.v);
    if (a < 0) throw new Error('No subtitle at or after that start time.');
  } else if (from.type === 'text') {
    a = find(from.v, 0);
    if (a < 0) throw new Error(`No line contains “${from.v}”.`);
    if (!incl) a++;
  }
  if (to.type === 'time') {
    b = L.findLastIndex(l => l.t != null && l.t <= to.v);
  } else if (to.type === 'text') {
    const j = find(to.v, a);
    if (j < 0) throw new Error(`No line contains “${to.v}”${from.type === 'start' ? '' : ' after the start of the section'}.`);
    b = incl ? j : j - 1;
  }
  if (b < a) throw new Error('That section contains no lines.');
  return [a, b];
}

function describe(side, end) {
  if (side.type === 'time') return fmtTime(side.v);
  if (side.type === 'text') return `“${side.v}”`;
  return end ? 'end' : 'start';
}

$('addSkip').onclick = () => {
  const side = (t, v) => {
    const type = $(t).value, raw = $(v).value.trim();
    if (type === 'time') {
      const sec = parseTime(raw);
      if (sec == null) throw new Error('Enter a time like 2:20 or 1:02:03.');
      return { type, v: sec };
    }
    if (type === 'text') {
      if (!raw) throw new Error('Enter the sentence text to match.');
      return { type, v: raw };
    }
    return { type };
  };
  try {
    const from = side('fromType', 'fromVal'), to = side('toType', 'toVal');
    const [a, b] = resolveSection(from, to, $('incl').checked);
    state.sections.push({ a, b, label: `${describe(from)} → ${describe(to, true)}` });
    state.expanded.delete(a);
    $('skipError').textContent = '';
    $('fromVal').value = $('toVal').value = '';
    renderPreview();
  } catch (e) {
    $('skipError').textContent = e.message;
  }
};
['fromVal', 'toVal'].forEach(id => $(id).onkeydown = e => { if (e.key === 'Enter') $('addSkip').click(); });

function renderStats() {
  const mask = skipMask();
  let words = 0, keptWords = 0, keptLines = 0;
  state.lines.forEach((l, i) => { words += l.w; if (!mask[i]) { keptWords += l.w; keptLines++; } });
  const last = state.lines.findLast(l => l.t != null);
  const cards = [
    ['Lines', state.lines.length, keptLines === state.lines.length ? '' : `${keptLines} after skips`],
    ['Words', words, keptWords === words ? '' : `${keptWords} after skips`],
    ['Skipped lines', state.lines.length - keptLines, plural(words - keptWords, 'word')],
    ['Duration', last ? fmtTime(last.t) : '–', ''],
  ];
  $('stats').replaceChildren(...cards.map(([label, value, sub]) => {
    const c = el('div', 'stat');
    c.append(el('div', 'text-xs text-slate-500', label), el('div', 'text-xl font-semibold tabular-nums', String(value)), el('div', 'h-4 text-xs text-slate-500', sub));
    return c;
  }));
  $('toWords').disabled = keptLines === 0;
  setStatus(2, keptLines === 0 ? 'Every line is skipped.' : '', 'error');
}

function renderSections() {
  $('sections').replaceChildren(...state.sections.map((s, i) => {
    const li = el('li', 'hatch flex items-center gap-2 rounded-full border border-slate-300 px-3 py-1 text-xs dark:border-slate-700');
    const rm = el('button', 'text-slate-500 hover:text-red-600', '✕');
    rm.title = 'Remove this skip';
    rm.onclick = () => { state.sections.splice(i, 1); renderPreview(); };
    li.append(el('span', '', `${s.label} · ${plural(s.b - s.a + 1, 'line')}`), rm);
    return li;
  }));
}

function lineRow(i, skipped) {
  const l = state.lines[i];
  const row = el('div', 'flex gap-3 px-3 py-1 ' + (skipped ? 'hatch text-slate-400 line-through decoration-slate-300 dark:text-slate-500' : ''));
  row.append(
    el('span', 'w-12 shrink-0 text-right text-xs tabular-nums text-slate-400', fmtTime(l.t) || String(i + 1)),
    el('span', '', l.s));
  return row;
}

function renderPreview() {
  renderSections();
  renderStats();
  const mask = skipMask(), frag = document.createDocumentFragment(), n = state.lines.length;
  for (let i = 0; i < n;) {
    if (!mask[i]) { frag.append(lineRow(i, false)); i++; continue; }
    let j = i;
    while (j + 1 < n && mask[j + 1]) j++;
    const open = state.expanded.has(i), start = i;
    const t0 = state.lines[i].t, t1 = state.lines[j].t;
    const head = el('button', 'hatch flex w-full items-center gap-2 border-y border-slate-200 px-3 py-1.5 text-left text-xs font-medium text-slate-500 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800');
    head.append(
      el('span', '', open ? '▾' : '▸'),
      el('span', '', `${plural(j - i + 1, 'line')} skipped` + (t0 != null ? ` · ${fmtTime(t0)} – ${fmtTime(t1)}` : '')),
      el('span', 'ml-auto font-normal', open ? 'Collapse' : 'Expand'));
    head.onclick = () => { open ? state.expanded.delete(start) : state.expanded.add(start); renderPreview(); };
    frag.append(head);
    if (open) for (let k = i; k <= j; k++) frag.append(lineRow(k, true));
    i = j + 1;
  }
  const box = $('preview'), scroll = box.scrollTop;
  box.replaceChildren(frag);
  box.scrollTop = scroll;
}

// ---------- step 3: words ----------
const REASONS = {
  stopword: 'Common function word',
  short: 'Too short',
  known: 'Already known',
  name: 'Looks like a proper name',
  freq: 'Below min frequency',
  limit: 'Over max candidates',
  jev_name: 'Jev: proper name',
  jev_useless: 'Jev: not useful',
  manual: 'Excluded manually',
};
const included = c => c.override ?? !c.reason;
const reasonCode = c => c.override === false ? 'manual' : c.reason;
const pct = x => Math.round(x * 100) + '%';

function reasonText(c) {
  const code = reasonCode(c);
  let text = REASONS[code] || code;
  if (code === 'jev_name') text += ` (${pct(c.scores.name)})`;
  if (code === 'jev_useless') text += ` (${pct(c.scores.useful)} useful)`;
  return text;
}

function setIncluded(c, on) {
  c.override = on === !c.reason ? null : on;
  renderCands();
}

function renderCands() {
  const keep = state.cands.filter(included);
  const skip = state.cands.filter(c => !included(c));
  $('keptCount').textContent = plural(keep.length, 'word');
  $('skipCount').textContent = plural(skip.length, 'word');

  const checkbox = (c, on) => {
    const cb = el('input', 'h-4 w-4 accent-indigo-600');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.onchange = () => setIncluded(c, cb.checked);
    return cb;
  };
  const cell = (cls, content) => {
    const td = el('td', cls);
    if (content instanceof Node) td.append(content); else td.textContent = content;
    return td;
  };

  const keptFrag = document.createDocumentFragment();
  for (const c of keep) {
    const tr = el('tr', 'align-top hover:bg-slate-50 dark:hover:bg-slate-800/50');
    const jev = c.scores ? `${pct(c.scores.useful)} useful · ${pct(c.scores.name)} name` : '–';
    tr.append(
      cell('px-2 py-1.5', checkbox(c, true)), cell('px-2 py-1.5 font-medium', c.word),
      cell('px-2 py-1.5 text-right tabular-nums text-slate-500', String(c.count)),
      cell('whitespace-nowrap px-2 py-1.5 text-xs text-slate-500', jev),
      cell('px-2 py-1.5 text-xs text-slate-500', c.example));
    keptFrag.append(tr);
  }
  $('keptRows').replaceChildren(keptFrag);

  const codes = [...new Set(skip.map(reasonCode))];
  const sel = $('reasonFilter'), cur = sel.value;
  sel.replaceChildren(new Option('All reasons', ''), ...codes.map(code => new Option(REASONS[code] || code, code)));
  sel.value = codes.includes(cur) ? cur : '';

  const q = $('skipSearch').value.trim().toLowerCase();
  const skipFrag = document.createDocumentFragment();
  for (const c of skip) {
    if (sel.value && reasonCode(c) !== sel.value) continue;
    if (q && !c.word.includes(q)) continue;
    const tr = el('tr', 'align-top text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50');
    tr.append(
      cell('px-2 py-1.5', checkbox(c, false)), cell('px-2 py-1.5 font-medium', c.word),
      cell('px-2 py-1.5 text-right tabular-nums', String(c.count)),
      cell('whitespace-nowrap px-2 py-1.5 text-xs', reasonText(c)),
      cell('hidden px-2 py-1.5 text-xs md:table-cell', c.example));
    skipFrag.append(tr);
  }
  $('skipRows').replaceChildren(skipFrag);
  $('toTranslate').disabled = keep.length === 0;
}
$('reasonFilter').onchange = $('skipSearch').oninput = renderCands;

async function loadCandidates() {
  const keptLines = state.lines.filter((_, i) => !skipMask()[i]).map(l => l.s);
  setStatus(3, 'Analysing words — this can take a moment…');
  const data = await findCandidates(keptLines, {
    limit: num('limit', 150), minLen: num('minLen', 4), minFreq: num('minFreq', 1),
    minUseful: num('minUseful', 0.5), engine: $('engine').value,
    jev: $('jev').checked, useKnown: $('useKnown').checked,
  });
  state.cands = data.words.map(w => ({ ...w, override: null }));
  state.engine = data.engine;
  const warn = [];
  if (data.jevError) warn.push('Jev warning: ' + data.jevError);
  if (data.llmMissing) warn.push('Not connected to OpenRouter, so plain word forms were used. Connect in Settings to get root words.');
  const kept = state.cands.filter(c => !c.reason).length;
  setStatus(3, [`${keptLines.length} lines · ${state.cands.length} distinct words · ${kept} to translate · engine: ${data.engine}`, ...warn].join('\n'), warn.length ? 'info' : 'ok');
  renderCands();
}

$('toWords').onclick = () => busy($('toWords'), 'Working…', async () => {
  const key = JSON.stringify(state.sections.map(s => [s.a, s.b]));
  if (key !== state.candKey || !state.cands.length) {
    go(3);
    try { await loadCandidates(); state.candKey = key; state.wordKey = ''; }
    catch (e) { setStatus(3, 'Error: ' + e.message, 'error'); }
  } else go(3);
});

$('rerun').onclick = () => busy($('rerun'), 'Working…', async () => {
  try { await loadCandidates(); state.wordKey = ''; }
  catch (e) { setStatus(3, 'Error: ' + e.message, 'error'); }
});

// ---------- step 4: translations ----------
$('toTranslate').onclick = () => busy($('toTranslate'), 'Translating…', async () => {
  const chosen = state.cands.filter(included);
  const key = state.engine + '|' + chosen.map(c => c.word).join(',');
  if (key === state.wordKey && state.words.length) { go(4); return; }
  go(4);
  setStatus(4, 'Translating — this can take a moment…');
  try {
    const data = await translateWords(chosen, state.engine, $('useKnown').checked);
    state.words = data.words.map(w => ({ ...w, keep: !w.note }));
    state.wordKey = key;
    state.generated = false;
    $('outCard').hidden = true;
    $('search').value = '';
    const warn = [];
    if (data.translateError) warn.push('Translation warning: ' + data.translateError);
    const dropped = state.words.filter(w => w.note).length;
    const info = [plural(state.words.length - dropped, 'word')];
    if (dropped) info.push(`${dropped} removed after lemmatizing (shown unticked)`);
    if (data.translator) info.push(`translated by ${data.translator}`);
    setStatus(4, info.join(' · ') + (warn.length ? '\n' + warn.join(' ') : ''), warn.length ? 'info' : 'ok');
    renderWords();
  } catch (e) {
    setStatus(4, 'Error: ' + e.message, 'error');
  }
});

function renderWords() {
  const frag = document.createDocumentFragment();
  state.words.forEach(w => {
    const tr = el('tr', 'align-top hover:bg-slate-50 dark:hover:bg-slate-800/50' + (w.keep ? '' : ' opacity-50'));
    const td = (cls, ...nodes) => { const c = el('td', cls); c.append(...nodes); return c; };
    const cb = el('input', 'block h-4 w-4 accent-indigo-600');
    cb.type = 'checkbox';
    cb.checked = w.keep;
    cb.onchange = () => { w.keep = cb.checked; tr.classList.toggle('opacity-50', !w.keep); build(); };
    const src = el('input', 'field min-w-24 font-medium');
    src.size = 1;
    src.value = w.word;
    src.oninput = () => { w.word = src.value; build(); };
    if (w.forms) src.title = w.forms.join(', ');
    const tr_ = el('input', 'field min-w-24');
    tr_.size = 1;
    tr_.value = w.translation || '';
    tr_.oninput = () => { w.translation = tr_.value; build(); };
    const trCell = td('px-2 py-1.5', tr_);
    if (w.note) trCell.append(el('div', 'mt-1 text-xs text-amber-600 dark:text-amber-400', w.note));
    tr.append(
      td('px-2 pt-[15px] pb-1.5', cb), td('px-2 py-1.5', src), trCell,
      td('pr-4 pl-2 pt-[13px] pb-1.5 md:pr-2 text-right tabular-nums text-slate-500', String(w.count)),
      td('hidden px-2 pt-[15px] pb-1.5 text-xs text-slate-500 md:table-cell', w.example || ''));
    w.el = tr; w.cb = cb;
    frag.append(tr);
  });
  $('rows').replaceChildren(frag);
  applyFilter();
  build();
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  state.words.forEach(w => { w.el.hidden = q && !(w.word + ' ' + (w.translation || '')).toLowerCase().includes(q); });
}
$('search').oninput = applyFilter;

function setAll(v) {
  state.words.forEach(w => { if (!w.el.hidden) { w.keep = v; w.cb.checked = v; w.el.classList.toggle('opacity-50', !v); } });
  build();
}
$('selAll').onclick = () => setAll(true);
$('selNone').onclick = () => setAll(false);

function build() {
  const kept = state.words.filter(w => w.keep);
  $('count').textContent = `${kept.length} / ${state.words.length} selected`;
  if (!state.generated) return;
  const ex = $('example').checked;
  $('out').value = kept.map(w => {
    let s = `${w.word} :: ${w.translation || ''}`;
    if (ex && w.example) s += `\n    ${w.example}`;
    return s;
  }).join('\n');
}
$('example').onchange = build;

$('generate').onclick = () => {
  state.generated = true;
  $('outCard').hidden = false;
  build();
  $('outCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('out').value);
  toast('Copied to clipboard');
};
$('known').onclick = async () => {
  const words = state.words.filter(w => w.keep).map(w => w.word);
  if (!words.length || !confirm(`Hide ${words.length === 1 ? 'this word' : `these ${words.length} words`} in future extractions?`)) return;
  toast(`Marked ${plural(addKnown(words), 'new word')} as known`);
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('dl').onclick = () => download('basque-words.md', $('out').value, 'text/markdown');

// ---------- settings: OpenRouter key & data ----------
function refreshSettings() {
  const key = getKey();
  $('keyDot').className = 'h-2 w-2 rounded-full ' + (key ? 'bg-emerald-500' : 'bg-amber-500');
  $('openSettings').title = key ? 'Connected to OpenRouter' : 'Not connected to OpenRouter';
  $('connectBanner').hidden = Boolean(key);
  $('keyStatus').textContent = key
    ? `Connected. Key ${key.slice(0, 8)}…${key.slice(-4)} is saved in this browser.`
    : 'Not connected. Without a key, the app uses plain word forms and MyMemory translations.';
  $('disconnect').disabled = !key;
  $('connect').textContent = key ? 'Reconnect with OpenRouter' : 'Connect with OpenRouter';
  $('model').placeholder = DEFAULT_MODEL;
  $('model').value = getModel() === DEFAULT_MODEL ? '' : getModel();
  $('dataStatus').textContent = `${plural(known.size, 'known word')} · ${plural(cache.size, 'cached result')}`;
}

const connect = () => startOAuth().catch(e => toast('Error: ' + e.message));
$('connect').onclick = $('bannerConnect').onclick = connect;
$('disconnect').onclick = () => { setKey(''); refreshSettings(); toast('Disconnected from OpenRouter'); };
$('saveKey').onclick = () => {
  const key = $('keyInput').value.trim();
  if (!key) return;
  setKey(key);
  $('keyInput').value = '';
  refreshSettings();
  toast('API key saved');
};
$('keyInput').onkeydown = e => { if (e.key === 'Enter') $('saveKey').click(); };
$('model').onchange = () => setModel($('model').value);
$('openSettings').onclick = () => { refreshSettings(); $('settings').showModal(); };
$('settings').onclick = e => { if (e.target === $('settings')) $('settings').close(); }; // backdrop click

$('exportData').onclick = () => {
  const date = new Date().toISOString().slice(0, 10);
  download(`subtitle-flashcards-${date}.json`, JSON.stringify(exportData(), null, 1), 'application/json');
};
$('importData').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  try {
    const n = importData(await file.text());
    refreshSettings();
    toast(`Imported ${plural(n.known, 'known word')} and ${plural(n.cache, 'cached result')}`);
  } catch (e) { toast('Import failed: ' + e.message); }
};

// ---------- start ----------
go(1);
refreshSettings();
const persistent = await loadData();
if (!persistent) setStatus(1, "This browser isn't saving data (private mode?). Known words and translations won't be kept.", 'info');
refreshSettings();
try {
  if (await finishOAuth()) { refreshSettings(); toast('Connected to OpenRouter'); }
} catch (e) {
  setStatus(1, e.message, 'error');
}
