#!/bin/sh
# The image serves: a container of <image>, published on a loopback port only, answers GET /v2/health with 200 and
# status ok, and GET /v2/capabilities with the contract. Where capabilities list the harnesses, pi is available and every
# harness the image does not carry (image-check.sh) is unavailable with a reason a person can act on, not an import
# error: a reason that says it is not installed gives the one line that installs it. The container is stopped and removed
# by its own name, its anonymous /data volume with it. Needs docker and node. Arguments after the image go to
# `docker run` (`-e AGENT_MODEL=...`, say), so a model can be configured and each adapter's own install check is reached.
#   image-smoke.sh <image> [docker run arguments...]    (IMAGE_SMOKE_WAIT_S: how long health may take, default 60)
set -eu
image=${1:?usage: image-smoke.sh <image> [docker run arguments...]}
shift
name="agentrun-image-smoke-$$"
# The one address the container is published on: this machine's loopback, never a public interface.
loopback=127.0.0.1
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$name" -p "$loopback::7340" "$@" "$image" >/dev/null
port=$(docker port "$name" 7340/tcp | sed -n "s/^$loopback:\([0-9][0-9]*\)\$/\1/p" | head -n 1)
[ -n "$port" ] || { echo "image smoke: no loopback port for $name" >&2; exit 1; }
if ! node - "http://$loopback:$port" "${IMAGE_SMOKE_WAIT_S:-60}" <<'EOF'
const base = process.argv[2];
const fail = (why) => { console.error(`image smoke: ${why}`); process.exit(1); };
// Docker's port proxy accepts a connection before the server listens, and a fetch on it can then wait with nothing
// holding the event loop open (node exits 13, saying nothing). A referenced timer keeps it open, and each request has
// its own referenced deadline.
setInterval(() => {}, 1_000);
const get = (path) => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5_000);
  return fetch(`${base}${path}`, { signal: stop.signal }).finally(() => clearTimeout(timer));
};
const wait = Number(process.argv[3]) || 60;
const until = Date.now() + wait * 1_000;
let health;
while (Date.now() < until) {
  try {
    const r = await get("/v2/health");
    health = { status: r.status, body: await r.json().catch(() => null) };
    if (r.status === 200) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (health?.status !== 200 || health.body?.status !== "ok") fail(`GET /v2/health did not answer 200 ok within ${wait} s: ${JSON.stringify(health)}`);
const r = await get("/v2/capabilities");
const caps = await r.json().catch(() => null);
if (r.status !== 200 || typeof caps?.contract !== "string") fail(`GET /v2/capabilities answered ${r.status}: ${JSON.stringify(caps)?.slice(0, 300)}`);
const lines = [`health 200 ok; capabilities 200, contract ${caps.contract}`];
if (Array.isArray(caps.harnesses)) {
  for (const h of caps.harnesses) {
    if (h.id === "pi") {
      if (h.available !== true) fail(`pi is not available: ${JSON.stringify(h)}`);
    } else {
      const reason = String(h.reason ?? "");
      if (h.available !== false) fail(`${h.id} is available, but the image carries none of its CLI`);
      if (!reason) fail(`${h.id} is unavailable with no reason`);
      if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ERR_PACKAGE_PATH|SyntaxError|TypeError/.test(reason)) fail(`${h.id}'s reason is an error, not words a person can act on: ${reason}`);
      if (/not installed/i.test(reason) && !/npm install (?:--?[A-Za-z][A-Za-z-]* )*@/.test(reason)) fail(`${h.id} says it is not installed but gives no install line: ${reason}`);
    }
    lines.push(`${h.id}: ${h.available ? "available" : `unavailable (${h.reason})`}`);
  }
} else lines.push("capabilities list no harnesses (this serve predates them)");
console.log(lines.map((l) => `image smoke: ${l}`).join("\n"));
process.exit(0);
EOF
then
  # The server prints the API key it made at its first start: the tail shows the line with the key withheld.
  echo "image smoke: the container's log tail:" >&2
  docker logs --tail 30 "$name" 2>&1 | sed -e 's/\(_KEY=\|_TOKEN=\|token=\)[^[:space:]&]*/\1<withheld>/g' -e 's/^/  /' >&2
  exit 1
fi
