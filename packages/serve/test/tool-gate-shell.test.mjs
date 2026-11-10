// The background tools (background.ts) run commands in the run's box as bash does, so bash's permission holds them:
// each maps to bash's settings key (tool-gate.ts settingsKeyOf), on every harness and under claude-agent's
// mcp__hands__ names, and none of them is a settings key of its own. bash: deny refuses bash and all five, saying they
// follow bash's setting. bash: allow runs them. Under bash: ask only the calls that start or feed a process ask
// (bash_background, bash_input, and bash itself), each parked under its own name, so an approval runs it, never bash.
// The calls that only watch or end a process this run started (bash_output, bash_list, bash_signal) run unasked, on
// this run's own ids only: another run's id, or one never started, is the tool's own "no background process" answer.
// capabilities and an agent's tools show the same split, so what the console shows is what the gate enforces.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_TOOLS } from "../dist/background.js";
import { permissionFrom, RunGate, settingsKeyOf, waitingText } from "../dist/tool-gate.js";
import { loadToolSettings, settingsIssues, TOOL_SETTINGS_KEY } from "../dist/tool-plane.js";
import { openSqliteStore, STORE_FILE } from "../dist/store/sqlite/store.js";
import { agent, call, cookieOf, follow, runDir, scratch, serve } from "./support.mjs";

/** pi's registration `name`, wrapped by a run's gate on `data`'s settings: what its call answers, whether it ran, and
 *  the requests the gate kept. */
async function onPi(t, settings, name, { overrides = {}, approvers = true } = {}) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  if (settings) await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const runGate = new RunGate({ root, work, data, runId: "r1", harness: "pi" }, overrides, true, approvers);
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { output: [{ type: "text", text: "ran" }] }) };
  const wrapped = runGate.extension([registration]).wraps.find((wrap) => wrap.tool === name)?.wrap(registration) ?? registration;
  const kept = [];
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const result = await wrapped.execute({ command: "sleep 1" }, api, {});
  return { text: (result.output ?? []).map((block) => block.text ?? "").join(""), isError: result.isError === true, ran, kept };
}

test("each background tool is held to bash's settings key, on every harness and as claude-agent's mcp__hands__ host tool, and is no settings key of its own", () => {
  assert.equal(BACKGROUND_TOOLS.length, 5);
  for (const name of BACKGROUND_TOOLS) {
    for (const harness of ["pi", "claude-agent", "codex", "opencode"]) assert.equal(settingsKeyOf(harness, name), "bash", `${harness} ${name}`);
    assert.equal(settingsKeyOf("claude-agent", `mcp__hands__${name}`), "bash", `mcp__hands__${name}`);
    assert.deepEqual(settingsIssues({ [name]: { permission: "deny" } }).map((issue) => [issue.field, issue.reason]), [[name, "not_allowed"]], `${name} is set by bash`);
  }
});

const STARTERS = ["bash_background", "bash_input"];
const WATCHERS = ["bash_output", "bash_list", "bash_signal"];

test("bash: deny refuses bash and each background tool, saying they follow bash's setting; bash: allow runs each", async (t) => {
  const bash = await onPi(t, { bash: { permission: "deny" } }, "bash");
  assert.deepEqual([bash.text, bash.isError, bash.ran], ["Permission denied: bash is set to deny on this server. It was not run: nothing was sent and nothing was charged. Don't retry it.", true, 0]);
  for (const name of BACKGROUND_TOOLS) {
    const denied = await onPi(t, { bash: { permission: "deny" } }, name);
    assert.deepEqual([denied.text, denied.isError, denied.ran], [`Permission denied: ${name} follows bash's setting, which is deny on this server. It was not run: nothing was sent and nothing was charged. Don't retry it.`, true, 0], name);
    const allowed = await onPi(t, { bash: { permission: "allow" } }, name);
    assert.deepEqual([allowed.text, allowed.ran, allowed.kept.length], ["ran", 1, 0], name);
  }
});

