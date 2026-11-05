<script>
  // Step 4: translated word cards and the RemNote output.
  import { untrack } from 'svelte';
  import { plural } from '../lib/format.js';
  import { langName } from '../lib/languages.js';
  import { addKnown } from '../lib/storage.js';
  import { app, download, go, TINTS, toast } from '../app.svelte.js';
  import Status from './Status.svelte';

  let example = $state(true);

  /** Cards the search hides. Only the query (or a new set of cards) re-filters, so editing a card never hides it mid-typing. */
  const hidden = $derived.by(() => {
    const q = app.cardQuery.trim().toLowerCase(), words = app.words;
    return untrack(() => words.map(w => Boolean(q) && !`${w.word} ${w.translation || ''}`.toLowerCase().includes(q)));
  });

  const kept = $derived(app.words.filter(w => w.keep));
  const out = $derived(kept.map(w => {
    let s = `${w.word} :: ${w.translation || ''}`;
    if (example && w.example) s += `\n    ${w.example}`;
    return s;
  }).join('\n'));

  function setAll(v) {
    app.words.forEach((w, i) => { if (!hidden[i]) w.keep = v; });
  }

  /** Clicking anywhere on a card that isn't a control toggles it. */
  function cardClick(e, w) {
    if (!e.target.closest('input, button, a')) w.keep = !w.keep;
  }

  async function copy() {
    await navigator.clipboard.writeText(out);
    toast('Copied to clipboard');
  }

  function markKnown() {
    const words = kept.map(w => w.word);
    if (!words.length || !confirm(`Hide ${words.length === 1 ? 'this word' : `these ${words.length} words`} in future extractions?`)) return;
    const added = addKnown(words);
    app.rev++;
    toast(`Marked ${plural(added, 'new word')} as known`);
  }
</script>

<section class="space-y-6" hidden={app.step !== 4}>
  <div class="flex flex-wrap items-end gap-x-6 gap-y-4">
    <div class="flex-1 basis-96">
      <h2 class="title">Pick your <span class="hl">cards</span></h2>
      <p class="lead">Click a card to drop it. Fix any headword or translation right on the card.</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <label class="flex h-11 items-center gap-2 rounded-xl border-2 border-ink bg-surface px-3 focus-within:ring-4 focus-within:ring-tomato/40">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <span class="sr-only">Filter cards</span>
        <input type="search" bind:value={app.cardQuery} placeholder="Find a word" class="w-36 bg-transparent text-sm outline-none placeholder:text-muted">
      </label>
      <button type="button" class="btn-ghost h-11" onclick={() => setAll(true)}>All</button>
      <button type="button" class="btn-ghost h-11" onclick={() => setAll(false)}>None</button>
    </div>
  </div>

  <Status status={app.status[4]} />

  <div class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-[18px]">
    {#each app.words as w, i (w)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class={['wcard', !w.keep && 'off']} hidden={hidden[i]} onclick={e => cardClick(e, w)}>
        <div class="flex items-center gap-2">
          <input type="checkbox" class="chk" aria-label="Keep this card" bind:checked={w.keep}>
          <span class={['pill ml-auto text-on-accent', TINTS[i % TINTS.length]]}>×{w.count}</span>
        </div>
        <input class="wcard-word" bind:value={w.word} aria-label="{langName(app.source)} word" title={w.forms?.join(', ')}>
        <input class="wcard-tr" bind:value={w.translation} placeholder="Translation" aria-label="{langName(app.target)} translation">
        {#if w.note}<p class="rounded-lg bg-butter px-2 py-1 text-xs font-medium text-on-accent">{w.note}</p>{/if}
        {#if w.example}<p class="text-[13px] leading-snug text-muted">{w.example}</p>{/if}
      </div>
    {/each}
  </div>

  <details class="card shadow-hard-sm">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-5 py-3 font-bold [&::-webkit-details-marker]:hidden">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6 2 12l6 6M16 6l6 6-6 6"/></svg>
      Show RemNote text
    </summary>
    <div class="border-t-2 border-ink p-5">
      <textarea readonly rows="10" aria-label="RemNote text" value={out} class="w-full rounded-xl border-2 border-ink bg-sunken p-3 font-mono text-xs leading-relaxed focus:outline-none"></textarea>
      <p class="mt-2 text-sm text-muted">Paste into a RemNote document. Cards use <code class="rounded bg-sunken px-1 font-mono">word :: translation</code>; the example is a child bullet.</p>
    </div>
  </details>

  <div class="sticky bottom-4 z-20">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[20px] border-2 border-ink bg-ink p-3 pl-4 text-paper shadow-[0_8px_0_-3px_var(--color-tomato)]">
      <button type="button" class="btn-bar h-11" onclick={() => go(3)}>←<span class="sr-only">Back</span></button>
      <span class="text-xl font-extrabold">{kept.length} <span class="font-medium opacity-75">of {plural(app.words.length, 'card')}</span></span>
      <label class="flex cursor-pointer items-center gap-2 text-sm font-medium"><input type="checkbox" bind:checked={example} class="chk chk-inv">Include examples</label>
      <div class="flex flex-wrap gap-2 sm:ml-auto">
        <button type="button" class="btn-bar h-11" disabled={!kept.length} onclick={markKnown} title="Hide the selected words in future extractions">Mark as known</button>
        <button type="button" class="btn-bar h-11" disabled={!kept.length} onclick={() => download(`flashcards-${app.source}-${app.target}.md`, out, 'text/markdown')}>Download .md</button>
        <button type="button" class="btn-primary h-11 border-tomato px-5 text-base font-extrabold" disabled={!kept.length} onclick={copy}>Copy for RemNote</button>
      </div>
    </div>
  </div>
</section>
