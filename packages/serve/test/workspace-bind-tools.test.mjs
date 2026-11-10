// A registry bound to a run (serve/src/workspace/run-tools.ts bindTools): the registry's tools the run names, as the
// kernel's HostTool an adapter's session takes, each call through the run's gate first and its answer rendered as a host
// tool's has always been: the output, the failure's words, the diagnostics; a path in an error, a write's or an edit's
// answer named relative to the run's folder. The registry here is a stand-in over the run's own executors, shaped as the
// kernel's (run-adapters kernel/registry): its definitions, words and limits are not this test's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools } from "../dist/host-tools.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { bashTool, fileTools, piEnv } from "../dist/workspace/pi-env.js";
import { bindTools, runHands } from "../dist/workspace/run-tools.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-bind-tools-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  return root;
}
/** A stand-in registry: definitions for the four host tools, each run by the run's own executor. */
function registryOf(run, calls = []) {
  const defs = ["read", "write", "edit", "bash"].map((name) => ({ name, description: `the ${name} tool`, parameters: { type: "object", properties: { [name]: {} } }, replaySafe: name === "read" }));
  return {
    list: () => defs,
    async invoke(name, args, call) {
      calls.push([name, args, call.hands === run.hands]);
      if (name === "boom") throw new Error(`boom at ${run.cwd}/x`);
      return run.executors[name](args, call);
    },
  };
}
const signal = () => new AbortController().signal;

test("bound: the registry's tools the run names, in the run's order, with their words, schema and replay; a name it has not is left out", async () => {
  const run = await runHands(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  const tools = bindTools(run, registryOf(run), ["bash", "read", "web_fetch", "write"]);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay, tool.description, tool.inputSchema]), [
    ["bash", "never", "the bash tool", { type: "object", properties: { bash: {} } }],
    ["read", "safe", "the read tool", { type: "object", properties: { read: {} } }],
    ["write", "never", "the write tool", { type: "object", properties: { write: {} } }],
  ]);
});

test("bound: a call's text is today's host tool's for the same call on the same files, a path named relative to the run's folder (bash on a Mode 2 run: a Mode 1 run with no computer has none)", async () => {
  const [left, right] = [scratch(), scratch()];
  const leftEnv = piEnv(localWorkspace(left), { cwd: left, env: { PATH: "/usr/bin:/bin" }, defaultTimeoutS: 120 });
  const today = Object.fromEntries(hostTools({ env: async () => leftEnv }, ["read", "write", "edit", "bash"], ctx, new Map(), [...fileTools(), bashTool()]).map((tool) => [tool.name, tool]));
  const run = await runHands(localWorkspace(right), undefined, { mode: 1, context: ctx });
  // bash on Archil's exec (Mode 2), here over the same folder: its texts name no path.
  const shell = await runHands(localWorkspace(right), undefined, { mode: 2, context: ctx });
  const results = new Map();
  const bound = Object.fromEntries([
    ...bindTools(run, registryOf(run), ["read", "write", "edit"], { results }),
    ...bindTools(shell, registryOf(shell), ["bash"], { results }),
  ].map((tool) => [tool.name, tool]));
  const cases = [
    ["read", { path: "a.txt" }], ["read", { path: "nope.txt" }], ["read", { path: "../x" }], ["write", { path: "w.txt", content: "w" }],
    ["edit", { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }], ["edit", { path: "a.txt", edits: [{ oldText: "zzz", newText: "2" }] }],
    ["bash", { command: "echo hi" }], ["bash", { command: "echo out; exit 3" }], ["bash", { command: "echo before; sleep 30", timeout: 1 }],
  ];
  for (const [name, args] of cases) {
    // Each side names its own folder: the texts are compared with it taken out.
    const plain = (text, root) => text.replaceAll(root, "<folder>");
    const expected = await today[name].call(args, { callId: `l-${name}`, signal: signal() });
    const actual = await bound[name].call(args, { callId: `r-${name}-${JSON.stringify(args)}`, signal: signal() });
    assert.deepEqual({ ...actual, text: plain(actual.text, right) }, { ...expected, text: plain(expected.text, left) }, `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(results.get(`r-${name}-${JSON.stringify(args)}`), actual, "kept for the run's timeline by its call id");
  }
});

test("bound: each call passes the run's gate first; a refused one runs nothing, a parked one says so; a replayed attempt tells the gate; a thrown failure is the answer's text", async () => {
  const root = scratch();
  const run = await runHands(localWorkspace(root), undefined, { mode: 1, context: ctx });
  const calls = [];
  const registry = registryOf(run, calls);
  const entered = [];
  const verdicts = { write: { text: "denied", isError: true }, bash: { text: "waits for a person", isError: false, parked: true } };
  const park = { commit: async () => undefined };
  const gate = { enter: async (name, args, callId, given, options) => (entered.push([name, callId, given === park, options]), verdicts[name]) };
  const tools = Object.fromEntries(bindTools(run, { ...registry, list: () => [...registry.list(), { name: "boom", description: "", parameters: {}, replaySafe: false }] }, ["read", "write", "bash", "boom"], { gated: { gate, park } }).map((tool) => [tool.name, tool]));
  assert.deepEqual(await tools.write.call({ path: "w.txt", content: "w" }, { callId: "c1", signal: signal() }), { text: "denied", isError: true });
  assert.deepEqual(await tools.bash.call({ command: "touch ran" }, { callId: "c2", signal: signal() }), { text: "waits for a person", isError: false, parked: true });
  assert.deepEqual(calls, [], "neither ran");
  const read = await tools.read.call({ path: "a.txt" }, { callId: "c3", signal: signal(), attempt: 1 });
  assert.equal(read.text, "one\ntwo\n");
  assert.deepEqual(entered, [["write", "c1", true, {}], ["bash", "c2", true, {}], ["read", "c3", true, { replayed: true }]]);
  assert.deepEqual(calls.map(([name, , hands]) => [name, hands]), [["read", true]], "the registry is invoked with the run's hands");
  assert.deepEqual(await tools.boom.call({}, { callId: "c4", signal: signal() }), { text: "boom at x", isError: true }, "a thrown failure, its path relative to the run's folder");
});