test("bash: ask parks only the calls that start or feed a process, each under its own name; bash_output, bash_list and bash_signal run unasked, even where no one can approve", async (t) => {
  for (const name of STARTERS) {
    const asked = await onPi(t, { bash: { permission: "ask" } }, name);
    // Its request keeps its own name, so the call an approval runs is its own, never bash's.
    assert.deepEqual([asked.text, asked.ran, asked.kept.map((entry) => entry.data?.tool)], [waitingText(name), 0, [name]], name);
  }
  for (const name of WATCHERS) {
    const ran = await onPi(t, { bash: { permission: "ask" } }, name);
    assert.deepEqual([ran.text, ran.isError, ran.ran, ran.kept.length], ["ran", false, 1, 0], `${name} runs unasked`);
    // Accounts off: nothing to approve, so it still runs, where bash_background is refused.
    const alone = await onPi(t, { bash: { permission: "ask" } }, name, { approvers: false });
    assert.deepEqual([alone.text, alone.ran], ["ran", 1], `${name} with no approver`);
  }
  const alone = await onPi(t, { bash: { permission: "ask" } }, "bash_background", { approvers: false });
  assert.deepEqual([alone.isError, alone.ran], [true, 0], "bash_background with no approver is refused");
  // The agent's own bash: ask over the server's allow gives the same split.
  assert.deepEqual((await onPi(t, { bash: { permission: "allow" } }, "bash_output", { overrides: { bash: { permission: "ask" } } })).ran, 1);
  assert.equal((await onPi(t, { bash: { permission: "allow" } }, "bash_background", { overrides: { bash: { permission: "ask" } } })).text, waitingText("bash_background"));
});

test("fail closed stays closed: with no settings ever read, the watchers ask as every tool does, parked, never run", async (t) => {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  // Cut off mid-write and never read whole: the gate has no settings, so its ask is its own, not bash's.
  await writeFile(join(data, "tool-settings.json"), '{"bash":{"permission":"as');
  const gate = new RunGate({ root, work, data, runId: "r1", harness: "pi" });
  for (const name of ["bash", ...BACKGROUND_TOOLS]) assert.equal(gate.policy(name), "ask", name);
  for (const name of WATCHERS) {
    const runGate = new RunGate({ root, work, data, runId: "r1", harness: "pi" });
    let ran = 0;
    const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { output: [{ type: "text", text: "ran" }] }) };
    const wrapped = runGate.extension([registration]).wraps.find((wrap) => wrap.tool === name).wrap(registration);
    const kept = [];
    const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
    const result = await wrapped.execute({ id: "1" }, api, {});
    assert.deepEqual([(result.output ?? []).map((block) => block.text ?? "").join(""), ran, kept.map((entry) => entry.data?.tool)], [waitingText(name), 0, [name]], name);
  }
});

/** What watcher `name`'s call does at a run's gate on `data` with agent `overrides`: its answer, whether it ran, its requests.
 *  `server`: the server's settings as a runner reads them from the store (loadToolSettings), in place of `data`'s file. */
async function watcherAt(t, data, name, overrides = {}, server) {
  const [root, work] = [await scratch(t), await scratch(t)];
  const runGate = new RunGate({ root, work, data, runId: "r1", harness: "pi" }, overrides, true, true, "ask", server ? () => server : undefined);
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { output: [{ type: "text", text: "ran" }] }) };
  const wrapped = runGate.extension([registration]).wraps.find((wrap) => wrap.tool === name).wrap(registration);
  const kept = [];
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const result = await wrapped.execute({ id: "1" }, api, {});
  return { text: (result.output ?? []).map((block) => block.text ?? "").join(""), ran, tools: kept.map((entry) => entry.data?.tool), policy: runGate.policy(name) };
}

