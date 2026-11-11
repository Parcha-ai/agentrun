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
import { rootEntries, SONNET, specCap } from "./adapter-pi-cap-support.mjs";

/** A tool as the registry keeps it: as its server listed it (input_schema). */
const listed = ({ inputSchema, ...tool }) => ({ ...tool, input_schema: inputSchema });
const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { permissionOf } = await import("../dist/tool-gate.js");
const { deniedText } = await import("../dist/runner/loop-contract.js");
const { deniedText: setToDenyText } = await import("../dist/refusal-words.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { META_REASON } = await import("../dist/mcp-meta.js");
const { TOOL_COST, TOOL_UNMETERED } = await import("@parcha/pi-durable-agent/timeline");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { GITHUB_UNUSABLE } = await import("../dist/runner/mcp-github.js");

test.after(() => closeOpenSessions());

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"runner-mcp-bearer-for-the-scan"}`;
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const SLOW = { name: "slow_write", description: "Write a line after a wait.", inputSchema: object({ line: { type: "string" }, seconds: { type: "number" } }) };
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
async function mcpRun(t, { script, grants, settings = {}, tools = [ADD, PAID], prices, seal = headers, capUsd, before, until, ms = 20_000, hostTools = {}, events, onCommand, network, auth = "bearer", fakeToken = TOKEN, githubAppAccess, launchInput, timing = STEADY, opened = [], serverNow, inspect, beforeIntent = async () => {} }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-"));
  // `serverNow`: the test's own handle on the store reads its clock (a claim taken over when it is moved past the lease);
  // the runner's handle keeps the wall clock.
  const server = await openSqliteStore({ dataDir: dir, role: "server", ...(serverNow ? { now: serverNow } : {}) });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const fake = await startFakeMcp({ token: fakeToken, ...(inspect ? { inspect } : {}) });
  let runner;
  t.after(async () => {
    await runner?.close();
    await fake.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.mcp.put({ name: "fake", url: fake.url, auth, tools: tools.map(listed), ...(prices ? { prices } : {}), sealed: auth === "github_app" ? null : seal(fake.url) });
  await server.agents.create({ id: "agent-1", name: "Mcp" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await before?.({ server, store, fake });
  const sent = [];
  const origin = scriptedOrigin(script, sent);
  const base = piAdapterSpec({ script, tools: hostTools, hooks: { beforeIntent, beforeResult: async () => {} } }, { fetch: events ? (...args) => (events.push("request"), origin(...args)) : origin });
  // `events`: each model request, in order with whatever else the test pushes there.
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const loop = createAdapterLoop(async (claim, run) => {
    // As a spec builder does: the claim's MCP first (mcpForClaim), before anything the spec would have to let go.
    const mcp = await mcpForClaim({ claim, store: { mcp: store.mcp, runs: store.runs, settings: store.settings, triggerSettings: store.triggerSettings, where: store.where }, sealKey: KEY, grants, harness: run.harness, work: () => work, ...(network ? { network } : {}), ...(githubAppAccess ? { githubAppAccess, launchInput, githubMcpOrigin: new URL(fake.url).origin } : {}) });
    if (mcp) opened.push(mcp);
    return {
      ...(await base(claim, run)),
      workRoot: work,
      // `settings` as a function: the run's own gate as a run's spec makes it (adapterRunGate over the store's
      // settings), made for the claim; else the plain permission of `settings`.
      gate: typeof settings === "function" ? await settings({ store, claim, work }) : (call) => permissionOf(call.tool, settings),
      ...(mcp ? { mcp } : {}),
      ...(capUsd === undefined ? {} : {
        cap: specCap(capUsd),
        runCap: { capUsd: () => capUsd, modelOf: (id) => (id === MODEL ? SONNET : undefined) },
      }),
    };
  }, { restartLimit: MAX_RESTARTS });
  // `onCommand`: told each command row the loop is handed, once the loop has taken it in.
  const createLoop = onCommand ? (deps) => {
    const made = loop(deps);
    return { ...made, start: (claim) => made.start(claim), stop: (reason) => made.stop(reason), command: (command) => {
      const out = made.command(command);
      onCommand(command);
      return out;
    } };
  } : loop;
  runner = startRunner({ store, createLoop, name: "runner-a", ...timing });
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

/** Every line written to stdout, stderr or the console from here until the test ends. */
function captureLines(t) {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  const writeOut = process.stdout.write.bind(process.stdout);
  const log = console.log, error = console.error, warn = console.warn;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), writeOut(chunk, ...rest));
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  t.after(() => ((process.stderr.write = write), (process.stdout.write = writeOut), (console.log = log), (console.error = error), (console.warn = warn)));
  return lines;
}

/** No byte of `secret` in any file of the data directory (the store file, its WAL) or in `lines`. */
async function assertNowhere(secret, { store, server, dir }, lines) {
  await store.flush();
  await server.flush();
  const { readdirSync } = await import("node:fs");
  let read = 0;
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name));
    read += 1;
    assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `no byte of the credential in ${name}`);
  }
  assert.ok(read > 0, "the store's files were read");
  assert.deepEqual(lines.filter((line) => line.includes(secret)), [], "nor in any log line");
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
  // The call's error result is main's words, by the call's catalog name.
  assert.equal(lastResult(run.sent), deniedText("mcp:fake/add", "not today"));
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
});

test("R4: a set-to-deny MCP call is refused in words before its intent, and nothing is sent", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 1, b: 1 } }, { sayLastResult: true }];
  const { row, sent, fake } = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "deny" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), setToDenyText("mcp:fake/add"));
  assert.equal(toolCalls(fake).length, 0);
});

test("R4b: an MCP call outside its server's argument pin is refused in the pin's words before it is asked or sent, through the run's own gate", async (t) => {
  // The server's setting allows the tool pinned to a = 2; the model calls it with a = 5. The gate is the one a run's spec
  // gives it (adapterRunGate, over the store's tool settings).
  const script = [{ call: "mcp__fake__add", args: { a: 5, b: 1 } }, { sayLastResult: true }];
  const { row, sent, fake } = await mcpRun(t, {
    script,
    grants: ["mcp:fake/add"],
    before: ({ server }) => server.settings.put("tool-settings", { "mcp:fake/add": { permission: "allow", pin: { a: 2 } } }),
    settings: ({ store, claim, work }) => adapterRunGate(store, claim, { kind: "agentic", body: {} }, work),
  });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const said = lastResult(sent);
  assert.match(said, /mcp:fake\/add/, said);
  assert.match(said, /a = 2/, `the pin's words: ${said}`);
  assert.match(said, /nothing was sent and nothing was charged/, said);
  assert.equal(toolCalls(fake).length, 0, "the server got nothing");
});

