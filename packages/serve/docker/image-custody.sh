#!/bin/sh
# The image holds its secrets where no process of its user can read them: a container of <image> started with every
# secret the launcher names set to a canary, its server on the faux model and one run holding its turn, has no canary in
# any process's environment or command line, in a pipe any of them holds, or in PID 1 (tini, started by the launcher).
# No process but PID 1 holds the launcher's pipe: tini inherits it and keeps it, and the server reads it empty first
# thing, so PID 1's is checked to read empty. The run's process still got its model key, over its own pipe. The container
# is stopped and removed by its own name. Needs docker. Arguments after the image go to `docker run`: a reviewer can
# bind-mount a changed launcher read-only over the image's to see it fail here.
#   image-custody.sh <image> [docker run arguments...]
set -eu
image=${1:?usage: image-custody.sh <image> [docker run arguments...]}
shift
name="agentrun-image-custody-$$"
canary="not-a-secret-image-$$-$(date +%s)"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
launcher=/opt/agentrun/packages/serve/launcher/agentrun-serve
names=$(docker run --rm --entrypoint sh "$image" -c "sed -n \"s/^SECRETS='\\(.*\\)'\$/\\1/p\" $launcher")
[ -n "$names" ] || { echo "image custody: the launcher in $image names no secrets" >&2; exit 1; }
# Names and canaries have no spaces, so the -e arguments go as one word list.
secrets=
for n in $names; do secrets="$secrets -e $n=$canary-$n"; done
# shellcheck disable=SC2086
docker run -d --name "$name" $secrets "$@" "$image" --data /data --port 7340 --faux /opt/agentrun/packages/serve/test/fixtures/faux-custody.mjs >/dev/null
docker exec -i -e CANARY="$canary" -e TOKEN="$canary-AGENTRUN_TOKEN" "$name" node --input-type=module - <<'EOF'
import { closeSync, constants, openSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs";
const fail = (why) => { console.error(`image custody: ${why}`); process.exit(1); };
const base = "http://127.0.0.1:7340/v2";
const api = (method, path, body) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  if ((await fetch(`${base}/health`).then((r) => r.status, () => 0)) === 200) break;
  if (i > 300) fail("the server never answered /v2/health");
  await sleep(200);
}
if ((await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [] } })).status !== 201) fail("the agent was not made (the token did not reach the server?)");
const run = (await api("POST", "/agents/custody/runs", { input: { content: "Report." } })).body;
let view;
for (let i = 0; (view = (await api("GET", `/runs/${run.run_id}`)).body).status !== "completed"; i++) {
  if (i > 300) fail(`the run did not complete: ${JSON.stringify(view)}`);
  await sleep(200);
}
const report = JSON.parse(view.result.final_answer);
if (report.handed.AGENT_MODEL_API_KEY === "none") fail("the run's process was not handed its model key");
if (report.inEnv.length) fail(`the run's process has ${report.inEnv.join(", ")} in its environment`);
await api("POST", `/runs/${run.run_id}/messages`, { content: "Hold." });
for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working"; i++) {
  if (i > 200) fail("the held turn never worked");
  await sleep(100);
}
await sleep(500);
const canary = process.env.CANARY;
const read = (path) => { try { return readFileSync(path); } catch { return Buffer.alloc(0); } };
const pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
if (read("/proc/1/comm").toString().trim() !== "tini") fail(`PID 1 is ${read("/proc/1/comm").toString().trim()}, not tini`);
let checked = 0;
let pid1Pipe = false;
for (const pid of pids) {
  const what = read(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").slice(0, 100);
  if (read(`/proc/${pid}/environ`).includes(canary)) fail(`pid ${pid} (${what}) has a secret in its environment`);
  if (read(`/proc/${pid}/cmdline`).includes(canary)) fail(`pid ${pid} (${what}) has a secret on its command line`);
  let fds = [];
  try { fds = readdirSync(`/proc/${pid}/fd`); } catch {}
  for (const fd of fds) {
    let target;
    try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    const launcherPipe = /agentrun-serve\.[^/]+\/secrets/.test(target);
    if (launcherPipe && pid !== "1") fail(`pid ${pid} (${what}) holds the launcher's pipe on fd ${fd}`);
    if (launcherPipe) pid1Pipe = true;
    if (!target.startsWith("pipe:") && !target.endsWith(" (deleted)")) continue;
    try {
      const own = openSync(`/proc/${pid}/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
      const chunk = Buffer.alloc(65_536);
      for (let got; (got = (() => { try { return readSync(own, chunk, 0, chunk.length, null); } catch { return 0; } })()) > 0; ) {
        if (chunk.subarray(0, got).includes(canary)) fail(`pid ${pid} (${what})'s fd ${fd} has a secret unread`);
      }
      closeSync(own);
    } catch {}
  }
  checked++;
}
console.log(`image custody: no secret in ${checked} processes (PID 1 tini, the server, the run's process); PID 1 ${pid1Pipe ? "holds the launcher's pipe, read empty" : "holds no launcher pipe"}; the run's process was handed its model key`);
EOF
