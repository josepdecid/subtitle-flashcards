<script>
  // Step 1: languages, the show, and where the subtitles come from.
  import { onMount } from 'svelte';
  import { langName, setLangs, SOURCE_LANGS, TARGET_LANGS } from '../lib/languages.js';
  import { decodeText, parseCues } from '../lib/parse.js';
  import { fetchSubtitles } from '../lib/pipeline.js';
  import { app, connect, go, lesson, lessonChanged, loadLines, rememberShow, setStatus } from '../app.svelte.js';
  import ShowPicker from './ShowPicker.svelte';
  import Status from './Status.svelte';

  const options = codes => codes.map(c => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1]));
  const sourceOpts = options(SOURCE_LANGS), targetOpts = options(TARGET_LANGS);

  let sourceSel = $state(), targetSel = $state(), contextEl = $state();
  let langError = $state('');
  let mode = $state('url');
  let url = $state('');
  let files = $state();
  let dragging = $state(false);
  let loading = $state(false);

  function setLang(side, value) {
    app[side] = value;
    setLangs(lesson());
    langError = '';
    rememberShow();
    lessonChanged();
  }

  /** Size each language select to its chosen name (selects otherwise take the width of their longest option). */
  const measure = document.createElement('canvas').getContext('2d');
  function fitSlots() {
    for (const [sel, code] of [[sourceSel, app.source], [targetSel, app.target]]) {
      const cs = getComputedStyle(sel);
      measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      measure.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      const text = measure.measureText(langName(code)).width;
      const box = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, p) => sum + parseFloat(cs[p]), 0);
      sel.style.width = Math.ceil(text + box + 1) + 'px';
    }
  }
  $effect(fitSlots);
  onMount(() => { document.fonts.ready.then(fitSlots); }); // re-measure once the web font replaces the fallback

  /** Grow the notes box with its text; rows="3" keeps it at least three lines tall. */
  function fitContext() {
    const ta = contextEl;
    if (!ta?.offsetParent) return; // can't measure while hidden
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
  }
  $effect(() => {
    app.notes; app.step; // refit when a show fills the notes and when the box becomes visible
    fitContext();
  });

  function drop(e) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer.files.length) files = e.dataTransfer.files;
  }

  async function load() {
    const file = mode === 'file' ? files?.[0] : null;
    const src = mode === 'url' ? url.trim() : '';
    if (app.source === app.target) { langError = 'Pick a different language for your cards than the subtitles.'; return; }
    if (!file && !src) { setStatus(1, mode === 'file' ? 'Choose a subtitle file first.' : 'Enter a subtitle URL first.', 'error'); return; }
    loading = true;
    rememberShow();
    setStatus(1, 'Loading subtitles…');
    try {
      const cues = parseCues(file ? decodeText(await file.arrayBuffer()) : await fetchSubtitles(src));
      if (!cues.length) throw new Error('No dialogue lines found in that file.');
      loadLines(cues);
      setStatus(1, '');
      go(2);
    } catch (e) {
      setStatus(1, 'Error: ' + e.message, 'error');
    } finally {
      loading = false;
    }
  }
</script>

<svelte:window onresize={() => { fitContext(); fitSlots(); }} />

<section class="space-y-6" hidden={app.step !== 1}>
  <div>
    <h2 class="title">Set the <span class="hl">scene</span></h2>
    <div class="lead max-w-none">
      <p class="inline sm:block">Pick your languages, load a subtitle file and say a little about what you're watching.</p>
      <p class="inline sm:block">You'll end up with flashcards ready to paste into RemNote.</p>
    </div>
  </div>

  <div class="card divide-y-2 divide-dashed divide-line">
    <div class="space-y-4 p-5 sm:p-6">
      <fieldset class="text-lg leading-[2.2] font-bold tracking-tight sm:text-xl">
        <legend class="sr-only">Show and languages</legend>
        <ShowPicker />
        <p>
          The subtitles are in
          <select bind:this={sourceSel} aria-label="Subtitle language" class="slot" value={app.source} onchange={e => setLang('source', e.currentTarget.value)}>
            {#each sourceOpts as [code, name] (code)}<option value={code}>{name}</option>{/each}
          </select>
          and I want my cards translated into
          <select bind:this={targetSel} aria-label="Flashcard language" class="slot rotate-1 bg-mint" value={app.target} onchange={e => setLang('target', e.currentTarget.value)}>
            {#each targetOpts as [code, name] (code)}<option value={code}>{name}</option>{/each}
          </select>
        </p>
        {#if langError}<p class="text-sm font-bold text-tomato">{langError}</p>{/if}
      </fieldset>
      {#if app.key}
        <div>
          <label for="context" class="lbl">About the show or film <span class="normal-case tracking-normal">(optional)</span></label>
          <textarea id="context" bind:this={contextEl} bind:value={app.notes} onchange={() => { rememberShow(); lessonChanged(); }}
            rows="3" maxlength="1500" class="field resize-none overflow-hidden text-base leading-snug"
            placeholder="e.g. Season 2 of a crime drama set in a fishing town. Main characters: Ane, Mikel and Txomin; they work at the Itsasoa bar. Lots of police and boat vocabulary."></textarea>
          <p class="mt-2 text-xs text-muted">Character, place and brand names help skip proper nouns; the setting and theme help pick relevant words and the right sense of each.</p>
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border-2 border-ink bg-lilac px-4 py-3 text-on-accent">
          <span class="flex-1 basis-72 font-medium">Connect your OpenRouter account to get root words, accurate translations and use your show notes. Without it, the app uses plain word forms and MyMemory.</span>
          <button type="button" onclick={connect} class="btn-ghost border-on-accent bg-white text-on-accent hover:bg-white/80">Connect OpenRouter</button>
        </div>
      {/if}
    </div>

    <div class="space-y-4 p-5 sm:p-6">
      <div class="inline-flex rounded-full border-2 border-ink bg-surface p-1 text-sm" role="tablist">
        {#each [['url', 'From URL'], ['file', 'Upload file']] as [m, label] (m)}
          <button type="button" role="tab" aria-selected={mode === m} onclick={() => { mode = m; }}
            class={['rounded-full px-4 py-1.5 font-bold transition', mode === m && 'bg-ink text-paper']}>{label}</button>
        {/each}
      </div>

      <div hidden={mode !== 'url'}>
        <label for="url" class="lbl">Subtitle URL</label>
        <input type="text" id="url" bind:value={url} placeholder="https://…/subtitles.srt" class="field py-3 text-base">
      </div>

      <div hidden={mode !== 'file'}>
        <label for="file" ondragover={e => { e.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }} ondrop={drop}
          class={['flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink bg-sunken px-4 py-12 text-center transition hover:bg-butter/40', dragging && 'bg-butter/40']}>
          <svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>
          <span class="text-lg font-bold">{files?.[0]?.name || 'Drop a file or click to browse'}</span>
          <span class="font-mono text-xs text-muted">.srt · .vtt · .ass · .ssa · .txt</span>
        </label>
        <input type="file" id="file" bind:files class="hidden" accept=".srt,.vtt,.ass,.ssa,.txt">
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3 p-5 sm:p-6">
      <button type="button" class="btn-primary btn-lg" disabled={loading} onclick={load}>{loading ? 'Loading…' : 'Load subtitles →'}</button>
      <Status status={app.status[1]} />
    </div>
  </div>
</section>