test("R5: no byte of a credential in the store file, its WAL, or any log line after a run that called the server", async (t) => {
  const lines = captureLines(t);
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 2 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } } });
  assert.equal(run.row.state, "ended");
  assert.equal(toolCalls(run.fake, "add")[0]?.authorization, true, "the call went with its credential");
  await assertNowhere(TOKEN, run, lines);
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
  await run.server.mcp.put({ name: "fake", url: moved.url, auth: "bearer", tools: [listed(ADD), listed(PAID)], sealed: headers(moved.url) });
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
  assert.equal((await journalOf(server)).some((entry) => entry.kind === "runner.turn" && entry.data.usd === 0.5), false, "nothing booked");
});

test("R10: a priced MCP call with room is sent once, held at its price and booked at it on the run's one ledger", async (t) => {
  const script = [{ call: "mcp__fake__paid", args: { query: "q" } }, { sayLastResult: true }];
  const { row, sent, fake, server } = await mcpRun(t, { script, grants: ["mcp:fake/paid"], settings: { "mcp:fake/paid": { permission: "allow" } }, prices: { paid: 0.5 }, capUsd: 5 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), "paid for q");
  assert.equal(toolCalls(fake, "paid").length, 1);
  // The run's paid calls' session (the kernel cap's TOOL_SESSION): its hold before it left, then its booking.
  const entries = await journalOf(server);
  const held = entries.find((entry) => entry.kind === "runner.request" && entry.data.model === "paid:mcp:fake/paid");
  assert.equal(held?.data.heldUsd, 0.5, "held at its price before it left");
  const booked = entries.find((entry) => entry.kind === "runner.turn" && entry.conversationId === held.conversationId && entry.data.turn === held.data.turn);
  assert.equal(booked?.data.usd, 0.5, "booked at its price");
  // Booked once: on the one ledger, never again by the gateway's own marks on the run's root.
  assert.equal(entries.filter((entry) => entry.kind === "runner.request" && entry.data.model === "paid:mcp:fake/paid").length, 1, "one hold");
  assert.deepEqual(await entriesOf(server, TOOL_COST), [], "no second booking on the run's root");
});

