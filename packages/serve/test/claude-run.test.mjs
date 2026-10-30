// A run on claude-agent through serve, on the real pinned Agent SDK and Claude CLI (a dev dependency here), against a
// fake Anthropic Messages endpoint on loopback (no key, no network): its requests go through the adapter's proxy to
// ANTHROPIC_BASE_URL's origin with the native model id, each paid request is booked once at serve's catalog price, and
// the CLI runs under the run's confinement (setpriv's no_new_privs, as pi's commands do, under the same user), in the
// session's private directory, with no key and no server variable in its environment. A run whose process dies while a
// request is in flight resumes on the next process, books the cut request once as unknown, and leaves no CLI behind.
// Every process the test reads is its own descendant.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, serve } from "./support.mjs";

/** A key for the fake endpoint: no real one. */
const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
/** claude-haiku-4-5 in serve's catalog: $1 in, $5 out per million tokens. */
const PRICE = { input: 1, output: 5 };

/** This test's own descendant processes, by walking each process's children from this one. */
async function descendants() {
  const out = [];
  const queue = [process.pid];
  while (queue.length) {
    const pid = queue.shift();
    for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(() => "")).split(" ").filter(Boolean)) {
        out.push(Number(child));
        queue.push(Number(child));
      }
    }
  }
  return out;
}

/** The test's own descendant that runs the pinned Claude CLI. */
async function claudeProcess() {
  for (const pid of await descendants()) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv.some((arg) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(arg))) return pid;
  }
  return undefined;
}
const field = (status, name) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1]?.trim();
/** Whether `pid` still runs: a zombie, waiting to be reaped, does not. */
const alive = processAlive;

/** serve on the fake endpoint, with the env restored after. */
async function claudeServe(t, fake, options = {}) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` });
  const served = await serve(t, { faux: undefined, ...options });
  assert.equal((await served.api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  return served;
}

/** A fake endpoint whose first answer waits until `release`. */
async function heldFake(t) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  let first = true;
  const fake = await fakeAnthropic({
    reply: () => {
      if (!first) return { text: "Claude answered." };
      first = false;
      return { hold: held, then: { text: "Claude answered." } };
    },
  });
  t.after(() => fake.close());
  return { fake, release };
}

const untilRequest = async (fake) => {
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 600, "a model request reaches the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** The files under `dir`, by relative path. */
async function filesUnder(dir, at = "") {
  const out = [];
  for (const entry of await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) out.push(path, ...(await filesUnder(dir, path)));
    else out.push(path);
  }
  return out;
}

test("a run on claude-agent: through the adapter's proxy with the native model, each request booked once at serve's price, the CLI confined, in its own directory, with no key in its environment", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake, release } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent"), { id: "claude-agent", available: true, steer: false, native_tools: false });
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await untilRequest(fake);
  // Mid-turn, with the endpoint holding its first answer: the CLI's process, its rights, its directory, its environment.
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs, under this test");
  const status = await readFile(`/proc/${cli}/status`, "utf8");
  assert.equal(field(status, "NoNewPrivs"), "1", "under setpriv --no-new-privs, as pi's commands are");
  assert.equal(field(status, "Uid")?.split(/\s+/)[0], String(process.getuid()), "as the run's own user");
  const cwd = await readlink(`/proc/${cli}/cwd`);
  assert.ok(cwd.startsWith(join(data, "runs", runId, "harness")), `the CLI works in the session's private directory, not the workspace: ${cwd}`);
  const environ = (await readFile(`/proc/${cli}/environ`, "utf8")).split("\0").filter(Boolean);
  assert.ok(!environ.some((line) => line.includes(KEY)), "the key never reaches the CLI");
  assert.deepEqual(environ.filter((line) => /^(ANTHROPIC_API_KEY|AGENTRUN_[A-Z_]*)=/.test(line)).map((line) => line.split("=")[0]), [], "nor the server's variables");
  // The CLI's endpoint is the session's own proxy on loopback, never the endpoint the server holds the key for.
  const base = environ.find((line) => line.startsWith("ANTHROPIC_BASE_URL="))?.slice("ANTHROPIC_BASE_URL=".length);
  assert.ok(base === undefined || (new URL(base).hostname === "127.0.0.1" && new URL(base).origin !== new URL(fake.url).origin), `the CLI talks to the session's proxy: ${base}`);
  release();
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  const asked = fake.messages();
  assert.ok(fake.requests.every((r) => !r.refused), "no request was refused and retried");
  assert.ok(asked.every((m) => m.path === "/v1/messages" && m.authorized && m.model === MODEL), `Anthropic Messages, with the key, the native id: ${asked.map((m) => m.model).join(", ")}`);
  // serve's runs get none of the CLI's own tools until runs get a confined box: the model is offered only the host's.
  const offered = [...new Set(asked.flatMap((m) => (m.body?.tools ?? []).map((tool) => tool.name)))];
  assert.deepEqual(offered.filter((name) => !name.startsWith("mcp__")), [], `no tool of the CLI's own is offered on serve: ${offered.join(", ")}`);
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, asked.length, "each request the endpoint answered is one booked request, once");
  // The endpoint reports a response's input as its request body's length over 4, and 12 output tokens.
  const expected = asked.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.body).length / 4) * PRICE.input + 12 * PRICE.output, 0) / 1e6;
  assert.equal(usage?.usd, Math.round(expected * 1e6) / 1e6, "each response's input and output at serve's catalog price");
  // The run's workspace is its harness's directory, the CLI's own cwd (run-workspace.ts).
  const left = (await filesUnder(join(data, "runs", runId, "harness", "work"))).filter((path) => path.startsWith(".claude") || path.endsWith(".jsonl"));
  assert.deepEqual(left, [], "no CLI file in the run's workspace");
});

