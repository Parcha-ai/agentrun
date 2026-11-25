// The loopback ports the serve tests that import this hand out: one rule for a test that lists an address as down, or
// gives a process a port it binds later by name. No imports but node's, so a test with no built serve can import it.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

/** The first port of this host's ephemeral range: Linux's ip_local_port_range, read now, or 32768 where it can't be read
 *  (Linux's default start; macOS and Windows start at 49152, above it). */
export function ephemeralLow() {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768;
  } catch {
    return 32768;
  }
}

/** Every port this process has handed out, or is probing now. One is never handed out again: serve keeps each Ollama
 *  address's listing (ollama-provider.ts listOllama), a good one fresh for OLLAMA_TTL_MS and a refused one empty and
 *  stale, handed to the next call once more while it asks again. A test given an address an earlier one listed would
 *  read that listing first, not what listens there now. */
const handedOut = new Set();

/**
 * A port nothing listens on at `host` now, below the host's ephemeral range (from `low`, ephemeralLow() unless given). No
 * listen(0) and no outbound connection on this machine is handed such a port, so only a listener that names it can take
 * it: a test can list it as down, or give it to a process that binds it later. Picked from 1,000 below `low` or from
 * 20000, whichever is lower (never under 1024), up to `low` or 32768, whichever is lower; tried from a random place, each
 * candidate once. A port in use is passed over. Any other listen error rejects as itself. A range that leaves no
 * candidate, or none free, fails by name. A port is claimed before it is probed, so two calls at once never get the same
 * one. Test files run side by side (serve's suite runs 8 at once) each keep their own set, and a probe proves a port free
 * only when it runs: two files can be handed the same port, about 1 in the number of candidates (12,768 on Linux's
 * default range, from 32768) per pair of picks, one from each file.
 */
export async function freePort({ low = ephemeralLow(), host = "127.0.0.1" } = {}) {
  const to = Math.min(low, 32768);
  const from = Math.max(1024, Math.min(20000, to - 1000));
  if (to <= from) throw new Error(`no port below the ephemeral range: it starts at ${low}`);
  const span = to - from;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = from + ((start + i) % span);
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    let free = false;
    try {
      free = await bindable(port, host);
    } finally {
      if (!free) handedOut.delete(port);
    }
    if (free) return port;
  }
  throw new Error(`no free port below the ephemeral range: none in ${from}-${to - 1} (it starts at ${low})`);
}

/** Whether `port` binds on `host` now, the probe closed at once: false when it is in use, any other error rejected. */
function bindable(port, host) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}