// The money fence on the runner's path: a priced MCP call, not replay-safe, has its intent made durable (side-effects.ts,
// the flush before a call that is not replay-safe) and then its hold (the run's ledger, the flush before a paid request
// leaves) before it reaches its server. So a box lost once the server has it neither runs it again (its intent is on
// disk: the next claim ends it interrupted) nor loses its charge (its hold is on disk: the next claim counts it). Read
// from the order on a real store and runner: the moment its intent is about to be written, each flush of the runner's
// store (noting whether the call's hold was already committed when it began), and the moment the fake server receives it.
test("R10b: a priced MCP call reaches its server only after a flush of its intent and then a flush of its hold", async (t) => {
  const script = [{ call: "mcp__fake__paid", args: { query: "q" } }, { sayLastResult: true }];
  const events = [];
  let fake;
  let server;
  const held = async () => (await journalOf(server)).some((entry) => entry.kind === "runner.request" && entry.data.model === "paid:mcp:fake/paid");
  const before = async (world) => {
    ({ fake, server } = world);
    const flush = world.store.flush.bind(world.store);
    world.store.flush = async () => {
      const withHold = await held();
      await flush();
      events.push(withHold ? "flushed with the hold" : "flushed");
    };
  };
  // Called as the fake logs a request, before it answers: the call has left the runner.
  const inspect = () => {
    const last = fake.log.at(-1);
    if (last?.method === "tools/call" && last.tool === "paid") events.push("sent");
  };
  const beforeIntent = async (call) => void (call.tool === "mcp:fake/paid" && events.push("intent"));
  const { row } = await mcpRun(t, { script, grants: ["mcp:fake/paid"], settings: { "mcp:fake/paid": { permission: "allow" } }, prices: { paid: 0.5 }, capUsd: 5, before, inspect, beforeIntent });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const sent = events.indexOf("sent");
  assert.ok(sent > 0, `the call reached its server once: ${JSON.stringify(events)}`);
  assert.equal(events.filter((event) => event === "sent").length, 1, `once: ${JSON.stringify(events)}`);
  const between = events.slice(events.indexOf("intent") + 1, sent);
  assert.ok(events.indexOf("intent") >= 0 && events.indexOf("intent") < sent, `its intent came first: ${JSON.stringify(events)}`);
  assert.deepEqual(between, ["flushed", "flushed with the hold"], `between its intent and its send: its intent's flush, then its hold's: ${JSON.stringify(events)}`);
});

