<script>
  import { onMount } from 'svelte';
  import { init } from './app.svelte.js';
  import Cards from './components/Cards.svelte';
  import Header from './components/Header.svelte';
  import Preview from './components/Preview.svelte';
  import Settings from './components/Settings.svelte';
  import Source from './components/Source.svelte';
  import Toast from './components/Toast.svelte';
  import Words from './components/Words.svelte';

  let settings = $state();
  onMount(init);
</script>

<Header onsettings={() => settings.open()} />

<!-- Every step stays mounted (only hidden), so form values and open panels survive going back and forth. -->
<main class="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6">
  <Source />
  <Preview />
  <Words />
  <Cards />
</main>

<Settings bind:this={settings} />
<Toast />
