<script>
  import { app, go } from '../app.svelte.js';

  let { onsettings } = $props();

  const STEPS = ['Source & Context', 'Preview', 'Words', 'Flashcards'];
</script>

<header class="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 pt-6 sm:px-6">
  <div class="flex items-center gap-3">
    <span aria-hidden="true" class="relative h-10 w-10 shrink-0">
      <span class="absolute inset-[4px_0_0_4px] rounded-[9px] border-2 border-ink bg-tomato"></span>
      <span class="absolute inset-[0_4px_4px_0] -rotate-8 rounded-[9px] border-2 border-ink bg-butter"></span>
    </span>
    <h1 class="text-xl leading-none font-extrabold tracking-[-0.03em] sm:text-[22px]">subtitle flashcards</h1>
  </div>
  <nav aria-label="Steps" class="order-3 w-full sm:order-2 sm:ml-auto sm:w-auto">
    <ol class="flex justify-between gap-1 rounded-full border-2 border-ink bg-surface p-1 sm:justify-start">
      {#each STEPS as name, i (name)}
        {@const n = i + 1}
        {@const current = n === app.step}
        {@const reachable = n <= app.maxStep}
        <li>
          <button type="button" disabled={!reachable} aria-current={current ? 'step' : undefined} onclick={() => go(n)}
            class={['flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition',
              current ? 'bg-ink font-bold text-paper' : reachable ? 'font-medium hover:bg-sunken' : 'cursor-default text-muted']}>
            <span class="font-mono text-xs">{n < app.step ? '✓' : n}</span>
            <span class={current ? '' : 'hidden md:inline'}>{name}</span>
          </button>
        </li>
      {/each}
    </ol>
  </nav>
  <button type="button" onclick={onsettings} aria-label="Settings"
    title={app.key ? 'Settings · connected to OpenRouter' : 'Settings · not connected to OpenRouter'}
    class="relative order-2 ml-auto grid h-11 w-11 place-content-center rounded-full border-2 border-ink bg-surface shadow-hard-sm transition hover:-translate-x-px hover:-translate-y-px hover:shadow-hard sm:order-3 sm:ml-0">
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
    <span class={['absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-ink', app.key ? 'bg-mint' : 'bg-tomato']}></span>
  </button>
</header>
