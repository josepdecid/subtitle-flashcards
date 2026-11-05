<script>
  // Step 3: the words that will be translated and the ones that were filtered out.
  import { plural } from '../lib/format.js';
  import { app, go, included, rerunFilters, translate } from '../app.svelte.js';
  import Status from './Status.svelte';

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
  const reasonCode = c => c.override === false ? 'manual' : c.reason;
  const pct = x => Math.round(x * 100) + '%';

  function reasonText(c) {
    const code = reasonCode(c);
    let text = REASONS[code] || code;
    if (code === 'jev_name') text += ` (${pct(c.scores.name)})`;
    if (code === 'jev_useless') text += ` (${pct(c.scores.useful)} useful)`;
    return text;
  }

  /** Tick or untick a word; the override is dropped when it matches what the filters decided. */
  function setIncluded(c, on) {
    c.override = on === !c.reason ? null : on;
  }

  let reason = $state('');
  let query = $state('');
  let rerunning = $state(false), translating = $state(false);

  const keep = $derived(app.cands.filter(included));
  const skip = $derived(app.cands.filter(c => !included(c)));
  const codes = $derived([...new Set(skip.map(reasonCode))]);
  const reasonOn = $derived(codes.includes(reason) ? reason : '');
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return skip.filter(c => (!reasonOn || reasonCode(c) === reasonOn) && (!q || c.word.includes(q)));
  });

  async function busy(set, fn) {
    set(true);
    try { await fn(); } finally { set(false); }
  }
</script>

{#snippet checkbox(c, on)}
  <input type="checkbox" class="chk" checked={on} aria-label="{on ? 'Discard' : 'Include'} {c.word}" onchange={e => setIncluded(c, e.currentTarget.checked)}>
{/snippet}

<section class="space-y-6" hidden={app.step !== 3}>
  <div>
    <h2 class="title">Choose your <span class="hl">words</span></h2>
    <p class="lead">Untick a word to discard it. Anything that was filtered out is further down if you want it back.</p>
  </div>

  <details class="group card shadow-hard-sm">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-5 py-3 font-bold [&::-webkit-details-marker]:hidden">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>
      Filter options
      <span class="ml-auto transition group-open:rotate-180" aria-hidden="true">▾</span>
    </summary>
    <div class="grid gap-4 border-t-2 border-ink p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <label class="block"><span class="lbl">Max candidates</span><input type="number" bind:value={app.filters.limit} min="1" class="field"></label>
      <label class="block"><span class="lbl">Min length</span><input type="number" bind:value={app.filters.minLen} min="1" class="field"></label>
      <label class="block"><span class="lbl">Min frequency</span><input type="number" bind:value={app.filters.minFreq} min="1" class="field"></label>
      <label class="block"><span class="lbl">Min usefulness (0–1)</span><input type="number" bind:value={app.filters.minUseful} min="0" max="1" step="0.05" class="field"></label>
      <label class="block sm:col-span-2"><span class="lbl">Headword engine</span>
        <select bind:value={app.filters.engine} class="field">
          <option value="auto">Auto (LLM if connected, else plain word forms)</option>
          <option value="llm">LLM (root words)</option>
          <option value="regex">Plain word forms</option>
        </select></label>
      <div class="space-y-2 self-end pb-1">
        <label class="toggle"><input type="checkbox" bind:checked={app.filters.jev}><span>Filter with Jev</span></label>
        <label class="toggle"><input type="checkbox" bind:checked={app.filters.useKnown}><span>Hide known words</span></label>
      </div>
      <div class="self-end">
        <button type="button" class="btn-ghost w-full" disabled={rerunning} onclick={() => busy(v => { rerunning = v; }, rerunFilters)}>{rerunning ? 'Working…' : 'Re-run filters'}</button>
      </div>
    </div>
  </details>

  <Status status={app.status[3]} />

  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <h3 class="text-xl font-extrabold tracking-tight">To translate</h3>
      <span class="pill bg-mint text-on-accent">{plural(keep.length, 'word')}</span>
    </div>
    <div class="tbox max-h-[420px] shadow-hard">
      <table class="w-full text-sm">
        <thead class="thead"><tr><th class="w-12 px-3 py-2.5"><span class="sr-only">Keep</span></th><th class="px-2 py-2.5">Word</th><th class="px-2 py-2.5 text-right">#</th><th class="px-2 py-2.5">Jev</th><th class="px-3 py-2.5">Example</th></tr></thead>
        <tbody class="divide-y-2 divide-line">
          {#each keep as c (c.word)}
            <tr class="align-top hover:bg-sunken">
              <td class="px-3 py-2">{@render checkbox(c, true)}</td>
              <td class="px-2 py-2 text-base font-bold">{c.word}</td>
              <td class="px-2 py-2.5 text-right font-mono text-xs text-muted">{c.count}</td>
              <td class="px-2 py-2.5 font-mono text-xs whitespace-nowrap text-muted">{c.scores ? `${pct(c.scores.useful)} useful · ${pct(c.scores.name)} name` : '–'}</td>
              <td class="px-3 py-2.5 text-xs text-muted">{c.example}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>

  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <h3 class="text-xl font-extrabold tracking-tight">Skipped</h3>
      <span class="pill bg-surface">{plural(skip.length, 'word')}</span>
      <p class="text-sm text-muted">Tick a word to include it anyway.</p>
      <div class="flex w-full gap-2 sm:ml-auto sm:w-auto">
        <select class="field sm:w-52!" aria-label="Filter by reason" value={reasonOn} onchange={e => { reason = e.currentTarget.value; }}>
          <option value="">All reasons</option>
          {#each codes as code (code)}<option value={code}>{REASONS[code] || code}</option>{/each}
        </select>
        <input type="search" bind:value={query} placeholder="Filter…" aria-label="Filter skipped words" class="field sm:w-36!">
      </div>
    </div>
    <div class="tbox max-h-[420px]">
      <table class="w-full text-sm">
        <thead class="thead"><tr><th class="w-12 px-3 py-2.5"><span class="sr-only">Include</span></th><th class="px-2 py-2.5">Word</th><th class="px-2 py-2.5 text-right">#</th><th class="px-2 py-2.5">Reason</th><th class="hidden px-3 py-2.5 md:table-cell">Example</th></tr></thead>
        <tbody class="divide-y-2 divide-line">
          {#each shown as c (c.word)}
            <tr class="align-top hover:bg-sunken">
              <td class="px-3 py-2">{@render checkbox(c, false)}</td>
              <td class="px-2 py-2 font-medium text-muted">{c.word}</td>
              <td class="px-2 py-2.5 text-right font-mono text-xs text-muted">{c.count}</td>
              <td class="px-2 py-2"><span class={['pill font-sans whitespace-nowrap text-on-accent', REASON_TINT[reasonCode(c)] || 'bg-butter']}>{reasonText(c)}</span></td>
              <td class="hidden px-3 py-2.5 text-xs text-muted md:table-cell">{c.example}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <button type="button" class="btn-ghost" onclick={() => go(2)}>← Back</button>
    <button type="button" class="btn-primary btn-lg ml-auto" disabled={translating || keep.length === 0}
      onclick={() => busy(v => { translating = v; }, translate)}>{translating ? 'Translating…' : 'Translate →'}</button>
  </div>
</section>
