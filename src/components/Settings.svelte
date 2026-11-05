<script>
  // Settings dialog: OpenRouter connection and model, plus export/import of the stored data.
  import { plural } from '../lib/format.js';
  import { DEFAULT_MODEL, getModel, setModel } from '../lib/openrouter.js';
  import { cache, exportData, importData, known, shows } from '../lib/storage.js';
  import { app, connect, download, saveKey, toast } from '../app.svelte.js';

  let dialog = $state(), importFile = $state();
  let keyInput = $state('');
  let model = $state('');

  const counts = $derived.by(() => {
    app.rev;
    return `${plural(known.size, 'known word')} · ${plural(shows.size, 'saved show')} · ${plural(cache.size, 'cached result')}`;
  });

  export function open() {
    model = getModel() === DEFAULT_MODEL ? '' : getModel();
    dialog.showModal();
  }

  function submitKey() {
    const key = keyInput.trim();
    if (!key) return;
    saveKey(key);
    keyInput = '';
    toast('API key saved');
  }

  function disconnect() {
    saveKey('');
    toast('Disconnected from OpenRouter');
  }

  function exportAll() {
    const date = new Date().toISOString().slice(0, 10);
    download(`subtitle-flashcards-${date}.json`, JSON.stringify(exportData(), null, 1), 'application/json');
  }

  async function importAll() {
    const file = importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      const n = importData(await file.text());
      app.rev++;
      toast(`Imported ${plural(n.known, 'known word')}, ${plural(n.shows, 'show')} and ${plural(n.cache, 'cached result')}`);
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} onclick={e => { if (e.target === dialog) dialog.close(); }}
  class="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-3xl border-2 border-ink bg-surface p-0 text-ink shadow-hard-lg backdrop:bg-black/50">
  <form method="dialog" class="flex items-center border-b-2 border-ink px-5 py-4">
    <h2 class="text-2xl font-extrabold tracking-tight">Settings</h2>
    <button class="ml-auto grid h-10 w-10 place-content-center rounded-full border-2 border-ink hover:bg-sunken" aria-label="Close">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </form>
  <div class="space-y-6 p-5 text-sm">
    <section class="space-y-3">
      <h3 class="text-lg font-extrabold">OpenRouter</h3>
      <p>{app.key
        ? `Connected. Key ${app.key.slice(0, 8)}…${app.key.slice(-4)} is saved in this browser.`
        : 'Not connected. Without a key, the app uses plain word forms and MyMemory translations.'}</p>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-primary" onclick={connect}>{app.key ? 'Reconnect with OpenRouter' : 'Connect with OpenRouter'}</button>
        <button type="button" class="btn-ghost" disabled={!app.key} onclick={disconnect}>Disconnect</button>
      </div>
      <details>
        <summary class="cursor-pointer text-sm font-medium text-muted">Or paste an API key</summary>
        <div class="mt-2 flex gap-2">
          <input type="password" bind:value={keyInput} onkeydown={e => { if (e.key === 'Enter') submitKey(); }}
            autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" aria-label="OpenRouter API key" class="field">
          <button type="button" class="btn-ghost" onclick={submitKey}>Save</button>
        </div>
      </details>
      <label class="block"><span class="lbl">Model</span>
        <input bind:value={model} onchange={() => setModel(model)} placeholder={DEFAULT_MODEL} class="field font-mono" spellcheck="false"></label>
      <p class="text-xs text-muted">Your key is saved in this browser and only sent to openrouter.ai. Requests use your own OpenRouter credits. Disconnecting removes the key from this browser; to revoke it, go to <a class="font-medium underline" href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a>.</p>
    </section>
    <section class="space-y-3 border-t-2 border-dashed border-line pt-5">
      <h3 class="text-lg font-extrabold">Your data</h3>
      <p class="font-mono text-xs text-muted">{counts}</p>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-ghost" onclick={exportAll}>Export</button>
        <button type="button" class="btn-ghost" onclick={() => importFile.click()}>Import…</button>
        <input type="file" bind:this={importFile} onchange={importAll} class="hidden" accept=".json,.txt,application/json,text/plain">
      </div>
      <p class="text-xs text-muted">Known words, saved shows and cached translations are stored in this browser. Import merges an export file, or a text file with one known word per line.</p>
    </section>
  </div>
</dialog>