test("only a valid ask set in a settings layer lets the watchers run unasked: bash set to a value not offered reads ask for bash and the watchers alike, from the server's file or the agent's own", async (t) => {
  const data = await scratch(t);
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ bash: { permission: "maybe" } }));
  for (const name of ["bash_output", "bash_signal"]) {
    const at = await watcherAt(t, data, name);
    assert.deepEqual([at.policy, at.text, at.ran, at.tools], ["ask", waitingText(name), 0, [name]], `server ${name}`);
  }
  const none = await scratch(t);
  for (const name of ["bash_output", "bash_signal"]) {
    const at = await watcherAt(t, none, name, { bash: { permission: "maybe" } });
    assert.deepEqual([at.policy, at.text, at.ran, at.tools], ["ask", waitingText(name), 0, [name]], `agent ${name}`);
  }
  // What capabilities and an agent's tools read: ask, never allow and never the value as written.
  for (const name of ["bash", ...BACKGROUND_TOOLS]) {
    assert.deepEqual(permissionFrom(name, {}, { bash: { permission: "maybe" } }), { permission: "ask", from: "agent" }, `agent ${name}`);
  }
  // A valid ask set in a layer still lets them run.
  assert.deepEqual(permissionFrom("bash_output", { bash: { permission: "ask" } }), { permission: "allow", from: "server" });
});

/** Puts the server's tool-settings row in the store at `data` before a server starts on it (it reads the row once, at start). */
async function plantToolSettings(data, settings) {
  const store = await openSqliteStore({ file: join(data, STORE_FILE), role: "server" });
  try {
    await store.settings.put(TOOL_SETTINGS_KEY, settings);
  } finally {
    await store.close();
  }
}

/** The store at `data` beside a live server, opened as a runner opens it: `read(store)`'s answer. */
async function besideServer(data, read) {
  const store = await openSqliteStore({ file: join(data, STORE_FILE), role: "runner" });
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

test("capabilities agree: a server whose stored settings set bash to a value not offered shows ask for bash and every background tool", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(data, { recursive: true });
  await plantToolSettings(data, { bash: { permission: "maybe" } });
  const { api } = await serve(t, { data });
  const caps = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool]));
  for (const name of ["bash", ...BACKGROUND_TOOLS]) assert.equal(caps[name].permission, "ask", `capabilities ${name}`);
  // The settings as served say what is in force, with nothing internal in them.
  const served = (await api("GET", "/settings/tools")).body;
  assert.deepEqual(served.bash, { permission: "ask" });
});

test("the stand-in for a value not offered survives a save of the whole map, an explicit ask, and a restart: the watchers still ask, and the stored row keeps the value as written", { timeout: 120_000 }, async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  await plantToolSettings(data, { bash: { permission: "maybe" } });
  const stored = () => besideServer(data, (store) => store.settings.get(TOOL_SETTINGS_KEY));
  const watchersAsk = async (api, at) => {
    const caps = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool]));
    for (const name of WATCHERS) assert.equal(caps[name].permission, "ask", `${at}: capabilities ${name}`);
    // A run's gate on the settings as its runner reads them from the store (runner/adapter-run-spec.ts loadToolSettings).
    const server = await besideServer(data, loadToolSettings);
    for (const name of ["bash_output", "bash_signal"]) {
      const gate = await watcherAt(t, data, name, {}, server);
      assert.deepEqual([gate.policy, gate.ran, gate.tools], ["ask", 0, [name]], `${at}: the gate ${name}`);
    }
    assert.equal((await stored())?.bash?.permission, "maybe", `${at}: the stored row keeps bash as written`);
  };
  await t.test("an unrelated save of the whole map, as the console sends it", async (t2) => {
    const { api } = await serve(t2, { data });
    const served = (await api("GET", "/settings/tools")).body;
    assert.deepEqual(served.bash, { permission: "ask" });
    const put = await api("PUT", "/settings/tools", { ...served, web_fetch: { ...served.web_fetch, permission: "deny" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await stored())?.web_fetch?.permission, "deny", "the change itself is saved");
    await watchersAsk(api, "after the save");
    // The owner's explicit ask is the same ask on the wire: it keeps the stand-in (the console's own control is the choice).
    assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "ask" } })).status, 200);
    await watchersAsk(api, "after an explicit ask");
  });
  // A restart reads the row again.
  const { api } = await serve(t, { data });
  await watchersAsk(api, "after a restart");
  // A different permission is a choice, written as given.
  assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "deny" } })).status, 200);
  assert.equal((await stored())?.bash?.permission, "deny");
});

