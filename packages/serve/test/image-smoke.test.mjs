// docker/image-smoke.sh, the release's check that a built image serves, run here against a stand-in `docker` on PATH and
// a local server that answers as the container would: it passes a serving image, and fails, saying why, on a health that
// never answers, a pi that is not available, or a harness whose reason is an import error or names no install line. Codex
// must be listed: the image carries its pinned CLI (image-check.sh), so it is never unavailable as not installed or not
// the pinned build, only for a setting its reason names (no key, say); with IMAGE_SMOKE_CODEX=available it must be
// available. On a failure it shows the container's log with any key withheld, and it always removes the container it
// started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { harnessesOf, harnessOffers } from "../dist/harness.js";
import { findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";

const pinned = verifyCodexBinary(findCodex());
const noCodex = pinned instanceof Error && env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? pinned.message : false;

const SMOKE = fileURLToPath(new URL("../docker/image-smoke.sh", import.meta.url));
/** The address the smoke publishes the container on (its `loopback=`), which the stand-in container answers on. */
const LOOPBACK = /^loopback=(\S+)$/m.exec(readFileSync(SMOKE, "utf8"))?.[1];

/** Runs the smoke with a stand-in docker whose container is `answer` (a function of the path), on loopback. */
const smoke = (t, answer, ...runArgs) => smokeWith(t, {}, answer, ...runArgs);
/** The same, with `extra` in the smoke's own environment (IMAGE_SMOKE_CODEX, say). */
async function smokeWith(t, extra, answer, ...runArgs) {
  const server = createServer((req, res) => {
    const reply = answer(req.url);
    if (!reply) return req.socket.destroy();
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), "agentrun-image-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  // The stand-in: records each call, publishes the local server's port, and prints a start log holding a key.
  await writeFile(join(dir, "docker"), `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  run) echo 0123456789ab ;;
  port) echo "${LOOPBACK}:${server.address().port}" ;;
  logs) echo "AGENTRUN_API_KEY=ar_local_secretvalue"; echo "Open the page with ?token=othersecret" ;;
esac
`);
  await chmod(join(dir, "docker"), 0o755);
  const child = spawn("sh", [SMOKE, "agentrun-server:test", ...runArgs], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE_SMOKE_WAIT_S: "3", ...extra } });
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

test("the smoke publishes on loopback only", () => {
  assert.match(LOOPBACK ?? "", /^127\.\d+\.\d+\.\d+$/);
});

test("the smoke runs as documented, `docker/image-smoke.sh <image>`: it is executable", () => {
  assert.ok(statSync(SMOKE).mode & 0o100, `docker/image-smoke.sh is mode ${(statSync(SMOKE).mode & 0o777).toString(8)}, not executable`);
});

// Codex's offer is the one this serve makes with the pinned CLI and no key (harnessOffers, as GET /v2/capabilities answers).
test("an image of this serve passes, by the harnesses this serve really reports (claude-agent: a harness it does not run yet; codex with no key)", { skip: noCodex }, async (t) => {
  const codex = (await harnessOffers({})).find((h) => h.id === "codex");
  assert.equal(codex?.available, false, "with no key this serve offers codex as unavailable");
  const harnesses = harnessesOf({}).map((h) => (h.id === "codex" ? codex : h));
  assert.ok(harnesses.some((h) => h.id === "claude-agent"), "this serve lists claude-agent");
  const r = await smoke(t, serving(harnesses));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /claude-agent: unavailable \(/);
  assert.match(r.stdout, /codex: unavailable \(codex needs OPENAI_API_KEY/);
});

const claude = { id: "claude-agent", available: false, reason: "The Claude Agent SDK 0.3.286 is not installed; npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286" };

test("an image that serves passes: health 200 ok, pi available, claude-agent not installed with its install line, another harness available or set-up-able", async (t) => {
  const r = await smoke(t, serving([pi, claude, { id: "codex", available: false, reason: "No model key is set: set AGENT_MODEL_API_KEY" }]), "-e", "AGENT_MODEL=m");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /health 200 ok; capabilities 200, contract agentrun\.v2\/0/);
  assert.match(r.stdout, /claude-agent: unavailable \(The Claude Agent SDK 0\.3\.286 is not installed/);
  assert.match(r.stdout, /codex: unavailable/);
  // Another harness may be available: only claude-agent's SDK is held back.
  assert.equal((await smoke(t, serving([pi, claude, { id: "codex", available: true }]))).code, 0);
  assert.ok(r.calls[0].startsWith("run -d --name agentrun-image-smoke-") && r.calls[0].endsWith(` -p ${LOOPBACK}::7340 -e AGENT_MODEL=m agentrun-server:test`), r.calls[0]);
  assert.match(r.calls.at(-1), /^rm -f -v agentrun-image-smoke-\d+$/, "the container it started is removed");
});

test("codex passes with no key, unavailable for the key it names; and available, also when IMAGE_SMOKE_CODEX=available asks for it", { skip: noCodex }, async (t) => {
  const keyless = (await harnessOffers({})).find((h) => h.id === "codex");
  const keyed = (await harnessOffers({ OPENAI_API_KEY: "fake-test-key" })).find((h) => h.id === "codex");
  assert.equal(keyed?.available, true, "with a key this serve offers codex as available");
  const r = await smoke(t, serving([pi, claude, keyless]));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /codex: unavailable \(codex needs OPENAI_API_KEY/);
  const asked = await smokeWith(t, { IMAGE_SMOKE_CODEX: "available" }, serving([pi, claude, keyed]));
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stdout, /codex: available/);
});

// The image carries the pinned Codex CLI, so each of these is a broken image, not a setting to change.
const codexCases = [
  ["capabilities that list harnesses but not codex", serving([pi, claude]), {}, /capabilities list harnesses, but not codex/],
  ["codex unavailable as not installed, though with its install line", serving([pi, claude, { id: "codex", available: false, reason: "codex is not installed here: npm install @parcha/agentrun-codex @openai/codex@0.164.0" }]), {}, /codex is unavailable as not installed or not the pinned build, but the image carries the pinned Codex CLI/],
  ["codex unavailable as not the pinned build", serving([pi, claude, { id: "codex", available: false, reason: "agentrun-codex: the Codex binary at /x/codex is not the pinned build: its binary sha256 is 00, not 11 (npm install @parcha/agentrun-codex @openai/codex@0.164.0)" }]), {}, /codex is unavailable as not installed or not the pinned build/],
  ["codex unavailable for a reason that names no setting", serving([pi, claude, { id: "codex", available: false, reason: "This server does not run codex yet." }]), {}, /codex is unavailable for a reason that names no setting to change/],
  ["codex unavailable when IMAGE_SMOKE_CODEX=available asks for it", serving([pi, claude, { id: "codex", available: false, reason: "codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL." }]), { IMAGE_SMOKE_CODEX: "available" }, /IMAGE_SMOKE_CODEX=available, but codex is unavailable/],
];
for (const [why, answer, extra, said] of codexCases) {
  test(`the smoke fails on ${why}, and says so`, { timeout: 30_000 }, async (t) => {
    const r = await smokeWith(t, extra, answer);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, said);
    assert.match(r.calls.at(-1), /^rm -f -v agentrun-image-smoke-\d+$/);
  });
}

for (const [why, answer, said] of [
  ["a health that never answers", () => undefined, /GET \/v2\/health did not answer 200 ok/],
  ["pi not available", serving([{ id: "pi", available: false, reason: "no model" }]), /pi is not available/],
  ["a harness whose reason is an import error", serving([pi, { id: "claude-agent", available: false, reason: "Cannot find package '@anthropic-ai/claude-agent-sdk'" }]), /claude-agent's reason is an error/],
  ["a harness not installed with no install line", serving([pi, { id: "codex", available: false, reason: "Codex is not installed" }]), /codex says it is not installed but gives no install line/],
  ["claude-agent available, though the image carries no Claude Agent SDK", serving([pi, { id: "claude-agent", available: true }]), /claude-agent is available, but the image carries no Claude Agent SDK/],
  ["claude-agent unavailable for another reason than not installed or not run yet", serving([pi, { id: "claude-agent", available: false, reason: "No model key is set" }]), /claude-agent is unavailable, but neither as not installed nor as a harness this server does not run yet/],
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
