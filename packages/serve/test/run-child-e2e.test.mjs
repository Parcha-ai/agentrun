// Runs in processes of their own, end to end through the API, as the CLI's start runs them (run-child-host.ts
// childLoops): an upload named at a run's start is in its work folder before its process starts; a priced MCP tool's
// call from a run's process is held and booked under its run's cap; an SDK backend run past its deadline is closed by its
// runner and ends; a slot whose reap does not hold is retired before
// any run of it starts; where runs have users of their own, a claude-agent run on Claude Code's login on this machine
// fails at its claim in words naming the setting; and the server started with its runner beside it (serveWithRunner, the
// image's start) runs each run in a process of its own. image-custody.sh shows the same as the image's users.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, client, follow, serve, webhookLookup, whenFree, withEnv } from "./support.mjs";

const { serveWithRunner } = await import("../dist/runner/beside.js");
const { settingFor } = await import("../dist/claude-login.js");

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const FAUX_CHANNEL = new URL("./fixtures/faux-channel.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"run-child-e2e-0123"}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratchDir = (t, prefix) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;

async function started(api, id, extra, body) {
  const made = await whenFree(() => api("POST", "/agents", agent(id, extra)));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await whenFree(() => api("POST", `/agents/${id}/runs`, body));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("a run's process reads the upload its start named, at inputs/<path> in its work folder", { timeout: 120_000 }, async (t) => {
  const reader = join(scratchDir(t, "child-reader-"), "faux-reader.mjs");
  writeFileSync(reader, `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return faux.message(\`Read: \${textOf(last)} by \${process.pid}\`);
  return faux.message(faux.toolCall("read", { path: "inputs/brief/notes.txt" }), { stopReason: "toolUse" });
}
`);
  const lines = [];
  const server = await serve(t, { faux: reader, childRuns: { log: (line) => void lines.push(line) } });
  const words = "The upload reached the run's process.";
  const sent = await fetch(`${server.baseUrl}/files?path=brief/notes.txt`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "text/plain" }, body: words });
  assert.equal(sent.status, 201, await sent.clone().text());
  const file = (await sent.json()).file;
  const runId = await started(server.api, "reader", { tools: ["read"] }, { input: { content: "Read the upload." }, file_ids: [file.file_id] });
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  const said = await answerOf(server.api, runId);
  const match = /^Read: (.*) by (\d+)$/s.exec(said ?? "");
  assert.ok(match, `${said}; ${lines.join("\n")}`);
  assert.match(match[1], new RegExp(words.replace(/[.']/g, "\\$&")));
  assert.notEqual(Number(match[2]), process.pid, "read in a process of its own");
});

test("a priced MCP tool called from a run's process is held under its run's cap and booked as its tool cost", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const lines = [];
  const server = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true, childRuns: { log: (line) => void lines.push(line) } });
  const { api } = server;
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN }, prices: { paid: 0.05 } })).status, 200);
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
  const runId = await started(api, "roomy", { tools: ["mcp:fake/paid"] }, { input: { content: 'Call mcp__fake__paid with {"query":"ada"}' }, max_cost_usd: 1 });
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, runId), "The tool said: paid for ada", `${JSON.stringify(rows.filter((row) => row.kind === "phase" || row.kind === "error").map((row) => row.summary ?? row.text))}; ${lines.join("\n")}`);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "paid").length, 1, "sent once");
  const charge = rows.find((row) => row.kind === "phase" && row.tool_name === "mcp:fake/paid");
  assert.deepEqual([charge?.summary, charge?.usage?.usd], ["Tool cost: fake charged $0.0500 for mcp:fake/paid", 0.05], JSON.stringify(rows.filter((row) => row.kind === "phase")));
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd, 0.05, "the run's cost is the tool's");
});