test("a claude-agent run whose process dies while a request is in flight resumes on the next process: the cut request booked once as unknown, a chat sent meanwhile answered, and no CLI left behind", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await untilRequest(fake);
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs, under this test");
  // Accepted while the request is in flight: it waits for the turn, and outlives the process.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "And then?" })).status, 202);
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["Say what you did.", "And then?"]);
  assert.equal(rows.filter((r) => r.kind === "user_message" || r.kind === "final_answer").at(-1)?.kind, "final_answer", "the chat is answered");
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, fake.messages().length, "every request the endpoint saw is booked once, the cut one included");
  assert.equal(usage?.usd, null, "the cut request's cost is unknown, so the run's is: never 0");
  t.after(() => alive(cli) && process.kill(cli, "SIGKILL"));
  // The CLI starts under the run's prefix (setpriv --pdeathsig KILL): it dies with the process that started it.
  for (let i = 0; alive(cli); i++) {
    assert.ok(i < 20, `the dead process's CLI (pid ${cli}) is gone within 2 s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test("on a server whose box passed its probe, a claude-agent run's own process starts the CLI with none of its own tools and no box: the switch that turns them on (native-tools.ts) is obeyed by the run, not only by capabilities", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  // serve's box says bwrap: the run's process gets its box settings, and decides for itself whether its harness's own
  // tools are on. They are not, so the run builds no box and the CLI is offered none of its own tools.
  const boxed = { isolation: { mode: "bwrap", cgroup: false }, start() { throw new Error("serve's own box starts nothing here"); }, reap: async () => ({ empty: true, left: 0, by: "none" }) };
  const { api, data } = await claudeServe(t, fake, { boxFactory: async () => boxed });
  assert.equal((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent").native_tools, false);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const offered = [...new Set(fake.messages().flatMap((m) => (m.body?.tools ?? []).map((tool) => tool.name)))];
  assert.deepEqual(offered.filter((name) => !name.startsWith("mcp__")), [], `the run's CLI is offered none of its own tools: ${offered.join(", ")}`);
  assert.equal(existsSync(join(data, "runs", run.body.run_id, "box.json")), false, "the run built no box for its CLI");
});
