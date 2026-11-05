<script>
  // Step 2: subtitle stats, skipped sections and the line-by-line preview.
  import { fmtTime, parseTime, plural } from '../lib/format.js';
  import { app, findWords, go, skipMask, TINTS } from '../app.svelte.js';
  import Status from './Status.svelte';

  let fromType = $state('start'), toType = $state('end');
  let fromVal = $state(''), toVal = $state('');
  let incl = $state(true);
  let skipError = $state('');
  let working = $state(false);

  const mask = $derived(skipMask());
  const hasTimes = $derived(app.lines.some(l => l.t != null));

  const stats = $derived.by(() => {
    let words = 0, keptWords = 0, keptLines = 0;
    app.lines.forEach((l, i) => { words += l.w; if (!mask[i]) { keptWords += l.w; keptLines++; } });
    const last = app.lines.findLast(l => l.t != null);
    return {
      keptLines,
      tiles: [
        ['Lines', app.lines.length, keptLines === app.lines.length ? '' : `${keptLines} after skips`],
        ['Words', words, keptWords === words ? '' : `${keptWords} after skips`],
        ['Skipped lines', app.lines.length - keptLines, plural(words - keptWords, 'word')],
        ['Duration', last ? fmtTime(last.t) : '–', ''],
      ],
    };
  });

  /** Kept lines one by one ({i}), skipped runs folded into one block ({a, b}). */
  const blocks = $derived.by(() => {
    const out = [], n = app.lines.length;
    for (let i = 0; i < n;) {
      if (!mask[i]) { out.push({ i }); i++; continue; }
      let j = i;
      while (j + 1 < n && mask[j + 1]) j++;
      out.push({ a: i, b: j });
      i = j + 1;
    }
    return out;
  });

  // A new file starts with a clean skip form.
  $effect(() => { app.lines; skipError = ''; });

  function resolveSection(from, to) {
    const L = app.lines, n = L.length;
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

  function side(type, raw) {
    raw = raw.trim();
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
  }

  function addSkip() {
    try {
      const from = side(fromType, fromVal), to = side(toType, toVal);
      const [a, b] = resolveSection(from, to);
      app.sections.push({ a, b, label: `${describe(from)} → ${describe(to, true)}` });
      app.expanded.delete(a);
      skipError = '';
      fromVal = toVal = '';
    } catch (e) {
      skipError = e.message;
    }
  }

  const toggle = a => app.expanded.has(a) ? app.expanded.delete(a) : app.expanded.add(a);
  const onEnter = e => { if (e.key === 'Enter') addSkip(); };
  const placeholder = type => type === 'time' ? 'e.g. 2:20' : 'e.g. SHOW TITLE';

  async function next() {
    working = true;
    try { await findWords(); } finally { working = false; }
  }
</script>

{#snippet line(i, skipped)}
  <div class={['flex gap-4 px-4 py-1', skipped && 'hatch text-muted line-through']}>
    <span class="w-14 shrink-0 pt-0.5 text-right font-mono text-xs text-muted">{fmtTime(app.lines[i].t) || i + 1}</span>
    <span>{app.lines[i].s}</span>
  </div>
{/snippet}

<section class="space-y-6" hidden={app.step !== 2}>
  <div>
    <h2 class="title">Trim the <span class="hl">noise</span></h2>
    <p class="lead">Skip intros, recaps or credits so their words don't end up in your deck.</p>
  </div>

  <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
    {#each stats.tiles as [label, value, sub], i (label)}
      <div class={['stat', TINTS[i]]}>
        <div class="font-mono text-[11px] tracking-wider uppercase opacity-75">{label}</div>
        <div class="text-3xl font-extrabold tracking-tight tabular-nums">{value}</div>
        <div class="h-4 text-xs font-medium opacity-75">{sub}</div>
      </div>
    {/each}
  </div>

  <div class="card p-5">
    <h3 class="mb-3 text-lg font-extrabold tracking-tight">Skip a section</h3>
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <div class="flex items-end gap-1.5">
        <label class="block"><span class="lbl">From</span>
          <select bind:value={fromType} class="field w-28!">
            <option value="start">Start</option><option value="time" disabled={!hasTimes}>Time</option><option value="text">Sentence</option>
          </select></label>
        <input bind:value={fromVal} onkeydown={onEnter} class="field w-44!" aria-label="From value" placeholder={placeholder(fromType)} hidden={fromType === 'start'}>
      </div>
      <div class="flex items-end gap-1.5">
        <label class="block"><span class="lbl">To</span>
          <select bind:value={toType} class="field w-28!">
            <option value="end">End</option><option value="time" disabled={!hasTimes}>Time</option><option value="text">Sentence</option>
          </select></label>
        <input bind:value={toVal} onkeydown={onEnter} class="field w-44!" aria-label="To value" placeholder={placeholder(toType)} hidden={toType === 'end'}>
      </div>
      <label class="toggle pb-2" title="Also skip the line that matches a sentence boundary"><input type="checkbox" bind:checked={incl}><span>Include boundary lines</span></label>
      <button type="button" class="btn-ghost" onclick={addSkip}>+ Add skip</button>
    </div>
    <p class="mt-3 text-xs text-muted">Time as <code class="font-mono">2:20</code> or <code class="font-mono">1:02:03</code>. A sentence matches the first line containing the text (case-insensitive).</p>
    <p class="mt-1 text-sm font-bold text-tomato">{skipError}</p>
    <ul class="mt-3 flex flex-wrap gap-2">
      {#each app.sections as s, i (s)}
        <li class="hatch flex items-center gap-2 rounded-full border-2 border-ink bg-surface py-1 pr-1.5 pl-3 text-xs font-medium">
          <span>{s.label} · {plural(s.b - s.a + 1, 'line')}</span>
          <button type="button" class="grid h-6 w-6 place-content-center rounded-full hover:bg-tomato hover:text-on-accent" title="Remove this skip"
            onclick={() => app.sections.splice(i, 1)}>✕</button>
        </li>
      {/each}
    </ul>
  </div>

  <div class="tbox max-h-[520px] py-2 text-sm">
    {#each blocks as blk (blk.i ?? `${blk.a}-${blk.b}`)}
      {#if blk.i !== undefined}
        {@render line(blk.i, false)}
      {:else}
        {@const open = app.expanded.has(blk.a)}
        {@const t0 = app.lines[blk.a].t}
        <button type="button" onclick={() => toggle(blk.a)}
          class="hatch my-1 flex w-full items-center gap-2 border-y-2 border-dashed border-ink px-4 py-2 text-left text-xs font-bold hover:bg-sunken">
          <span>{open ? '▾' : '▸'}</span>
          <span>{plural(blk.b - blk.a + 1, 'line')} skipped{t0 != null ? ` · ${fmtTime(t0)} – ${fmtTime(app.lines[blk.b].t)}` : ''}</span>
          <span class="ml-auto font-medium text-muted">{open ? 'Collapse' : 'Expand'}</span>
        </button>
        {#if open}
          {#each { length: blk.b - blk.a + 1 }, k (k)}{@render line(blk.a + k, true)}{/each}
        {/if}
      {/if}
    {/each}
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <button type="button" class="btn-ghost" onclick={() => go(1)}>← Back</button>
    <Status status={stats.keptLines === 0 ? { msg: 'Every line is skipped.', kind: 'error' } : null} />
    <button type="button" class="btn-primary btn-lg ml-auto" disabled={working || stats.keptLines === 0} onclick={next}>{working ? 'Working…' : 'Find words →'}</button>
  </div>
</section>
