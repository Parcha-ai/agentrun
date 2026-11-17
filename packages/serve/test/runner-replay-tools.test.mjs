// A replay run's tools (runner/promotion.ts, learn/replay-calls.ts, SPEC B4) through the runner, on a pi run of the faux
// gateway and a fake MCP server whose every call needs a per_run credential:
//   - a write step whose arguments match the replayed run's recorded call is never sent: the recorded answer is used;
//   - a read step runs live once a replay, then is cached (two steps of the same read, one call);
//   - the replay run has the agent's credentials as a served run does: the per_run token the claimed run was handed,
//     sealed for the replay alone; nothing of it is printed or logged;
//   - a write whose arguments the recording does not have is never sent: that input is skipped (skipped_write), neither
//     wrong nor failed, and a check whose every input was skipped had nothing to check it on: it stops in those words.
// The runner is a local install's (mcpLoopback): the fake MCP server listens on loopback.
// The agent's earlier runs are real runs of the agent (no learning, so no workflow serves them): each calls the write
// itself, which is what its journal records, and each is an input of the revision's check.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore, sealRunMcpAuth } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { seedOf } = await import("../dist/learning.js");

const SEAL_KEY = Buffer.alloc(32, 9);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const TOKEN = `not-a-secret-${"replay-tools-per-run-token"}`;
const FINAL = ["ended", "failed", "stopped"];
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", input_schema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const DELETE = { name: "delete_thing", description: "Delete a thing by id.", input_schema: object({ id: { type: "string" } }), annotations: { destructiveHint: true } };

/** Two reads of the same sum (one live call a replay), then the write, its answer the output's `deleted`. */
const flow = {
  v: 2, name: "tidy",
  schemas: {
    In: { type: "object", required: ["a", "b", "id"], properties: { a: { type: "number" }, b: { type: "number" }, id: { type: "string" } } },
    Sum: { type: "number" },
    Gone: { type: "object" },
  },
  input: { schemaId: "In" }, output: { schemaId: "Sum", path: "sum" },
  root: { node: "chain", steps: [
    { node: "call", label: "sum", via: "tool", tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" }, out: "Sum", as: "sum", deadline_s: 60 },
    { node: "call", label: "sum again", via: "tool", tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" }, out: "Sum", as: "again", deadline_s: 60 },
    { node: "call", label: "delete", via: "tool", tool: "mcp:fake/delete_thing", args: { id: "{id}" }, out: "Gone", as: "gone", deadline_s: 60 },
  ] },
};
const FLOWS = [{ name: "tidy", description: "Sums two numbers and deletes the thing", workflow: flow }];

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Every line written to stdout, stderr or the console from here until the test ends. */
function captureLines(t) {
  const lines = [];
  const [write, writeOut] = [process.stderr.write.bind(process.stderr), process.stdout.write.bind(process.stdout)];
  const { log, error, warn } = console;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), writeOut(chunk, ...rest));
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  t.after(() => ((process.stderr.write = write), (process.stdout.write = writeOut), (console.log = log), (console.error = error), (console.warn = warn)));
  return lines;
}

/** An agent granted the fake server's add and delete_thing (per_run: every call needs the token a run is handed), that
 *  learned `tidy`; `prior` real runs of it before, each deleting a thing (`deletes` of the one its job names). */
async function world(t, { prior = 5, deletes = (id) => id, tools = [ADD, DELETE] } = {}) {
  const lines = captureLines(t);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-replay-tools-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const fake = await startFakeMcp({ token: TOKEN });
  // The agent's model: a job names its thing (`job <n>: delete <id>`); it deletes `deletes(id)` once, then says the sum.
  const gw = await startFauxGateway({
    call: ({ body }) => {
      const offered = (body?.tools ?? []).some((tool) => tool?.name === "mcp__fake__delete_thing");
      const answered = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
      const id = /delete ([\w-]+)/.exec(JSON.stringify(body?.messages ?? []))?.[1];
      return offered && !answered && id ? { name: "mcp__fake__delete_thing", input: { id: deletes(id) } } : undefined;
    },
    text: ({ body }) => `${/sum (\d+)/.exec(JSON.stringify(body?.messages ?? []))?.[1] ?? "?"}`,
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await fake.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.mcp.put({ name: "fake", url: fake.url, auth: "per_run", tools, sealed: null });
  await server.agents.create({ id: "agent-1", name: "Tidies" }, { id: "rev-1", kind: "agentic", body: { instructions: "Delete the thing, say the sum.", tools: ["mcp:fake/add", "mcp:fake/delete_thing"], toolSettings: { "mcp:fake/*": { permission: "allow" } }, learning: true } });
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  const handed = (id) => sealRunMcpAuth(SEAL_KEY, id, { fake: { headers: { authorization: `Bearer ${TOKEN}` }, origin: new URL(fake.url).origin } });
  const inputOf = (n, id) => ({ content: `job ${n}: delete ${id}, then say the sum ${n + n + 1}`, a: n, b: n + 1, id });
  const launchOf = (n, id, learning) => ({ input: inputOf(n, id), title: `job ${n}`, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learning ? { learning: startAt(learning) } : {}) });
  const logs = [];
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, mcpLoopback: true, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const start = async (id, n, thing, learning = true) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(n, thing, learning ? (await seedOf(dir, "agent-1")).sha : undefined), sealed: handed(id) });
    return ended(id);
  };
  // The agent's earlier runs: the agent alone (no learning laid), each deleting its thing live, then saying its sum.
  for (let i = 0; i < prior; i += 1) {
    const row = await start(`prior-${i}`, i, `thing-${i}`, false);
    assert.equal(row.state, "ended", JSON.stringify(row));
  }
  const calls = (tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);
  assert.equal(calls("delete_thing").length, prior, "each earlier run deleted its thing once, live");
  const replays = async () => (await server.runs.list({ agentId: "agent-1" })).filter((row) => !/^(run|prior)-/.test(row.id));
  const replaysEnded = (n) => until(async () => {
    const all = await replays();
    return all.length === n && all.every((row) => FINAL.includes(row.state) && row.runner === null) && all;
  }, `the ${n} replay runs ended`);
  return { server, store, fake, gw, logs, lines, start, replays, replaysEnded, calls, seed };
}

