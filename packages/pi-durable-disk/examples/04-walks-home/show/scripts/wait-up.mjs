// Wait for a launched server to answer: poll `probe` until it is true, `exited` says the server is gone (no point waiting for a server that ended), or `timeoutMs` pass.
// A server started under with-typesafe, with-modal and with-archil takes 17-20 s before serve.ts even starts (each wrapper reads 1Password), so the bound is a time, not a try count.
export async function waitUp({ probe, exited, timeoutMs, pollMs = 200, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (exited()) return false;
    if (await probe()) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}
