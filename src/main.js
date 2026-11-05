import './style.css';
import { getLangs, langName, SOURCE_LANGS, setLangs, TARGET_LANGS } from './lib/languages.js';
import { DEFAULT_MODEL, finishOAuth, getKey, getModel, setKey, setModel, startOAuth } from './lib/openrouter.js';
import { decodeText, parseCues } from './lib/parse.js';
import { fetchSubtitles, findCandidates, translateWords } from './lib/pipeline.js';
import { addKnown, cache, deleteShow, exportData, importData, known, loadData, saveShow, settings, shows } from './lib/storage.js';

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
};

// Pastel tints that cycle through stat tiles and word cards.
const TINTS = ['bg-butter', 'bg-mint', 'bg-lilac', 'bg-peach'];

// ---------- helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('opacity-0', '-translate-y-4');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('opacity-0', '-translate-y-4'), 2000);
}

function setStatus(n, msg, kind = 'info') {
  const e = $('status' + n);
  e.textContent = msg;
  e.style.whiteSpace = 'pre-line';
  e.className = 'text-sm ' + (msg ? 'rounded-xl border-2 border-ink px-3 py-2 font-medium text-on-accent ' + ({
    info: 'bg-lilac',
    error: 'bg-peach',
    ok: 'bg-mint',
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
const STEPS = ['Source & Context', 'Preview', 'Words', 'Flashcards'];
function renderStepper() {
  const ol = $('stepper');
  ol.innerHTML = '';
  STEPS.forEach((name, i) => {
    const n = i + 1;
    const reachable = n <= state.maxStep, current = n === state.step;
    const b = el('button', 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition ' +
      (current ? 'bg-ink font-bold text-paper' : reachable ? 'font-medium hover:bg-sunken' : 'cursor-default text-muted'));
    b.disabled = !reachable;
    if (current) b.setAttribute('aria-current', 'step');
    b.append(el('span', 'font-mono text-xs', n < state.step ? '✓' : String(n)), el('span', current ? '' : 'hidden md:inline', name));
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

// ---------- step 1: source & context ----------
/** The language pair and show title + notes that steps 3 and 4 work with. */
function lesson() {
  const name = $('showName').value.trim(), notes = $('context').value.trim();
  const context = [name && `Title: ${name}`, notes].filter(Boolean).join('\n');
  return { source: $('sourceLang').value, target: $('targetLang').value, context };
}
const lessonSig = () => JSON.stringify(lesson());

function fillLangs() {
  const opts = codes => codes.map(c => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => new Option(n, c));
  const { source, target } = getLangs();
  $('sourceLang').replaceChildren(...opts(SOURCE_LANGS));
  $('targetLang').replaceChildren(...opts(TARGET_LANGS));
  $('sourceLang').value = source;
  $('targetLang').value = target;
  fitSlots();
}

/** Words and cards depend on the lesson, so editing it sends the learner back through "Find words". */
function lessonChanged() {
  state.candKey = state.wordKey = '';
  if (state.lines.length) state.maxStep = Math.min(state.maxStep, 2);
  renderStepper();
}
$('sourceLang').onchange = $('targetLang').onchange = () => {
  setLangs(lesson());
  fitSlots();
  $('langError').textContent = '';
  rememberShow();
  lessonChanged();
};

// Saved shows: picking one fills in its name, notes and languages; editing them saves it back.
// The "I'm watching [show]" slot opens a popover with the name field and the saved shows.
let currentShow = '';
const EMPTY_SLOT = ['border-dashed', 'bg-transparent', 'text-muted', 'shadow-none'];
const TRASH = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';

function renderShows(selected) {
  currentShow = shows.has(selected) ? selected : '';
  settings.set('show', currentShow);
  $('showSlotText').textContent = currentShow || 'something new';
  EMPTY_SLOT.forEach(c => $('showSlot').classList.toggle(c, !currentShow));
  renderShowList();
}

/** The saved shows in the popover, newest first. `confirming` swaps that row for a delete confirmation. */
function renderShowList(confirming = null) {
  const list = [...shows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  $('showListLabel').hidden = !list.length;
  $('showList').replaceChildren(...list.map(sh => {
    const li = el('li', 'menu-row' + (sh.name === confirming ? ' confirm' : sh.name === currentShow ? ' on' : ''));
    if (sh.name === confirming) {
      const yes = el('button', 'menu-mini bg-tomato', 'Delete'), no = el('button', 'menu-mini', 'Keep');
      yes.type = no.type = 'button';
      yes.onclick = () => {
        deleteShow(sh.name);
        if (sh.name === currentShow) pickShow(''); else renderShowList();
        $('showName').focus();
        toast(`Deleted “${sh.name}”`);
      };
      no.onclick = () => { renderShowList(); $('showName').focus(); };
      li.append(el('span', 'min-w-0 flex-1 text-sm font-bold', `Delete “${sh.name}”?`), yes, no);
      requestAnimationFrame(() => no.focus());
      return li;
    }
    const pick = el('button', 'menu-pick');
    pick.type = 'button';
    pick.append(el('span', 'min-w-0 flex-1 truncate font-bold', sh.name), el('span', 'pill', `${sh.source} → ${sh.target}`.toUpperCase()));
    pick.onclick = () => { pickShow(sh.name); closeShowMenu(true); };
    const del = el('button', 'menu-del');
    del.type = 'button';
    del.innerHTML = TRASH;
    del.setAttribute('aria-label', `Delete ${sh.name}`);
    del.onclick = () => renderShowList(sh.name);
    li.append(pick, del);
    return li;
  }));
}

/** Place the popover under the slot, kept inside the row so it never runs off a narrow screen. */
function placeShowMenu() {
  const menu = $('showMenu'), slot = $('showSlot'), row = $('showRow');
  menu.style.top = slot.offsetTop + slot.offsetHeight + 8 + 'px';
  menu.style.left = Math.max(0, Math.min(slot.offsetLeft, row.clientWidth - menu.offsetWidth)) + 'px';
}
function openShowMenu() {
  $('showMenu').hidden = false;
  $('showSlot').setAttribute('aria-expanded', 'true');
  renderShowList();
  placeShowMenu();
  if (matchMedia('(pointer: fine)').matches) $('showName').select(); // skip the on-screen keyboard on touch
}
function closeShowMenu(refocus = false) {
  if ($('showMenu').hidden) return;
  $('showMenu').hidden = true;
  $('showSlot').setAttribute('aria-expanded', 'false');
  if (refocus) $('showSlot').focus();
}
$('showSlot').onclick = () => $('showMenu').hidden ? openShowMenu() : closeShowMenu();
document.addEventListener('pointerdown', e => {
  if (!$('showMenu').hidden && !$('showMenu').contains(e.target) && !$('showSlot').contains(e.target)) closeShowMenu();
});
$('showMenu').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeShowMenu(true); } });
$('showName').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('showName').blur(); // fires change, which saves the name
  closeShowMenu(true);
});
$('newShow').onclick = () => { pickShow(''); $('showName').focus(); };
window.addEventListener('resize', () => { if (!$('showMenu').hidden) placeShowMenu(); });

function pickShow(name) {
  const show = shows.get(name);
  $('showName').value = show?.name || '';
  $('context').value = show?.context || '';
  if (show) {
    if (SOURCE_LANGS.includes(show.source)) $('sourceLang').value = show.source;
    if (TARGET_LANGS.includes(show.target)) $('targetLang').value = show.target;
    setLangs(lesson());
    fitSlots();
  }
  fitContext();
  renderShows(name);
  lessonChanged();
}

/** Save the name, notes and languages as a show. Editing the name of the selected show renames it. */
function rememberShow() {
  const name = $('showName').value.trim(), current = currentShow;
  if (!name) { if (current) renderShows(''); return; }
  if (current && current !== name && !shows.has(name)) deleteShow(current);
  const { source, target } = lesson();
  saveShow({ name, context: $('context').value.trim(), source, target });
  renderShows(name);
}
$('showName').onchange = $('context').onchange = () => { rememberShow(); lessonChanged(); };

/** Grow the notes box with its text; rows="3" keeps it at least three lines tall. */
function fitContext() {
  const ta = $('context');
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
}
$('context').oninput = fitContext;

/** Size each language select to its chosen name (selects otherwise take the width of their longest option). */
const measure = document.createElement('canvas').getContext('2d');
function fitSlots() {
  for (const sel of [$('sourceLang'), $('targetLang')]) {
    const cs = getComputedStyle(sel);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    measure.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const text = measure.measureText(sel.selectedOptions[0]?.text || '').width;
    const box = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, p) => sum + parseFloat(cs[p]), 0);
    sel.style.width = Math.ceil(text + box + 1) + 'px';
  }
}
window.addEventListener('resize', () => { fitContext(); fitSlots(); }); // font size changes at the sm breakpoint
document.fonts.ready.then(fitSlots); // re-measure once the web font replaces the fallback

let mode = 'url';
const ACTIVE = ['bg-ink', 'text-paper'];
function setMode(m) {
  mode = m;
  $('paneUrl').hidden = m !== 'url';
  $('paneFile').hidden = m !== 'file';
  for (const [id, on] of [['tabUrl', m === 'url'], ['tabFile', m === 'file']]) {
    ACTIVE.forEach(c => $(id).classList.toggle(c, on));
    $(id).setAttribute('aria-selected', String(on));
  }
}
$('tabUrl').onclick = () => setMode('url');
$('tabFile').onclick = () => setMode('file');
setMode('url');

function setFile(f) { $('fileName').textContent = f ? f.name : 'Drop a file or click to browse'; }
$('file').onchange = () => setFile($('file').files[0]);
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('bg-butter/40'); };
$('drop').ondragleave = () => $('drop').classList.remove('bg-butter/40');
$('drop').ondrop = e => {
  e.preventDefault();
  $('drop').classList.remove('bg-butter/40');
  if (e.dataTransfer.files.length) { $('file').files = e.dataTransfer.files; setFile(e.dataTransfer.files[0]); }
};