test("an SDK backend run whose deadline passed is closed by its runner and ends failed: its inbox closed, never claimed again and again", { timeout: 90_000 }, async (t) => {
  const lines = [];
  const server = await serve(t, { childRuns: { log: (line) => void lines.push(line) } });
  const { api, store } = server;
  const definition = { id: "sdk-close", name: "SDK close", instructions: "Use application policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] };
  assert.equal((await whenFree(() => api("POST", "/agents", { definition }))).status, 201);
  const sdkRun = await api("POST", "/agents/sdk-close/sdk-runs", { runtime: "claude-agent-sdk", input: "A paid application task.", instructions: "Keep the whole application policy." }, { "Idempotency-Key": "close" });
  assert.equal(sdkRun.status, 201, JSON.stringify(sdkRun.body));
  const id = sdkRun.body.run_id;
  const key = `sdk-run:${id}`;
  // Its deadline moved to the past, as a backend that never completes it reaches.
  for (let tries = 0; ; tries++) {
    const row = await store.settings.get(key);
    if (await store.settings.replaceIf(key, row, { ...row, expires_at: Date.now() - 1_000 })) break;
    assert.ok(tries < 20, "the inbox kept changing");
  }
  const { last } = await follow(api, id, ["failed"], { deadlineMs: 60_000 }).catch((error) => assert.fail(`${error.message}; ${lines.filter((line) => line.includes("may not")).join("\n")}`));
  assert.equal(last.status, "failed");
  assert.equal((await store.settings.get(key)).closed, "expired");
  assert.deepEqual(lines.filter((line) => line.includes("a run's process may not")), [], "no store call refused");
});

test("a slot whose reap does not end every process of its user is retired before any run starts on it: the helper is never asked to run the run there", { timeout: 60_000 }, async (t) => {
  const dir = scratchDir(t, "runas-");
  const helper = join(dir, "agentrun-runas");
  writeFileSync(helper, `#!/bin/sh\necho "$*" >> "$(dirname "$0")/log"\ncase "$1" in\ncheck) exit 0 ;;\nreap) echo "a process of the slot's user is still alive" >&2; exit 1 ;;\nesac\nexit 0\n`);
  chmodSync(helper, 0o755);
  const helperLog = () => {
    try {
      return readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const lines = [];
  const server = await serve(t, { childRuns: { isolation: { kind: "uid", helper, first: 0, slots: 1 }, log: (line) => void lines.push(line) } });
  const runId = await started(server.api, "stale-slot", {}, { input: { content: "Hello." } });
  for (const end = Date.now() + 30_000; !lines.some((line) => line.includes("slot 0 is retired")); await sleep(50)) {
    assert.ok(Date.now() < end, `the slot was never retired: ${lines.join("\n")}; the helper was asked: ${helperLog().join(" | ")}`);
  }
  assert.ok(lines.some((line) => line === `run ${runId}: slot 0 is retired: its reap did not end every process of its user, so no run of this runner runs on it again until the runner restarts`), lines.join("\n"));
  // The helper is asked one thing: the slot's reap, before any folder of the run is laid (a reap at a run's end gives its
  // folders back, --fix); never to run anything on it.
  await sleep(500);
  const asked = helperLog();
  assert.equal(asked.length, 1, `the helper is asked only the slot's reap: ${asked.join(" | ")}`);
  assert.match(asked[0], /^reap 0 /, asked[0]);
  assert.ok(!asked[0].includes("--fix"), `reaped before the run's folders were laid: ${asked[0]}`);
  assert.notEqual((await server.api("GET", `/runs/${runId}`)).body.state, "completed");
});

test("a claim that finds the run's folders shut by its last slot (a runner that ended before giving them back) takes them back before it lays anything, and the run completes", { timeout: 90_000 }, async (t) => {
  const { FAUX, startInProcessRunner } = await import("./support.mjs");
  const { runTops } = await import("../dist/runner/run-child-host.js");
  const dir = scratchDir(t, "runas-resume-");
  const helper = join(dir, "agentrun-runas");
  // The image's helper, stood in for: every call logged; `own runner` reopens what it is given (the server's user owns
  // it again), `run` becomes the run's process, the rest succeed.
  writeFileSync(helper, `#!/bin/sh\necho "$*" >> "$(dirname "$0")/log"\ncase "$1" in\nown) [ "$2" = runner ] && { shift 2; chmod -R u+rwx "$@" 2>/dev/null; }; exit 0 ;;\nrun) shift 2; while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;;\nesac\nexit 0\n`);
  chmodSync(helper, 0o755);
  const server = await serve(t, { runner: false });
  const runId = await started(server.api, "resumed", {}, { input: { content: "Hello." } });
  // What a runner that died mid-run leaves: the run's folder its last slot's, shut (a run's own chmod 700, to this
  // test's user: no access at all).
  const [top] = runTops(server.data, "resumed", runId);
  mkdirSync(join(top, "work"), { recursive: true });
  chmodSync(top, 0o000);
  const lines = [];
  // The runner stopped and the folder opened again here, before serve()'s own teardown (its after-hook runs first).
  const close = await startInProcessRunner(server.data, { faux: FAUX, mcpOwn: server.own, childRuns: { isolation: { kind: "uid", helper, first: 0, slots: 1 }, log: (line) => void lines.push(line) } });
  try {
    const { last } = await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.equal(last.status, "completed", `${JSON.stringify((await server.api("GET", `/runs/${runId}`)).body.error)}\n${lines.join("\n")}`);
  } finally {
    await close();
    chmodSync(top, 0o700);
  }
  const asked = readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(asked.slice(0, 4), ["reap 0", "own runner", "own 0", "run 0"], "taken back before the slot is given its folders and run");
  assert.deepEqual(asked.slice(-2), ["reap 0", "own runner"], "given back at the run's end");
});

test("where runs have users of their own, a claude-agent run on Claude Code's login on this machine with no model_key of its own fails at its claim in words naming the login and AGENTRUN_RUN_USER=same: never run, never a hang", { timeout: 90_000 }, async (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: "not-a-secret" }, ["AGENTRUN_CLAUDE_CODE_LOGIN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const dir = scratchDir(t, "runas-login-");
  const helper = join(dir, "agentrun-runas");
  writeFileSync(helper, `#!/bin/sh\necho "$*" >> "$(dirname "$0")/log"\nexit 0\n`);
  chmodSync(helper, 0o755);
  const lines = [];
  const server = await serve(t, { faux: undefined, childRuns: { isolation: { kind: "uid", helper, first: 0, slots: 1 }, log: (line) => void lines.push(line) } });
  // Claude Code's login on this machine, turned on for this machine as the owner's turn-on saves it.
  await server.store.settings.put("claude_login", settingFor("agentrun", server.data));
  const runId = await started(server.api, "on-login", { harness: "claude-agent", model: "anthropic/claude-haiku-5-5" }, { input: { content: "Say hi." } });
  const { last } = await follow(server.api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "failed", lines.join("\n"));
  const error = JSON.stringify((await server.api("GET", `/runs/${runId}`)).body.error);
  assert.match(error, /Claude Code's login on this machine/, error);
  assert.match(error, /AGENTRUN_RUN_USER=same/, error);
  assert.match(error, /model_key/, error);
  assert.equal(existsSync(join(dir, "log")), false, `the helper was never asked to run the run: ${existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : ""}`);
});

test("the server started with its runner beside it (serveWithRunner) runs each run in a process of its own", { timeout: 90_000 }, async (t) => {
  const data = join(scratchDir(t, "beside-"), "agents");
  const started_ = await serveWithRunner({ data, port: 0, faux: FAUX_CHANNEL, drainTimeout: "5s", mcpLoopback: true, webhookLookup });
  t.after(() => started_.close());
  const api = client(started_.serve.baseUrl, started_.serve.token);
  const runId = await started(api, "own-process", {}, { input: { content: "Who are you?" } });
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const said = JSON.parse((await answerOf(api, runId)) ?? "{}");
  assert.equal(typeof said.pid, "number", JSON.stringify(said));
  assert.notEqual(said.pid, process.pid, "the run ran in the server's own process");
});
