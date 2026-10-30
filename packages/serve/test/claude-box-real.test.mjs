// A boxed claude-agent run on a REAL box: serve's own box (localBoxFactory: the kernel's probe and bwrapBox), the pinned
// Agent SDK and Claude CLI, and a fake Anthropic endpoint on loopback (no key, no network).
// - What the CLI's own tool sees of its launch's temporary directory: only its spawn's own directories, never a browser's.
// - A run killed mid-turn resumes on its next launch, in a new launch directory, and completes; the dead launch's
//   directory goes.
// - One boxed Claude session per run process, on the real adapter.
// - The CLI's config directory outside the session (a TMPDIR not set inside it): the kernel's bind check refuses the
//   start by name, the turn fails, and the process lives.
// Without a bwrap that makes a box, or without the pinned CLI, it skips by name, unless AGENTRUN_BOX_REAL=1 (the job
// that installs the box) makes that fail.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBox } from "@parcha/agentrun-kernel/host";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { claudeAgentAdapter, verifyClaudeAgent } from "@parcha/agentrun-harness-claude";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { oneBoxedClaude } from "../dist/app.js";
import { localBoxFactory } from "../dist/box/local.js";
import { runBox } from "../dist/box/run-box.js";
import { agent, follow, serve } from "./support.mjs";

const REQUIRED = process.env.AGENTRUN_BOX_REAL === "1";
const probed = await (async () => {
  const scratch = mkdtempSync(join("/tmp", "serve-cbr-probe-"));
  try {
    return await probeBox({ scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();
let cli;
try {
  verifyClaudeAgent({});
} catch (error) {
  cli = `${error.name}: ${error.message}`;
}
const skip = REQUIRED ? false : probed.mode !== "bwrap" ? `no usable bwrap here: ${JSON.stringify(probed)}` : cli ? `no pinned Claude CLI here: ${cli}` : false;

const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";

/** serve on the fake endpoint with its own real box, the env restored after. */
async function boxedServe(t, fake) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` });
  const served = await serve(t, { faux: undefined, boxFactory: localBoxFactory });
  assert.equal((await served.api("GET", "/capabilities")).body.box.mode, "bwrap", "serve's box passed its probe");
  assert.equal((await served.api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  return served;
}

/** The run's process as run.json names it, and its TMPDIR (its launch's own directory), once it is up. */
async function launchOf(data, runId) {
  for (let i = 0; i < 600; i++) {
    const holder = await readFile(join(data, "runs", runId, "run.json"), "utf8").then((text) => JSON.parse(text).holder, () => undefined);
    const environ = holder ? await readFile(`/proc/${holder.pid}/environ`, "utf8").catch(() => undefined) : undefined;
    const tmp = environ?.split("\0").find((kv) => kv.startsWith("TMPDIR="))?.slice("TMPDIR=".length);
    if (holder && tmp) return { pid: holder.pid, tmp };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("the run's process came up with a launch directory");
}

/** The text of the last tool result the model was sent. */
const lastToolResult = (fake) => {
  const messages = fake.messages().at(-1)?.body?.messages ?? [];
  const result = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result").at(-1);
  return typeof result?.content === "string" ? result.content : (result?.content ?? []).map((c) => c.text ?? "").join("");
};

test("in the run's real box, the CLI's own tool lists its launch's directory and sees only its spawn's own directories, never a browser's there", { skip, timeout: 300_000 }, async (t) => {
  let data;
  let runId;
  let launch;
  let step = 0;
  const fake = await fakeAnthropic({
    reply: () => {
      if (step++ > 0) return { text: "Listed." };
      // The run's process is up (it is making this request): plant a browser's directories in its launch's directory,
      // then have the CLI list that directory from inside its box.
      launch = launchOfSync(data, runId);
      mkdirSync(join(launch, "pi-browser-profile"), { recursive: true });
      mkdirSync(join(launch, "pib-track-1"), { recursive: true });
      return { tool: { name: "Bash", input: { command: `ls -A '${launch}'`, description: "list the launch's directory" } } };
    },
  });
  t.after(() => fake.close());
  const served = await boxedServe(t, fake);
  data = served.data;
  runId = (await served.api("POST", "/agents/claude/runs", { input: { content: "List it." } })).body.run_id;
  await follow(served.api, runId, ["completed"], { deadlineMs: 240_000 });
  const listed = lastToolResult(fake).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.ok(listed.length >= 1 && listed.every((name) => /^(dh-claude-|claude-resume-)/.test(name)), `only the spawn's own directories are there: ${JSON.stringify(listed)}`);
  assert.ok(existsSync(join(launch, "pi-browser-profile")) && existsSync(join(launch, "pib-track-1")), "they are on the host, outside the box");
});

/** launchOf, synchronously, for the fake's reply. */
function launchOfSync(data, runId) {
  const holder = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder;
  return readFileSync(`/proc/${holder.pid}/environ`, "utf8").split("\0").find((kv) => kv.startsWith("TMPDIR=")).slice("TMPDIR=".length);
}

test("a boxed Claude run killed mid-turn resumes on its next launch, in a new launch directory, and completes; the dead launch's directory goes", { skip, timeout: 300_000 }, async (t) => {
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
  const { api, data } = await boxedServe(t, fake);
  const runId = (await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } })).body.run_id;
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 1200, "the turn's model request reaches the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const before = await launchOf(data, runId);
  process.kill(before.pid, "SIGKILL");
  release();
  await follow(api, runId, ["completed"], { deadlineMs: 240_000 });
  const after = await launchOf(data, runId).catch(() => undefined);
  const procTmp = join(data, "runs", runId, "harness", "proc-tmp");
  const launches = readdirSync(procTmp);
  assert.ok(!launches.includes(before.tmp.slice(before.tmp.lastIndexOf("/") + 1)) || after === undefined, `the killed launch's directory is gone once its process is: ${JSON.stringify(launches)}`);
  if (after) assert.notEqual(after.tmp, before.tmp, "the next launch has a directory of its own");
});