$('load').onclick = () => busy($('load'), 'Loading…', async () => {
  const file = mode === 'file' ? $('file').files[0] : null;
  const url = mode === 'url' ? $('url').value.trim() : '';
  const { source, target } = lesson();
  if (source === target) { $('langError').textContent = 'Pick a different language for your cards than the subtitles.'; return; }
  if (!file && !url) { setStatus(1, mode === 'file' ? 'Choose a subtitle file first.' : 'Enter a subtitle URL first.', 'error'); return; }
  rememberShow();
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
  $('stats').replaceChildren(...cards.map(([label, value, sub], i) => {
    const c = el('div', 'stat ' + TINTS[i]);
    c.append(el('div', 'font-mono text-[11px] uppercase tracking-wider opacity-75', label), el('div', 'text-3xl font-extrabold tabular-nums tracking-tight', String(value)), el('div', 'h-4 text-xs font-medium opacity-75', sub));
    return c;
  }));
  $('toWords').disabled = keptLines === 0;
  setStatus(2, keptLines === 0 ? 'Every line is skipped.' : '', 'error');
}

function renderSections() {
  $('sections').replaceChildren(...state.sections.map((s, i) => {
    const li = el('li', 'hatch flex items-center gap-2 rounded-full border-2 border-ink bg-surface py-1 pr-1.5 pl-3 text-xs font-medium');
    const rm = el('button', 'grid h-6 w-6 place-content-center rounded-full hover:bg-tomato hover:text-on-accent', '✕');
    rm.title = 'Remove this skip';
    rm.onclick = () => { state.sections.splice(i, 1); renderPreview(); };
    li.append(el('span', '', `${s.label} · ${plural(s.b - s.a + 1, 'line')}`), rm);
    return li;
  }));
}

function lineRow(i, skipped) {
  const l = state.lines[i];
  const row = el('div', 'flex gap-4 px-4 py-1 ' + (skipped ? 'hatch text-muted line-through' : ''));
  row.append(
    el('span', 'w-14 shrink-0 pt-0.5 text-right font-mono text-xs text-muted', fmtTime(l.t) || String(i + 1)),
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
    const head = el('button', 'hatch my-1 flex w-full items-center gap-2 border-y-2 border-dashed border-ink px-4 py-2 text-left text-xs font-bold hover:bg-sunken');
    head.append(
      el('span', '', open ? '▾' : '▸'),
      el('span', '', `${plural(j - i + 1, 'line')} skipped` + (t0 != null ? ` · ${fmtTime(t0)} – ${fmtTime(t1)}` : '')),
      el('span', 'ml-auto font-medium text-muted', open ? 'Collapse' : 'Expand'));
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
const REASON_TINT = {
  stopword: 'bg-butter', short: 'bg-butter', freq: 'bg-butter', limit: 'bg-butter',
  known: 'bg-mint', name: 'bg-lilac', jev_name: 'bg-lilac', jev_useless: 'bg-peach', manual: 'bg-peach',
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
    const cb = el('input', 'chk');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.setAttribute('aria-label', (on ? 'Discard ' : 'Include ') + c.word);
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
    const tr = el('tr', 'align-top hover:bg-sunken');
    const jev = c.scores ? `${pct(c.scores.useful)} useful · ${pct(c.scores.name)} name` : '–';
    tr.append(
      cell('px-3 py-2', checkbox(c, true)), cell('px-2 py-2 text-base font-bold', c.word),
      cell('px-2 py-2.5 text-right font-mono text-xs text-muted', String(c.count)),
      cell('whitespace-nowrap px-2 py-2.5 font-mono text-xs text-muted', jev),
      cell('px-3 py-2.5 text-xs text-muted', c.example));
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
    const tr = el('tr', 'align-top hover:bg-sunken');
    const reason = el('span', `pill ${REASON_TINT[reasonCode(c)] || 'bg-butter'} whitespace-nowrap font-sans text-on-accent`, reasonText(c));
    tr.append(
      cell('px-3 py-2', checkbox(c, false)), cell('px-2 py-2 font-medium text-muted', c.word),
      cell('px-2 py-2.5 text-right font-mono text-xs text-muted', String(c.count)),
      cell('px-2 py-2', reason),
      cell('hidden px-3 py-2.5 text-xs text-muted md:table-cell', c.example));
    skipFrag.append(tr);
  }
  $('skipRows').replaceChildren(skipFrag);
  $('toTranslate').disabled = keep.length === 0;
}
$('reasonFilter').onchange = $('skipSearch').oninput = renderCands;

async function loadCandidates() {
  const keptLines = state.lines.filter((_, i) => !skipMask()[i]).map(l => l.s);
  setStatus(3, 'Analysing words — this can take a moment…');
  const data = await findCandidates(keptLines, lesson(), {
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
  const key = lessonSig() + JSON.stringify(state.sections.map(s => [s.a, s.b]));
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
  const key = lessonSig() + state.engine + '|' + chosen.map(c => c.word).join(',');
  if (key === state.wordKey && state.words.length) { go(4); return; }
  go(4);
  setStatus(4, 'Translating — this can take a moment…');
  try {
    const data = await translateWords(chosen, lesson(), state.engine, $('useKnown').checked);
    state.words = data.words.map(w => ({ ...w, keep: !w.note }));
    state.wordKey = key;
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

function setKeep(w, v) {
  w.keep = v;
  w.cb.checked = v;
  w.el.classList.toggle('off', !v);
}

function renderWords() {
  const frag = document.createDocumentFragment();
  const { source, target } = lesson();
  state.words.forEach((w, i) => {
    const card = el('div', 'wcard');
    const cb = el('input', 'chk');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', 'Keep this card');
    cb.onchange = () => { setKeep(w, cb.checked); build(); };
    // Clicking anywhere on the card that isn't a control toggles it.
    card.onclick = e => { if (!e.target.closest('input, button, a')) { setKeep(w, !w.keep); build(); } };

    const top = el('div', 'flex items-center gap-2');
    top.append(cb, el('span', `pill ml-auto ${TINTS[i % TINTS.length]} text-on-accent`, `×${w.count}`));

    const src = el('input', 'wcard-word');
    src.value = w.word;
    src.setAttribute('aria-label', `${langName(source)} word`);
    src.oninput = () => { w.word = src.value; build(); };
    if (w.forms) src.title = w.forms.join(', ');

    const tr = el('input', 'wcard-tr');
    tr.value = w.translation || '';
    tr.placeholder = 'Translation';
    tr.setAttribute('aria-label', `${langName(target)} translation`);
    tr.oninput = () => { w.translation = tr.value; build(); };

    card.append(top, src, tr);
    if (w.note) card.append(el('p', 'rounded-lg bg-butter px-2 py-1 text-xs font-medium text-on-accent', w.note));
    if (w.example) card.append(el('p', 'text-[13px] leading-snug text-muted', w.example));
    w.el = card; w.cb = cb;
    setKeep(w, w.keep);
    frag.append(card);
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
  state.words.forEach(w => { if (!w.el.hidden) setKeep(w, v); });
  build();
}
$('selAll').onclick = () => setAll(true);
$('selNone').onclick = () => setAll(false);

function build() {
  const kept = state.words.filter(w => w.keep);
  $('count').textContent = kept.length;
  $('countOf').textContent = `of ${plural(state.words.length, 'card')}`;
  for (const id of ['copy', 'dl', 'known']) $(id).disabled = !kept.length;
  const ex = $('example').checked;
  $('out').value = kept.map(w => {
    let s = `${w.word} :: ${w.translation || ''}`;
    if (ex && w.example) s += `\n    ${w.example}`;
    return s;
  }).join('\n');
}
$('example').onchange = build;

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
$('dl').onclick = () => {
  const { source, target } = lesson();
  download(`flashcards-${source}-${target}.md`, $('out').value, 'text/markdown');
};

// ---------- settings: OpenRouter key & data ----------
function refreshSettings() {
  const key = getKey();
  $('keyDot').className = 'absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-ink ' + (key ? 'bg-mint' : 'bg-tomato');
  $('openSettings').title = key ? 'Settings · connected to OpenRouter' : 'Settings · not connected to OpenRouter';
  $('connectBanner').hidden = Boolean(key);
  $('contextBox').hidden = !key;
  if (key) fitContext(); // the box can't measure its text while hidden
  $('keyStatus').textContent = key
    ? `Connected. Key ${key.slice(0, 8)}…${key.slice(-4)} is saved in this browser.`
    : 'Not connected. Without a key, the app uses plain word forms and MyMemory translations.';
  $('disconnect').disabled = !key;
  $('connect').textContent = key ? 'Reconnect with OpenRouter' : 'Connect with OpenRouter';
  $('model').placeholder = DEFAULT_MODEL;
  $('model').value = getModel() === DEFAULT_MODEL ? '' : getModel();
  $('dataStatus').textContent = `${plural(known.size, 'known word')} · ${plural(shows.size, 'saved show')} · ${plural(cache.size, 'cached result')}`;
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
    renderShows(currentShow);
    toast(`Imported ${plural(n.known, 'known word')}, ${plural(n.shows, 'show')} and ${plural(n.cache, 'cached result')}`);
  } catch (e) { toast('Import failed: ' + e.message); }
};

// ---------- start ----------
fillLangs();
go(1);
refreshSettings();
const persistent = await loadData();
if (!persistent) setStatus(1, "This browser isn't saving data (private mode?). Known words, shows and translations won't be kept.", 'info');
if (shows.has(settings.get('show'))) pickShow(settings.get('show'));
else renderShows('');
refreshSettings();
try {
  if (await finishOAuth()) { refreshSettings(); toast('Connected to OpenRouter'); }
} catch (e) {
  setStatus(1, e.message, 'error');
}