test("no setting of a watcher's own lifts bash's deny or ask: a run's gate reads bash's key for each, under claude-agent's mcp__hands__ names too", async (t) => {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ bash: { permission: "deny" }, bash_output: { permission: "allow" } }));
  const lifted = new RunGate({ root, work, data, runId: "r1", harness: "pi" }, { bash_output: { permission: "allow" }, bash_signal: { permission: "allow" } });
  for (const name of [...WATCHERS, ...STARTERS]) assert.equal(lifted.policy(name), "deny", name);
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ bash: { permission: "ask" } }));
  const claude = new RunGate({ root, work, data, runId: "r1", harness: "claude-agent" }, { bash_background: { permission: "allow" } });
  for (const name of WATCHERS) assert.equal(claude.policy(`mcp__hands__${name}`), "allow", name);
  for (const name of STARTERS) assert.equal(claude.policy(`mcp__hands__${name}`), "ask", name);
  assert.equal(claude.policy("Bash"), "ask");
});

test("with bash: ask, capabilities and an agent's tools show ask for bash, bash_background and bash_input, and allow for the watchers, each from bash's setting, with bash's choices", async (t) => {
  const { api } = await serve(t);
  const byName = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "ask" } })).status, 200);
  const caps = byName((await api("GET", "/capabilities")).body.tools);
  for (const name of ["bash", ...STARTERS]) assert.deepEqual([caps[name].permission, caps[name].permissions], ["ask", caps.bash.permissions], `capabilities ${name}`);
  for (const name of WATCHERS) assert.deepEqual([caps[name].permission, caps[name].permissions], ["allow", caps.bash.permissions], `capabilities ${name}`);
  assert.ok(caps.bash.permissions.includes("ask"));
  const asks = await api("POST", "/agents", agent("asks", { place: { mode: "sandbox", box: "docker" }, tools: ["bash", ...BACKGROUND_TOOLS] }));
  assert.equal(asks.status, 201, JSON.stringify(asks.body));
  const shown = byName((await api("GET", "/agents/asks")).body.tools);
  for (const name of ["bash", ...STARTERS]) assert.deepEqual([shown[name]?.permission, shown[name]?.permission_from], ["ask", "server"], `agent ${name}`);
  for (const name of WATCHERS) assert.deepEqual([shown[name]?.permission, shown[name]?.permission_from], ["allow", "server"], `agent ${name}`);
  const made = await api("POST", "/agents", agent("boxed", { place: { mode: "sandbox", box: "docker" }, tools: ["bash", ...BACKGROUND_TOOLS], tool_settings: { bash: { permission: "deny" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const own = byName((await api("GET", "/agents/boxed")).body.tools);
  for (const name of ["bash", ...BACKGROUND_TOOLS]) assert.deepEqual([own[name]?.permission, own[name]?.permission_from], ["deny", "agent"], `agent ${name}`);
});

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const SHELL = ["bash", ...BACKGROUND_TOOLS];
const json = { "content-type": "application/json" };
/** A test password, not a real one. */
const pw = (name) => `not-a-secret-${name}`;

/** Each tool call of run `runId` and its answer, in order, from its store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError === true, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}

/** A probe run of agent `id` (bash's tools in a faux box) on `server`, making `plan`'s calls in order. */
async function probe(server, id, plan) {
  const run = await server.api("POST", `/agents/${id}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

const groupAlive = (group) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

test("bash: ask, end to end: bash_background parks and the owner allows it; its output pages, the list and a TERM run unasked; bash_input parks again; one approval per start or feed", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX, accounts: true, openSetup: true });
  const { api } = server;
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: pw("owner") } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const approve = async (runId, approvalId) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body: { decision: "allow" } })).status;
  assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "ask" } })).status, 200);
  const made = await api("POST", "/agents", { definition: { id: "bg", name: "bg", instructions: "Probe.", place: SANDBOX, tools: SHELL } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const plan = [
    { tool: "bash_background", args: { command: "printf 'one\\n'; read line; printf 'got:%s\\n' \"$line\"; sleep 30" } },
    { tool: "bash", args: { command: "sleep 1" } },
    { tool: "bash_output", args: { id: "1", max_bytes: 2 } },
    { tool: "bash_output", args: { id: "1", offset: 2 } },
    { tool: "bash_list", args: {} },
    { tool: "bash_input", args: { id: "1", text: "hello\n" } },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
    { tool: "bash_output", args: { id: "1" } },
  ];
  const runId = await probe(server, "bg", plan);
  const asked = [];
  for (const expected of ["bash_background", "bash", "bash_input"]) {
    await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
    const view = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([view.pending?.kind, view.pending?.tool], ["approval", expected], JSON.stringify(view.pending));
    asked.push(view.pending.tool);
    assert.equal(await approve(runId, view.pending.id), 204);
    // The answer is acted on before the next park is read.
    for (const end = Date.now() + 20_000; (await api("GET", `/runs/${runId}`)).body.pending?.id === view.pending.id; ) {
      assert.ok(Date.now() < end, `the ${expected} approval is acted on`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  // Exactly three approvals: the start, bash, and the feed. The pages, the list and the TERM asked nothing.
  assert.deepEqual(asked, ["bash_background", "bash", "bash_input"]);
  const said = answers(server.data, runId).filter((answer) => !answer.text.includes("waits for a person's approval"));
  const watched = said.filter((answer) => WATCHERS.includes(answer.tool));
  assert.deepEqual(watched.map((answer) => [answer.tool, answer.error]), [["bash_output", false], ["bash_output", false], ["bash_list", false], ["bash_signal", false], ["bash_output", false]], JSON.stringify(said));
  assert.match(watched[0].text, /^Background process 1 is running\. Output bytes 0 to 2 of 4; call again with offset 2/);
  assert.match(watched[3].text, /^Sent TERM to background process 1: it ended by signal TERM \(exit code 143\)\.$/);
  assert.match(watched[4].text, /\n\none\ngot:hello\n/);
});

test("the watchers reach only this run's own processes: another run's id, live in its own box, is the tool's own no-such answer, and nothing of it is read or signalled", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX });
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "ask" } })).status, 200);
  const made = await api("POST", "/agents", { definition: { id: "bg", name: "bg", instructions: "Probe.", place: SANDBOX, tools: SHELL, tool_settings: { bash: { permission: "allow" } } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const other = await api("POST", "/agents", { definition: { id: "watcher", name: "watcher", instructions: "Probe.", place: SANDBOX, tools: SHELL } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  // Run A starts a process and stays up while run B looks for it.
  const runA = await probe(server, "bg", [{ tool: "bash_background", args: { command: "echo a-secret-line; sleep 30" } }, { tool: "bash", args: { command: "sleep 25" } }]);
  const pidFile = join(runDir(server.data, runA), "work", "background", "1", "pid");
  for (const end = Date.now() + 30_000; !existsSync(pidFile); ) {
    assert.ok(Date.now() < end, "run A's process started");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const group = Number(readFileSync(pidFile, "utf8"));
  // Run B, bash: ask from the server: its watchers run unasked, on its own ids only (it has none), plus a made-up id.
  const runB = await probe(server, "watcher", [
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_signal", args: { id: "1", signal: "KILL" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_output", args: { id: "77" } },
  ]);
  await follow(api, runB, ["completed"], { deadlineMs: 60_000 });
  const said = answers(server.data, runB);
  assert.deepEqual(said.map((answer) => [answer.tool, answer.error]), [["bash_output", true], ["bash_signal", true], ["bash_list", false], ["bash_output", true]], JSON.stringify(said));
  assert.match(said[0].text, /there is no background process 1 in this run: bash_list shows them/);
  assert.match(said[1].text, /there is no background process 1 in this run: bash_list shows them/);
  assert.equal(said[2].text, "No background processes in this run's box: bash_background starts one.");
  assert.match(said[3].text, /there is no background process 77 in this run/);
  assert.ok(!said.some((answer) => answer.text.includes("a-secret-line")), "nothing of run A's log is read");
  assert.ok(groupAlive(group), "run A's process is not signalled");
  await follow(api, runA, ["completed"], { deadlineMs: 60_000 });
});
