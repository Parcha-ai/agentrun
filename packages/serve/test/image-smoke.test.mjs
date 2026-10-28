// docker/image-smoke.sh, the release's check that a built image serves, run here against a stand-in `docker` on PATH and
// a local server that answers as the container would: it passes a serving image, and fails, saying why, on a health that
// never answers, a pi that is not available, or a harness whose reason is an import error or names no install line. On a
// failure it shows the container's log with any key withheld, and it always removes the container it started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SMOKE = fileURLToPath(new URL("../docker/image-smoke.sh", import.meta.url));

/** Runs the smoke with a stand-in docker whose container is `answer` (a function of the path), on loopback. */
async function smoke(t, answer, ...runArgs) {
  const server = createServer((req, res) => {
    const reply = answer(req.url);
    if (!reply) return req.socket.destroy();
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), "agentrun-image-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  // The stand-in: records each call, publishes the local server's port, and prints a start log holding a key.
  await writeFile(join(dir, "docker"), `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  run) echo 0123456789ab ;;
  port) echo "127.0.0.1:${server.address().port}" ;;
  logs) echo "AGENTRUN_API_KEY=ar_local_secretvalue"; echo "Open http://127.0.0.1:7340/?token=othersecret" ;;
esac
`);
  await chmod(join(dir, "docker"), 0o755);
  const child = spawn("sh", [SMOKE, "agentrun-server:test", ...runArgs], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE_SMOKE_WAIT_S: "3" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, calls: (await readFile(calls, "utf8")).trim().split("\n") };
}

const ok = { status: 200, body: { status: "ok", checks: { store: "ok", disk: "ok" } } };
const caps = (harnesses) => ({ status: 200, body: { contract: "agentrun.v2/0", ...(harnesses ? { harnesses } : {}) } });
const serving = (harnesses) => (path) => (path === "/v2/health" ? ok : path === "/v2/capabilities" ? caps(harnesses) : { status: 404, body: {} });
const pi = { id: "pi", available: true };

test("an image that serves passes: health 200 ok, capabilities with pi available and each other harness's install line", async (t) => {
  const r = await smoke(t, serving([pi, { id: "codex", available: false, reason: "Codex 0.164.0 is not installed; npm install --save-exact @openai/codex@0.164.0" }]), "-e", "AGENT_MODEL=m");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /health 200 ok; capabilities 200, contract agentrun\.v2\/0/);
  assert.match(r.stdout, /codex: unavailable/);
  assert.ok(r.calls[0].startsWith("run -d --name agentrun-image-smoke-") && r.calls[0].endsWith(" -p 127.0.0.1::7340 -e AGENT_MODEL=m agentrun-server:test"), r.calls[0]);
  assert.match(r.calls.at(-1), /^rm -f -v agentrun-image-smoke-\d+$/, "the container it started is removed");
});

for (const [why, answer, said] of [
  ["a health that never answers", () => undefined, /GET \/v2\/health did not answer 200 ok/],
  ["pi not available", serving([{ id: "pi", available: false, reason: "no model" }]), /pi is not available/],
  ["a harness whose reason is an import error", serving([pi, { id: "claude-agent", available: false, reason: "Cannot find package '@anthropic-ai/claude-agent-sdk'" }]), /claude-agent's reason is an error/],
  ["a harness not installed with no install line", serving([pi, { id: "codex", available: false, reason: "Codex is not installed" }]), /codex says it is not installed but gives no install line/],
  ["a harness available though the image carries none of its CLI", serving([pi, { id: "codex", available: true }]), /codex is available, but the image carries none of its CLI/],
]) {
  test(`the smoke fails on ${why}, says so, shows the log with its keys withheld, and removes the container`, { timeout: 30_000 }, async (t) => {
    const r = await smoke(t, answer);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, said);
    assert.match(r.stderr, /AGENTRUN_API_KEY=<withheld>/);
    assert.match(r.stderr, /token=<withheld>/);
    assert.doesNotMatch(r.stderr, /secretvalue|othersecret/);
    assert.match(r.calls.at(-1), /^rm -f -v agentrun-image-smoke-\d+$/);
  });
}