/** An OAuth sign-in's token set, its authorization server at auth.example.com, its access token ending at `expires`. */
const oauthSet = (access, expires) => ({
  tokens: { access_token: access, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-for"}-${access}` },
  obtained_at: new Date(expires - 3_600_000).toISOString(),
  expires_at: new Date(expires).toISOString(),
  client: { client_id: "runner-test", client_secret: "s3" },
  kind: "pre-registered",
  discovery: { authorizationServerUrl: "https://auth.example.com", authorizationServerMetadata: { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", response_types_supported: ["code"] } },
});
const sealedOAuth = (url, set) => sealMcpCredential(KEY, "fake", { type: "oauth", set }, url);

test("R11: a command row handed to a running loop makes its MCP credentials fresh again before its next model request", async (t) => {
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  let toolRuns;
  const toolRan = new Promise((resolve) => (toolRuns = resolve));
  let steerTaken;
  const taken = new Promise((resolve) => (steerTaken = resolve));
  const events = [];
  let server;
  let fakeUrl;
  // The authorization server, as the claim step's network: each refresh pushed in order with the model's requests.
  const network = {
    lookup: async () => ["93.184.216.34"],
    fetch: async () => {
      events.push("token");
      return new Response(JSON.stringify({ access_token: `not-a-secret-${"refreshed-access"}`, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const hostTools = { wait: { name: "wait", replaySafe: false, run: async () => (events.push("tool"), toolRuns(), await waiting, "waited") } };
  const script = [{ call: "wait", args: {} }, { say: "done" }];
  const running = mcpRun(t, {
    script, grants: ["mcp:fake/add"], hostTools, events, network, auth: "oauth",
    seal: (url) => sealedOAuth(url, oauthSet(`not-a-secret-${"valid-access"}`, Date.now() + 3_600_000)),
    onCommand: (command) => command.kind === "steer" && steerTaken(),
    before: async (opened) => void ((server = opened.server), (fakeUrl = opened.fake.url)),
  });
  await toolRan;
  assert.deepEqual(events, ["request", "tool"], "a token still valid at the claim: no refresh before the first request");
  // While the call runs, the server's token runs out (its row now holds a set past its end), and a steer comes: taken by
  // the loop, which holds the claim.
  await server.mcp.put({ name: "fake", url: fakeUrl, auth: "oauth", tools: [listed(ADD), listed(PAID)], sealed: sealedOAuth(fakeUrl, oauthSet(`not-a-secret-${"ran-out-access"}`, Date.now() - 60_000)) });
  await server.command("run-1", { kind: "steer", body: { text: "and then stop" } });
  await taken;
  release();
  const { row } = await running;
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(events, ["request", "tool", "token", "request"], "the run-out token refreshed before the next request");
});

test("R12: a resumed claim calls the tools its run was pinned with, read as written, after the registry changed", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 4, b: 5 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"] });
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  // While the run waits, a refresh of the server lists other tools: `add` is gone from the registry.
  await run.server.mcp.put({ name: "fake", url: run.fake.url, auth: "bearer", tools: [listed(PAID)], sealed: headers(run.fake.url) });
  const [ask] = await asks(run.server);
  await run.server.command("run-1", { kind: "approve", body: { approval: ask.callId } });
  const row = await run.settle((r) => r.state === "ended" || r.state === "failed");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(run.sent), "9", "the pinned tool ran");
  assert.equal(toolCalls(run.fake, "add").length, 1, "once");
  assert.deepEqual((await run.server.mcp.pin("run-1")).body.fake.tools.map((tool) => tool.name), ["add"], "the pin row is as written");
});

test("R13: a claim lost while a call is out drops the gateway's credentials at once: the call is cut upstream, a late call sends nothing, and the next claim never sends it again", async (t) => {
  // Both sides are the test's own, never two wall-clock timers raced under load (what failed here: a 600 ms lease, renewed
  // every 100 ms and given up 200 ms early, ran out while a loaded machine was still setting the claim up, before the call
  // went out). The call is held open until the test lets it go, and the claim is lost when the test takes it over on its
  // own handle's clock, past a lease long enough that it never runs out by itself.
  const opened = [];
  let server;
  let fakeRef;
  let skew = 0;
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const script = [{ call: "mcp__fake__slow_write", args: { line: "x", seconds: 5 } }, { say: "done" }];
  const running = mcpRun(t, {
    script, grants: ["mcp:fake/slow_write"], settings: { "mcp:fake/slow_write": { permission: "allow" } }, tools: [SLOW], opened,
    timing: { leaseMs: 60_000, renewEveryMs: 100, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 20 },
    serverNow: () => Date.now() + skew,
    before: async (got) => {
      server = got.server;
      fakeRef = got.fake;
      // slow_write answers only when the test lets it go: the call stays out until the claim is lost.
      got.fake.tools.slow_write = { ...got.fake.tools.slow_write, run: async ({ line }) => (await held, { content: [{ type: "text", text: `wrote ${line}` }] }) };
    },
  });
  for (const from = Date.now(); !(fakeRef && toolCalls(fakeRef, "slow_write").length) && Date.now() - from < 30_000; ) await sleep(10);
  assert.equal(toolCalls(fakeRef, "slow_write").length, 1, "the call is out");
  // The claim is taken over on the store, its lease past by the test's clock: the runner's next renewal is fenced, and
  // the claim is lost mid-call.
  skew = 120_000;
  const takeover = await server.claim("run-1", "takeover", { leaseMs: 60_000 });
  assert.ok(takeover, "the run's claim taken over");
  for (const from = Date.now(); !fakeRef.log.some((entry) => entry.closed === "slow_write") && Date.now() - from < 30_000; ) await sleep(10);
  assert.ok(fakeRef.log.some((entry) => entry.closed === "slow_write"), "the call was cut upstream");
  // The pinned tool as pi holds it (its host tool): a dropped claim's gateway sends nothing.
  const after = await opened[0].tools.find((tool) => tool.name === "mcp__fake__slow_write").call({ line: "y", seconds: 0 }, { signal: new AbortController().signal, callId: "late" });
  assert.equal(after.isError, true, "a dropped claim's gateway sends nothing");
  assert.equal(toolCalls(fakeRef, "slow_write").length, 1, "nothing more reached the server");
  // The takeover gives the run back: the runner claims it again, and its next claim opens its own MCP.
  skew = 0;
  await server.release(takeover);
  const { row } = await running;
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(opened.length >= 2, "the next claim opened its own MCP");
  assert.equal(toolCalls(fakeRef, "slow_write").length, 1, "the cut call is never sent again");
});

const GH_TOKEN = `not-a-secret-${"github-installation-token"}`;

test("R14: a github_app server's token is minted for the claim from the run's launch input and the call answers; the token is in no store file or log line", async (t) => {
  const lines = captureLines(t);
  const asked = [];
  const githubAppAccess = async (store, sealKey, input) => {
    asked.push({ input, sealKey: sealKey !== undefined, reads: typeof store.triggerSettings?.get === "function" });
    return { mint: async (target) => (asked.push({ target }), { ok: true, token: GH_TOKEN, expires_at: Date.now() + 3_600_000 }), target: { repo: "acme/widgets" } };
  };
  const launchInput = { content: "Fix https://github.com/acme/widgets" };
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } }, auth: "github_app", fakeToken: GH_TOKEN, githubAppAccess, launchInput });
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.equal(lastResult(run.sent), "5");
  assert.deepEqual(asked[0], { input: launchInput, sealKey: true, reads: true }, "asked with the store, the seal key and the launch input");
  assert.deepEqual(asked[1], { target: { repo: "acme/widgets" } }, "minted for the run's repository");
  assert.equal(toolCalls(run.fake, "add")[0]?.authorization, true);
  await assertNowhere(GH_TOKEN, run, lines);
});

test("R15: a github_app server on a server with no GitHub App refuses the call unsent, in GITHUB_UNUSABLE.noAccess's words", async (t) => {
  const script = [{ call: "mcp__fake__add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const run = await mcpRun(t, { script, grants: ["mcp:fake/add"], settings: { "mcp:fake/add": { permission: "allow" } }, auth: "github_app", fakeToken: GH_TOKEN, githubAppAccess: async () => undefined, launchInput: { content: "go" } });
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.equal(lastResult(run.sent), `The MCP server fake's credential can't be used right now: ${GITHUB_UNUSABLE.noAccess}.`);
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
});
