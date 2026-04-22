async function main(): Promise<void> {
  if (process.env.LARK_CHANNEL_SCOPE_ID) {
    const { startChild } = await import('./child/index.js');
    await startChild();
    return;
  }
  const { startMaster } = await import('./master/index.js');
  await startMaster();
}

main().catch((err) => {
  console.error('[lark-channel] fatal:', err);
  process.exit(1);
});
