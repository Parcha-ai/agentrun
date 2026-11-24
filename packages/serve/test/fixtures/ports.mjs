// The loopback ports serve's tests hand out: one rule for every test that lists an address as down, or gives a process a
// port it binds later by name. No imports but node's, so fake-ollama.mjs (which a walk with no built serve takes) can
// import it.
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

/** Every port this process has handed out. One is never handed out again: serve keeps a down Ollama address's listing for
 *  its TTL, and a test given an address an earlier one listed as down would read that listing. */
const handedOut = new Set();

/**
 * A port nothing listens on at `host` now, below the host's ephemeral range (from `low`, ephemeralLow() unless given). No
 * listen(0) and no outbound connection on this machine is handed such a port, so only a listener that names it can take
 * it: a test can list it as down, or give it to a process that binds it later. Picked from 1,000 below `low` or from
 * 20000, whichever is lower (never under 1024), up to `low` or 32768, whichever is lower; tried from a random place, each
 * candidate once. A port in use is passed over. Any other listen error rejects as itself. A range that leaves no
 * candidate, or none free, fails by name.
 */
export async function freePort({ low = ephemeralLow(), host = "127.0.0.1" } = {}) {
  const to = Math.min(low, 32768);
  const from = Math.max(1024, Math.min(20000, to - 1000));
  if (to <= from) throw new Error(`no port below the ephemeral range: it starts at ${low}`);
  const span = to - from;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = from + ((start + i) % span);
    if (handedOut.has(port) || !(await bindable(port, host))) continue;
    handedOut.add(port);
    return port;
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
