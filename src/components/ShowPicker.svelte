<script>
  // The "I'm watching [show]" slot: opens a popover with the name field and the saved shows.
  // Picking one fills in its name, notes and languages; editing them saves it back.
  import { tick } from 'svelte';
  import { shows } from '../lib/storage.js';
  import { app, lessonChanged, pickShow, rememberShow, removeShow, toast } from '../app.svelte.js';

  let row = $state(), slot = $state(), menu = $state(), nameInput = $state();
  let open = $state(false);
  /** Name of the show whose row is swapped for a delete confirmation. */
  let confirming = $state(null);

  /** The saved shows, newest first. */
  const list = $derived.by(() => {
    app.rev;
    return [...shows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  });

  /** Place the popover under the slot, kept inside the row so it never runs off a narrow screen. */
  function place() {
    menu.style.top = slot.offsetTop + slot.offsetHeight + 8 + 'px';
    menu.style.left = Math.max(0, Math.min(slot.offsetLeft, row.clientWidth - menu.offsetWidth)) + 'px';
  }

  async function show() {
    open = true;
    confirming = null;
    await tick();
    place();
    if (matchMedia('(pointer: fine)').matches) nameInput.select(); // skip the on-screen keyboard on touch
  }

  function close(refocus = false) {
    if (!open) return;
    open = false;
    if (refocus) slot.focus();
  }

  function onNameKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    nameInput.blur(); // fires change, which saves the name
    close(true);
  }

  function confirmDelete(name) {
    removeShow(name);
    confirming = null;
    nameInput.focus();
    toast(`Deleted “${name}”`);
  }

  const autofocus = node => { node.focus(); };
</script>

<svelte:document onpointerdown={e => { if (open && !menu.contains(e.target) && !slot.contains(e.target)) close(); }} />
<svelte:window onresize={() => { if (open) place(); }} />

<div bind:this={row} class="relative">
  I'm watching
  <button type="button" bind:this={slot} onclick={() => open ? close() : show()}
    aria-haspopup="dialog" aria-expanded={open} aria-controls="showMenu"
    class={['slot inline-flex max-w-full items-center gap-1.5 bg-peach text-left', !app.show && 'border-dashed bg-transparent text-muted shadow-none']}>
    <span>{app.show || 'something new'}</span>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
  </button>
  <div id="showMenu" bind:this={menu} role="dialog" tabindex="-1" aria-label="Show or film" class="menu" hidden={!open}
    onkeydown={e => { if (e.key === 'Escape') { e.preventDefault(); close(true); } }}>
    <div class="px-2.5 pt-2 pb-1">
      <label for="showName" class="lbl">Name</label>
      <input id="showName" type="text" maxlength="120" autocomplete="off" placeholder="Aquí no hay quien viva" class="field py-2.5 text-base font-bold"
        bind:this={nameInput} bind:value={app.showName} onkeydown={onNameKey}
        onchange={() => { rememberShow(); lessonChanged(); }}>
    </div>
    {#if list.length}
      <div class="lbl px-2.5 pt-2">Or pick a saved show</div>
    {/if}
    <ul class="max-h-66 overflow-auto">
      {#each list as sh (sh.name)}
        {#if sh.name === confirming}
          <li class="menu-row confirm">
            <span class="min-w-0 flex-1 text-sm font-bold">Delete “{sh.name}”?</span>
            <button type="button" class="menu-mini bg-tomato" onclick={() => confirmDelete(sh.name)}>Delete</button>
            <button type="button" class="menu-mini" {@attach autofocus} onclick={() => { confirming = null; nameInput.focus(); }}>Keep</button>
          </li>
        {:else}
          <li class={['menu-row', sh.name === app.show && 'on']}>
            <button type="button" class="menu-pick" onclick={() => { pickShow(sh.name); close(true); }}>
              <span class="min-w-0 flex-1 truncate font-bold">{sh.name}</span>
              <span class="pill">{`${sh.source} → ${sh.target}`.toUpperCase()}</span>
            </button>
            <button type="button" class="menu-del" aria-label="Delete {sh.name}" onclick={() => { confirming = sh.name; }}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
            </button>
          </li>
        {/if}
      {/each}
    </ul>
    <button type="button" class="menu-act" onclick={() => { pickShow(''); nameInput.focus(); }}>
      <span aria-hidden="true" class="grid h-5.5 w-5.5 place-content-center rounded-md border-2 border-current text-sm leading-none">+</span>
      Start a new show
    </button>
  </div>
</div>
