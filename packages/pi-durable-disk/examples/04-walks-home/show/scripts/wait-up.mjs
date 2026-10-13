// Wait for a launched server to answer: poll `probe` until it is true, `exited` says the server is gone (no point waiting for a server that ended), or `timeoutMs` pass.
// A server started under with-typesafe, with-modal and with-archil takes 17-20 s before serve.ts even starts (each wrapper reads 1Password), so the bound is a time, not a try count.
// The bound holds for the probe and the sleep too: no probe starts once the time is up, `probe` is told how long it may take (its request must not outlast the bound), and a sleep never passes it.
export async function waitUp({ probe, exited, timeoutMs, pollMs = 200, probeMs = 2000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (exited()) return false;
    const left = deadline - now();
    if (left <= 0) return false;
    if (await probe(Math.min(probeMs, left))) return true;
    const rest = deadline - now();
    if (rest <= 0) return false;
    await sleep(Math.min(pollMs, rest));
  }
}
