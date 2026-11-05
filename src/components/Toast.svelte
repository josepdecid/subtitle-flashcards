<script>
  import { app } from '../app.svelte.js';
</script>

<div role="status" class={['pointer-events-none fixed top-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border-2 border-ink bg-butter px-4 py-2 text-sm font-bold text-on-accent shadow-hard-sm transition',
  !app.toastOn && '-translate-y-4 opacity-0']}>{app.toast}</div>
