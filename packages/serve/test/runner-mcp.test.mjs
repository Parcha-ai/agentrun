// Remote MCP tools on the runner (runner/mcp-run.ts through runner/adapter-loop.ts): a pi run claimed by a runner, its
// MCP claim step (runner/mcp-claim.ts) at the claim, one gateway per loop from that step, pi's tools for the pinned
// tools, every call through the loop's one gate (allow, ask, deny; an ask parks the run and an approve resumes it) and
// then the gateway (pin, meta refusal, unopened refusal, URL check per call, prices under the run's cap, not-metered
// booking). The credentials stay in the loop's memory: no byte of one in the store file, its WAL or a log line.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { closeOpenSessions, MODEL, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { beforeRequestOf, cap as kernelCap, rootEntries, SONNET, specCap } from "./adapter-pi-cap-support.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { permissionOf } = await import("../dist/tool-gate.js");
const { deniedText } = await import("../dist/runner/loop-contract.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { META_REASON } = await import("../dist/mcp-meta.js");
const { UNUSABLE } = await import("../dist/mcp-servers.js");
const { TOOL_COST, TOOL_UNMETERED } = await import("@parcha/pi-durable-agent/timeline");
const { journalRecords } = await import("../dist/runner/journal-reader.js");

test.after(() => closeOpenSessions());

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"runner-mcp-bearer-for-the-scan"}`;
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const PAID = { name: "paid", description: "A call the server bills.", inputSchema: object({ query: { type: "string" } }) };
const META = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run any tool by slug.", inputSchema: { type: "object", properties: {} } };
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = (url, key = KEY) => sealMcpCredential(key, "fake", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, url);
const toolCalls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && (tool === undefined || entry.tool === tool));
/** The text of the newest tool result the model was sent. */
const lastResult = (sent) => {
  const results = sent.flatMap((body) => body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};

/**
 * A store with the fake MCP server saved as "fake" and run-1 queued, and a runner on the adapter loop running pi on
 * `script` with the run's MCP (`grants`), its gate the tool gate's permissions over `settings` (an mcp: tool asks by
 * default). Runs until the run is not running, or `until(row)` says so.
 */
async function mcpRun(t, { script, grants, settings = {}, tools = [ADD, PAID], prices, seal = headers, capUsd, before, until, ms = 20_000, hostTools = {}, events }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const fake = await startFakeMcp({ token: TOKEN });
  let runner;
  t.after(async () => {
    await runner?.close();
    await fake.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools, ...(prices ? { prices } : {}), sealed: seal(fake.url) });
  await server.agents.create({ id: "agent-1", name: "Mcp" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await before?.({ server, store, fake });
  const sent = [];
  const origin = scriptedOrigin(script, sent);
  const base = piAdapterSpec({ script, tools: hostTools, hooks: { beforeIntent: async () => {}, beforeResult: async () => {} } }, { fetch: events ? (...args) => (events.push("request"), origin(...args)) : origin });
  // `events`: each registry read of the claim step's (store.mcp.server, which its fresh() makes per pinned server) and
  // each model request, in order.
  const registry = events ? new Proxy(store.mcp, { get: (target, key) => (key === "server" ? (...args) => (events.push("read"), target.server(...args)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : store.mcp;
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const loop = createAdapterLoop(async (claim, run) => {
    // The run's priced-step cap beside the model booking's, one spend for both (as workflow-spec.ts wires its decisions').
    const toolCap = capUsd === undefined ? undefined : kernelCap.createCap({ capUsd: () => capUsd });
    return {
      ...(await base(claim, run)),
      workRoot: work,
      gate: (call) => permissionOf(call.tool, settings),
      mcp: { grants, store: { mcp: registry, runs: store.runs }, sealKey: KEY, ...(toolCap ? { cap: toolCap } : {}) },
      ...(capUsd === undefined ? {} : {
        cap: specCap(capUsd),
        beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: (id) => (id === MODEL ? SONNET : undefined), spentUsd: () => toolCap.spentUsd(), heldUsd: () => toolCap.heldUsd() }),
      }),
    };
  }, { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...STEADY });
  const settle = async (done = (row) => row.state !== "running" && row.state !== "queued" && row.runner === null) => {
    const from = Date.now();
    for (;;) {
      const row = await server.runs.get("run-1");
      if (done(row)) return row;
      if (Date.now() - from > ms) return row;
      await sleep(20);
    }
  };
  const row = await settle(until);
  return { row, sent, fake, server, store, dir, settle };
}

/** Every entry of run-1's journal, read without a claim of its own. */
async function journalOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}
/** The data of each entry of `kind` in run-1's journal. */
const entriesOf = async (server, kind) => (await journalOf(server)).filter((entry) => entry.kind === kind).map((entry) => entry.data);
const asks = (server) => entriesOf(server, KINDS.ask);

test("R1: an allowed MCP call answers, goes once with its credential, and is booked not metered on the run's root", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const { row, sent, fake, server, store } = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), "5");
  assert.deepEqual((await rootEntries(store, TOOL_UNMETERED)).map((data) => data.tool), ["mcp:fake/add"], "booked on the run's root conversation");
  assert.equal(toolCalls(fake, "add").length, 1, "sent once");
  assert.equal(toolCalls(fake, "add")[0].authorization, true, "with its credential");
  const unmetered = await entriesOf(server, TOOL_UNMETERED);
  assert.deepEqual(unmetered.map((data) => ({ tool: data.tool, charged_by: data.charged_by })), [{ tool: "mcp:fake/add", charged_by: "fake" }]);
  assert.deepEqual(await entriesOf(server, TOOL_COST), [], "no cost booked");
});

test("R2: by default an MCP call asks: the run parks on it with nothing sent, its card priced not metered; Allow runs it exactly once", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 4, b: 5 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"] });
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent while it waits");
  const [ask] = await asks(run.server);
  assert.equal(ask.tool, "mcp:fake/add");
  assert.deepEqual(ask.args, { a: 4, b: 5 });
  assert.equal(ask.price, "not metered");
  await run.server.command("run-1", { kind: "approve", body: { approval: ask.callId } });
  const row = await run.settle((r) => r.state === "ended" || r.state === "failed");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(run.sent), "9");
  assert.equal(toolCalls(run.fake, "add").length, 1, "run exactly once");
});

test("R3: a denied MCP call is told in words, and nothing is sent", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 1, b: 1 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"] });
  assert.equal(run.row.state, "parked");
  const [ask] = await asks(run.server);
  await run.server.command("run-1", { kind: "deny", body: { approval: ask.callId, note: "not today" } });
  const row = await run.settle((r) => r.state === "ended" || r.state === "failed");
  assert.equal(row.state, "ended", JSON.stringify(row));
  // pi frames a blocked call's words as its harness's error; the words are the loop's.
  assert.ok(lastResult(run.sent).includes(`Tool call blocked: ${deniedText("mcp:fake/add", "not today")}`), lastResult(run.sent));
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
});

test("R4: a set-to-deny MCP call is refused in words before its intent, and nothing is sent", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 1, b: 1 } }, { sayLastResult: true }];
  const { row, sent, fake } = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "deny" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(lastResult(sent).includes("Tool call blocked: Permission denied: mcp:fake/add is set to deny."), lastResult(sent));
  assert.equal(toolCalls(fake).length, 0);
});

test("R5: no byte of a credential in the store file, its WAL, or any log line after a run that called the server", async (t) => {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  const writeOut = process.stdout.write.bind(process.stdout);
  const log = console.log, error = console.error, warn = console.warn;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), writeOut(chunk, ...rest));
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  t.after(() => ((process.stderr.write = write), (process.stdout.write = writeOut), (console.log = log), (console.error = error), (console.warn = warn)));
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 2 } }, { sayLastResult: true }];
  const { row, fake, store, server, dir } = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } } });
  assert.equal(row.state, "ended");
  assert.equal(toolCalls(fake, "add")[0]?.authorization, true, "the call went with its credential");
  await store.flush();
  await server.flush();
  const { readdirSync } = await import("node:fs");
  let read = 0;
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name));
    read += 1;
    assert.equal(bytes.includes(Buffer.from(TOKEN, "utf8")), false, `no byte of the credential in ${name}`);
  }
  assert.ok(read > 0, "the store's files were read");
  assert.deepEqual(lines.filter((line) => line.includes(TOKEN)), [], "nor in any log line");
});

test("R6: a credential that does not open refuses the call unsent, in words", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const other = randomBytes(32);
  const { row, sent, fake } = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } }, seal: (url) => headers(url, other) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), `The MCP server fake's credential can't be used right now: ${UNUSABLE.damaged}.`);
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
});

test("R7: a pinned tool that is a meta tool now refuses the claim in words: the run fails with nothing sent", async (t) => {
  const script = [{ call: "mcp__fake__COMPOSIO_MULTI_EXECUTE_TOOL", args: {} }, { say: "done" }];
  const { row, sent, fake } = await mcpRun(t, {
    script,
    grants: ["mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL"],
    tools: [META],
    // A pin made before the tool was known as a meta tool (the list grows after runs are pinned).
    before: async ({ server, fake }) => {
      const claim = await server.claim("run-1", "runner-earlier", { leaseMs: 60_000 });
      await server.mcp.pinOnce(claim, { fake: { url: fake.url, tools: [META] } });
      await server.release(claim);
    },
  });
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.equal(row.summary, `mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${META_REASON}`);
  assert.equal(sent.length, 0, "no model request");
  assert.equal(fake.log.length, 0, "nothing sent to the MCP server");
});

test("R8: a server whose URL changed since the run was pinned refuses each call unsent, in words", async (t) => {
  const moved = await startFakeMcp({ token: TOKEN });
  t.after(() => moved.close());
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"] });
  assert.equal(run.row.state, "parked");
  // Moved while the run waits: its pin keeps the address it started with.
  await run.server.mcp.put({ name: "fake", url: moved.url, auth: "bearer", tools: [ADD, PAID], sealed: headers(moved.url) });
  const [ask] = await asks(run.server);
  await run.server.command("run-1", { kind: "approve", body: { approval: ask.callId } });
  const row = await run.settle((r) => r.state === "ended" || r.state === "failed");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(run.sent), "The MCP server fake's address changed since this run started; nothing was sent. Start a new run to use it at its new address.");
  assert.equal(toolCalls(run.fake).length + toolCalls(moved).length, 0, "nothing sent to either address");
});

test("R9: a priced MCP call the run's cap has no room for is refused unsent and parks the run on a raise", async (t) => {
  const script = [{ call: "mcp__fake__paid", args: { query: "q" } }, { sayLastResult: true }];
  const { row, sent, fake, server } = await mcpRun(t, { script, grants: ["mcp:fake/paid"], settings: { "mcp:fake/paid": { permission: "allow" } }, prices: { paid: 0.5 }, capUsd: 0.1 });
  assert.equal(row.state, "parked", JSON.stringify(row));
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
  // The model's next request is refused with the call's refusal (the turn ends on it), so the provider never reads the
  // result: the call's answer is in the journal.
  assert.equal(sent.length, 1, "no request after the refusal reached the provider");
  assert.match(JSON.stringify(await journalOf(server)), /spend_cap_reached: Not sent: [^"]*the next step, mcp:fake\/paid, could cost up to \$0\.50 \(the price its owner set for mcp:fake\/paid\)/);
  const [budget] = await entriesOf(server, KINDS.budget);
  assert.ok(budget, "parked at its cap with a pending budget");
  assert.ok(budget.pending.least_cap_usd >= 0.5, JSON.stringify(budget));
  assert.deepEqual(await entriesOf(server, TOOL_COST), [], "nothing booked");
});

test("R10: a priced MCP call with room is sent once and booked at its price on the run's root", async (t) => {
  const script = [{ call: "mcp__fake__paid", args: { query: "q" } }, { sayLastResult: true }];
  const { row, sent, fake, server } = await mcpRun(t, { script, grants: ["mcp:fake/paid"], settings: { "mcp:fake/paid": { permission: "allow" } }, prices: { paid: 0.5 }, capUsd: 5 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), "paid for q");
  assert.equal(toolCalls(fake, "paid").length, 1);
  const costs = await entriesOf(server, TOOL_COST);
  assert.deepEqual(costs.map((data) => ({ tool: data.tool, usd: data.usd })), [{ tool: "mcp:fake/paid", usd: 0.5 }]);
});

test("R11: a command row handed to a running loop makes its MCP credentials fresh again before its next model request", async (t) => {
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  const events = [];
  let server;
  const hostTools = { wait: { name: "wait", replaySafe: false, run: async () => (events.push("tool"), await waiting, "waited") } };
  const script = [{ call: "wait", args: {} }, { say: "done" }];
  const running = mcpRun(t, { script, grants: ["mcp:fake/add"], hostTools, events, before: async (opened) => void (server = opened.server) });
  for (const from = Date.now(); !events.includes("tool") && Date.now() - from < 10_000; ) await sleep(20);
  assert.deepEqual(events, ["read", "request", "tool"], "made fresh once at the claim, before the first request");
  // A steer while the call runs: taken by the loop, which holds the claim.
  const steer = await server.command("run-1", { kind: "steer", body: { text: "and then stop" } });
  for (const from = Date.now(); Date.now() - from < 10_000; await sleep(20)) if ((await server.commands("run-1", 0)).find((row) => row.id === steer.id)?.takenAt) break;
  release();
  const { row } = await running;
  assert.equal(row.state, "ended", JSON.stringify(row));
  const tool = events.indexOf("tool");
  const next = events.indexOf("request", tool);
  assert.ok(next > tool, JSON.stringify(events));
  assert.deepEqual(events.slice(tool + 1, next), ["read"], "made fresh again before the next request");
});