test("one boxed Claude session per run process, on the real adapter and box: a second at once is refused by name", { skip, timeout: 120_000 }, async (t) => {
  const run = mkdtempSync(join(tmpdir(), "serve-cbr-guard-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const fake = await fakeAnthropic({ reply: () => ({ text: "ok" }) });
  t.after(() => fake.close());
  mkdirSync(join(run, "runs", "g"), { recursive: true });
  const box = await runBox({ data: run, isolation: probed, runtimeDir: "/tmp" }, { id: "g", dir: join(run, "runs", "g") }, {});
  const adapter = oneBoxedClaude(claudeAgentAdapter({ model: MODEL, provider: { origin: fake.url, credential: () => KEY }, box }));
  const store = memorySessionStore();
  const io = async (key, dir) => ({ writer: await store.open(key), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {}, dir });
  mkdirSync(join(run, "a"), { recursive: true });
  const first = await adapter.open({ key: "a", label: "a", system: [], tools: [], context: "fresh" }, await io("a", join(run, "a")));
  await assert.rejects(adapter.open({ key: "b", label: "b", system: [], tools: [], context: "fresh" }, await io("b", join(run, "b"))), /a second boxed Claude session \(b\) in one run process while a is live: one run process holds one/);
  await first.close();
});

test("the CLI's config directory outside the session (TMPDIR not set inside it): the kernel's bind check refuses the start by name, the turn fails, and the process lives", { skip, timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "serve-cbr-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = join(root, "data", "runs", "o", "harness");
  mkdirSync(session, { recursive: true });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = mkdtempSync(join(root, "elsewhere-"));
  t.after(() => (saved === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = saved)));
  const fake = await fakeAnthropic({ reply: () => ({ text: "never reached" }) });
  t.after(() => fake.close());
  const box = await runBox({ data: join(root, "data"), isolation: probed, runtimeDir: "/tmp" }, { id: "o", dir: join(root, "data", "runs", "o") }, {});
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: fake.url, credential: () => KEY }, box });
  const store = memorySessionStore();
  const session1 = await adapter.open({ key: "o", label: "o", system: [], tools: [], context: "fresh" }, { writer: await store.open("o"), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {}, dir: session });
  await session1.send("Go.");
  const end = await session1.turnEnd();
  assert.equal(end.status, "failed", JSON.stringify(end));
  assert.match(end.error ?? "", /a child's bind \S+ is not under the session/, "the kernel's check names the refusal");
  assert.equal(fake.messages().length, 0, "no model request was made");
  await session1.close();
});
