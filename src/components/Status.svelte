<script>
  /** @type {{ status: { msg: string, kind: 'info' | 'error' | 'ok' } | null | undefined }} */
  let { status } = $props();

  const KIND = { info: 'bg-lilac', error: 'bg-peach', ok: 'bg-mint' };
</script>

<div role="status" class={['text-sm whitespace-pre-line',
  status && ['rounded-xl border-2 border-ink px-3 py-2 font-medium text-on-accent', KIND[status.kind]]]}>{status?.msg ?? ''}</div>