test("a replay answers its write from the replayed run's recording, never sending it; its read runs live once, then cached; its per_run credential is the claimed run's; nothing is printed", { timeout: 180_000 }, async (t) => {
  const { server, fake, logs, lines, start, replaysEnded, calls } = await world(t);
  // The replays start as run-1 is claimed: what the fake saw is counted from before it.
  const deletedBefore = calls("delete_thing").length;
  const addsBefore = calls("add").length;
  const first = await start("run-1", 7, "thing-7");
  assert.equal(first.metrics?.path, "agent", `the agent takes the run while its workflow is checked: ${JSON.stringify(first.metrics)}\n${logs.join("\n")}`);
  const runs = await replaysEnded(5);
  for (const row of runs) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.path, "replay");
    assert.equal(row.metrics?.replay?.outcome, "answered", `answered on its own input: ${JSON.stringify(row.metrics)}\n${logs.join("\n")}`);
  }
  assert.equal(calls("delete_thing").length, deletedBefore + 1, "run-1's agent deleted its thing; no replay sent the write: each was answered from its replayed run's recording");
  assert.equal(calls("add").length - addsBefore, 5, "each replay's read ran live once: its second step of the same read was the cache's");
  assert.ok(calls("add").every((entry) => entry.authorization), "every live read carried the per_run credential");
  // Every replay said what the agent said: promoted on the next run, which the workflow serves.
  const second = await start("run-2", 8, "thing-8");
  assert.equal(second.metrics?.path, "workflow", JSON.stringify(second.metrics));
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, agreed: decided.check.agreed, skipped_write: decided.check.outcomes.skipped_write }, { decided: "promote", n: 5, agreed: 5, skipped_write: 0 }, JSON.stringify(decided));
  const said = [...logs, ...lines, JSON.stringify(await promotionsOf(server.settings, "agent-1")), JSON.stringify(runs), JSON.stringify(fake.log)].join("\n");
  assert.equal(said.includes(TOKEN), false, "the credential is never printed, logged or recorded");
});

test("a write whose arguments the recording does not have is never sent: the input is skipped; every input skipped holds the revision in those words", { timeout: 180_000 }, async (t) => {
  // The earlier runs deleted other things than their inputs name: no recorded write matches what the workflow asks.
  const { server, start, replaysEnded, calls, logs } = await world(t, { deletes: (id) => `${id}-old` });
  const deletedBefore = calls("delete_thing").length;
  await start("run-1", 7, "thing-7");
  const runs = await replaysEnded(5);
  for (const row of runs) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.replay?.outcome, "skipped_write", JSON.stringify(row.metrics));
    assert.deepEqual(row.metrics.replay.skipped, { tool: "mcp:fake/delete_thing", step: "delete" });
  }
  assert.equal(calls("delete_thing").length, deletedBefore + 1, "run-1's agent deleted its thing; no replay sent a write");
  const second = await start("run-2", 8, "thing-8");
  assert.equal(second.metrics?.path, "agent", `held: the agent takes the run: ${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, skipped_write: decided.check.outcomes.skipped_write, stopped: decided.check.stopped }, { decided: "hold", n: 0, skipped_write: 5, stopped: true });
  assert.equal(decided.reason, "nothing to check it on: 5 inputs skipped because each needs a write the recording doesn't have (a check never runs a write). It is not promoted, and it stops: nothing compiles again until a hold or its owner acts");
  assert.deepEqual(decided.check.skipped_tools, [{ tool: "mcp:fake/delete_thing", inputs: 5, no_read_only_hint: false }], "a destructive tool: a write, never a missing hint");
  assert.doesNotMatch(decided.reason, /readOnlyHint/);
});

test("an MCP tool its server lists with no annotations stops every input: held, and the reason names it and says readOnlyHint, never a data problem", { timeout: 180_000 }, async (t) => {
  // The live smoke's case: a read tool listed without annotations. The earlier runs never called it, so nothing recorded.
  const { annotations: _none, ...bare } = ADD;
  const { server, start, replaysEnded, calls, logs } = await world(t, { tools: [bare, DELETE] });
  const addsBefore = calls("add").length;
  await start("run-1", 7, "thing-7");
  const runs = await replaysEnded(5);
  for (const row of runs) {
    assert.equal(row.metrics?.replay?.outcome, "skipped_write", JSON.stringify(row.metrics));
    assert.deepEqual(row.metrics.replay.skipped, { tool: "mcp:fake/add", step: "sum", unmarked: true });
  }
  assert.equal(calls("add").length, addsBefore, "an unmarked tool is never sent in a replay");
  const second = await start("run-2", 8, "thing-8");
  assert.equal(second.metrics?.path, "agent", `held: the agent takes the run: ${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, skipped_write: decided.check.outcomes.skipped_write, skipped_tools: decided.check.skipped_tools, stopped: decided.check.stopped }, { decided: "hold", n: 0, skipped_write: 5, skipped_tools: [{ tool: "mcp:fake/add", inputs: 5, no_read_only_hint: true }], stopped: true });
  assert.equal(decided.reason, "nothing to check it on: 5 inputs skipped because add has no readOnlyHint, so replay can't run it: if it only reads, mark it read-only in the MCP server. It is not promoted, and it stops: nothing compiles again until a hold or its owner acts");
});
