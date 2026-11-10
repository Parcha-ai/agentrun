// Remote MCP tools on the runner for a harness with its own MCP client (AdapterCapabilities.mcpClient: Claude Code, Codex):
// the loop hands the session's MCP in the session's spec (runner/mcp-run.ts `session`), the kernel's model proxy mounts
// it once at `/mcp/<server>` from the adapter's client fact (startModelProxy's `mcp`), and the CLI's client calls it
// there with the session's key. Each call asks the loop's gate first (by its catalog name), then runs as the loop's host
// tool: its start and end on the run's record, the gateway sending it with the credential the CLI never sees. Here the
// CLI is a stand-in that speaks MCP to the real door as Claude Code's client does (`_meta["claudecode/toolUseId"]`).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

/** A tool as the registry keeps it: as its server listed it (input_schema). */
const listed = ({ inputSchema, ...tool }) => ({ ...tool, input_schema: inputSchema });
const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { permissionOf } = await import("../dist/tool-gate.js");
const { waitingText } = await import("../dist/tool-gate.js");
const { deniedText } = await import("../dist/runner/loop-contract.js");
const { deniedText: setToDenyText } = await import("../dist/refusal-words.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { TOOL_UNMETERED } = await import("@parcha/pi-durable-agent/timeline");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { STOPPED_WHILE_WAITING } = await import("../dist/refusal-words.js");
const { INTERRUPTED_TEXT } = await import("@parcha/agentrun-kernel/kernel");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"runner-mcp-cli-bearer-for-the-scan"}`;
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const CALL_ID = "toolu_cli_1";
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in with its own MCP client (Claude Code's call-id key): its session's proxy mounts the session's MCP, and
 *  its one turn calls `add` there over HTTP, then says what the door answered. `seen` keeps what it was handed. */
function mcpCli(seen, { reissue = false } = {}) {
  const client = { callIdMeta: "claudecode/toolUseId" };
  return {
    id: "stand-in-cli",
    capabilities: () => ({ mcpClient: client }),
    check: () => [],
    async open(spec, io) {
      seen.spec = spec;
      const proxy = await startModelProxy({
        policy: anthropicPolicy({ model: "claude-test", tools: [] }),
        hooks: io.models,
        model: "claude-test",
        origin: "https://faux.invalid",
        credential: async () => "not-a-secret-provider",
        ...(spec.mcp ? { mcp: { session: spec.mcp, client } } : {}),
      }, randomBytes(32).toString("base64url"));
      // `reissue`: a session opened again after its turn was cut (sent, never done) is open; its recover() runs the turn
      // again, issuing the same call under the same id, as a CLI's own resume does.
      const kept = await io.writer.read();
      const sentBefore = kept.some((record) => record.kind === "stand-in.sent");
      let state = !sentBefore ? "new" : reissue && !kept.some((record) => record.kind === "stand-in.done") ? "open_turn" : "idle";
      let turn;
      const callTurn = async () => {
        const response = await fetch(`${proxy.url}/mcp/fake`, {
          method: "POST",
          headers: { authorization: `Bearer ${proxy.key}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 }, _meta: { [client.callIdMeta]: CALL_ID } } }),
        });
        const body = await response.json();
        seen.answer = body.result;
        await io.writer.append([{ kind: "stand-in.done", data: null }]);
        io.onEvent({ type: "text", delta: `It said ${body.result?.content?.[0]?.text}.` });
        io.onEvent({ type: "turn_end", status: "completed" });
        return { status: "completed" };
      };
      return {
        get state() { return state; },
        async send(text) {
          // The resume message for a call that parked (main's [tool approval] words): kept, and the turn says it heard it.
          if (text.startsWith("[tool approval] ")) {
            (seen.followUps ??= []).push(text);
            turn = (async () => {
              io.onEvent({ type: "text", delta: "Resumed." });
              io.onEvent({ type: "turn_end", status: "completed" });
              return { status: "completed" };
            })();
            return;
          }
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = callTurn();
        },
        async recover() {
          state = "idle";
          turn = callTurn();
        },
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        // Closed once its turn has heard the door's answer: a call that parks is answered (main's waiting words) before
        // the session closes, and the CLI keeps what it heard.
        async close() {
          await turn?.catch(() => undefined);
          await proxy.close().catch(() => undefined);
        },
      };
    },
  };
}

async function cliRun(t, { settings = {}, grants = ["mcp:fake/add"], before, gateOf, wrap = (store) => store, timing = STEADY, reissue = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-cli-"));
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
  await server.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools: [listed(ADD)], sealed: sealMcpCredential(KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  await server.agents.create({ id: "agent-1", name: "Cli" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await before?.({ server });
  const seen = {};
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async () => ({ text: "found" }) };
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-cli-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const loop = createAdapterLoop(async (claim, run) => {
    const mcp = await mcpForClaim({ claim, store, sealKey: KEY, grants, harness: run.harness, work: () => work });
    return {
      adapter: mcpCli(seen, { reissue }),
      session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
      input: "Add them.",
      record: "loop",
      hooks: quiet,
      // `gateOf`: the run's own gate as a run's spec makes it (adapterRunGate over the store's settings), else the plain
      // permission of `settings`.
      gate: gateOf ? await gateOf({ store, claim, work }) : (call) => permissionOf(call.tool, settings),
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      ...(mcp ? { mcp } : {}),
    };
  });
  // `wrap`: the first runner's store as a case sees it (a commit held, the way a crash would stop it); `timing` its claim.
  runner = startRunner({ store: wrap(store), createLoop: loop, name: "runner-a", ...timing });
  /** The run once it is no longer running (or once `done` says so), and its journal's entries. */
  const settled = async (done = (row) => row.state !== "running" && row.state !== "queued" && row.runner === null) => {
    const from = Date.now();
    let row;
    for (;;) {
      row = await server.runs.get("run-1");
      if (done(row) || Date.now() - from > 20_000) break;
      await sleep(20);
    }
    const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
    return { row, entries };
  };
  /** The runner goes (closed while the run is parked: it holds no claim) and another starts on the same store. */
  const replaceRunner = async () => {
    await runner.close();
    runner = startRunner({ store, createLoop: loop, name: "runner-b", ...STEADY });
  };
  /** The runner dies where it stands (no release, its claim left to run out) and another starts on the same store, which
   *  claims the run once that claim has run out. */
  const crashRunner = () => {
    runner.kill();
    runner = startRunner({ store, createLoop: loop, name: "runner-b", ...timing });
  };
  return { ...(await settled()), seen, fake, server, settled, replaceRunner, crashRunner };
}

const toolCalls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

test("C1: the CLI's session carries the run's MCP, not its tools as host tools; an allowed call through the door answers, sent once with the credential the CLI never held, on the run's record", async (t) => {
  const { row, seen, fake, entries } = await cliRun(t, { settings: { "mcp:fake/add": { permission: "allow" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(seen.spec.mcp.servers.map((server) => ({ name: server.name, tools: server.tools.map((tool) => tool.name) })), [{ name: "fake", tools: ["add"] }]);
  assert.deepEqual(seen.spec.tools.map((tool) => tool.name), ["lookup"], "the MCP tools are the CLI's own client's, not host tools");
  assert.equal(JSON.stringify(seen.spec).includes(TOKEN), false, "no credential in what the CLI was handed");
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: "5" }] });
  assert.equal(toolCalls(fake).length, 1, "sent once");
  assert.equal(toolCalls(fake)[0].authorization, true, "with its credential");
  const start = entries.find((entry) => entry.kind === KINDS.callStart)?.data;
  const end = entries.find((entry) => entry.kind === KINDS.callEnd)?.data;
  assert.equal(start?.callId, CALL_ID, "the call's start on the run's record, by the CLI's own id");
  assert.equal(end?.status, "done");
  assert.equal(end?.output, "5");
  assert.deepEqual(entries.filter((entry) => entry.kind === TOOL_UNMETERED).map((entry) => entry.data.tool), ["mcp:fake/add"]);
});

test("C2: a call set to ask parks the run with nothing sent, the CLI answered main's waiting words; the owner's Allow runs it exactly once and the session goes on with its result", async (t) => {
  const run = await cliRun(t);
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  // The run parks on the ask and its session closes once the CLI heard the door's answer: the waiting words (the door
  // sends no parked flag).
  assert.deepEqual(run.seen.answer, { content: [{ type: "text", text: waitingText("mcp:fake/add") }] });
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent while it waits");
  const [ask] = run.entries.filter((entry) => entry.kind === KINDS.ask).map((entry) => entry.data);
  assert.deepEqual([ask?.callId, ask?.tool, ask?.price], [CALL_ID, "mcp:fake/add", "not metered"], "asked by the CLI's own call id, as main's card");
  await run.server.command("run-1", { kind: "approve", body: { approval: CALL_ID } });
  const { row, entries } = await run.settled((row) => row.state === "ended" && row.runner === null);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(toolCalls(run.fake).length, 1, "run exactly once");
  assert.equal(run.seen.followUps?.length, 1, "one resume message");
  assert.ok(run.seen.followUps[0].startsWith(`[tool approval] This answers your mcp:fake/add call ${CALL_ID} (arguments {"a":2,"b":3})`), run.seen.followUps[0]);
  assert.ok(run.seen.followUps[0].endsWith("They allowed it, and it ran. Its result:\n5"), run.seen.followUps[0]);
  assert.equal(entries.find((entry) => entry.kind === KINDS.callEnd)?.data.output, "5", "the approved call on the run's record");
});

test("C4: a parked call the owner denies is told in their words, and nothing is ever sent", async (t) => {
  const run = await cliRun(t);
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  await run.server.command("run-1", { kind: "deny", body: { approval: CALL_ID, note: "not today" } });
  const { row } = await run.settled((row) => row.state === "ended" && row.runner === null);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
  assert.ok(run.seen.followUps?.[0]?.endsWith(`\n${deniedText("mcp:fake/add", "not today")}`), run.seen.followUps?.[0]);
});

test("C3: a call set to deny is refused in the gate's words, nothing sent", async (t) => {
  const { seen, fake } = await cliRun(t, { settings: { "mcp:fake/add": { permission: "deny" } } });
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: setToDenyText("mcp:fake/add") }], isError: true });
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
});

test("C3b: a CLI's call outside its server's argument pin is refused in the pin's words before it is asked or sent, through the run's own gate", async (t) => {
  // The server's setting allows the tool pinned to a = 7; the CLI calls it with a = 2.
  const { seen, fake } = await cliRun(t, {
    before: ({ server }) => server.settings.put("tool-settings", { "mcp:fake/add": { permission: "allow", pin: { a: 7 } } }),
    gateOf: ({ store, claim, work }) => adapterRunGate(store, claim, { kind: "agentic", body: {} }, work),
  });
  const said = seen.answer?.content?.[0]?.text ?? "";
  assert.equal(seen.answer?.isError, true, JSON.stringify(seen.answer));
  assert.match(said, /mcp:fake\/add/, said);
  assert.match(said, /a = 7/, `the pin's words: ${said}`);
  assert.match(said, /nothing was sent and nothing was charged/, said);
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
});

test("C5: a parked call across a new runner: the runner that parked it goes, another claims it at the owner's Allow and runs it exactly once", async (t) => {
  const run = await cliRun(t);
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  await run.replaceRunner();
  await run.server.command("run-1", { kind: "approve", body: { approval: CALL_ID } });
  const { row } = await run.settled((row) => row.state === "ended" && row.runner === null);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.runner, null);
  assert.equal(toolCalls(run.fake).length, 1, "run exactly once");
  assert.ok(run.seen.followUps?.[0]?.endsWith("They allowed it, and it ran. Its result:\n5"), run.seen.followUps?.[0]);
});

test("C6: a run that grants no MCP tool hands its CLI no MCP server, and the server sees nothing", async (t) => {
  const run = await cliRun(t, { grants: [] });
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.equal(run.seen.spec.mcp, undefined, "no session MCP, so no /mcp door is mounted");
  assert.deepEqual(run.fake.log.filter((entry) => ["tools/call", "initialize", "server/discover"].includes(entry.method)), [], "the server saw nothing of the run");
});

// A call parked at its gate through the CLI's own client is on the run's record from its park (its start, marked
// parked), and only a durable sent mark, committed before the send, says it may have left: the record never calls a
// parked call interrupted unless it carries that mark.
const SHORT = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const SENT = "agentrun.call.sent";
const ofCall = (entries, kind) => entries.filter((entry) => entry.kind === kind && entry.data?.callId === CALL_ID).map((entry) => entry.data);

/** `store` with the commit that carries a call's sent mark passed through `onSent(commit)`: it gets the commit to run,
 *  and may hold before it (a crash before the mark) or after it (a crash between the mark and the send). */
function sentWatched(store, onSent) {
  const journalOf = (journal) => new Proxy(journal, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "commit") return typeof value === "function" ? value.bind(target) : value;
      return (...args) => (JSON.stringify(args[0] ?? null)?.includes(`"${SENT}"`) ? onSent(() => value.apply(target, args)) : value.apply(target, args));
    },
  });
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "journal") return (...args) => journalOf(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Resolves once `check` holds, polling. */
const reached = async (check, what, ms = 20_000) => {
  for (const from = Date.now(); !(await check()); await sleep(20)) assert.ok(Date.now() - from < ms, what);
};

test("P1: a parked call is on the record from its park, unsent; Allow sends it once, its real result goes to the session, one start", async (t) => {
  const run = await cliRun(t);
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  assert.deepEqual(ofCall(run.entries, KINDS.callStart).map((data) => data.parked), [true], "one start, marked parked");
  assert.deepEqual([ofCall(run.entries, SENT).length, ofCall(run.entries, KINDS.callEnd).length], [0, 0], "not sent, not ended");
  await run.server.command("run-1", { kind: "approve", body: { approval: CALL_ID } });
  await reached(async () => (await run.server.runs.get("run-1")).state === "ended", "the run ends");
  const { entries } = await run.settled();
  assert.equal(toolCalls(run.fake).length, 1, "sent once");
  assert.ok(run.seen.followUps?.[0]?.endsWith("\n5"), run.seen.followUps?.[0]);
  assert.deepEqual([ofCall(entries, KINDS.callStart).length, ofCall(entries, SENT).length], [1, 1], "one start, one sent mark");
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => [data.status, data.output]), [["done", "5"]]);
});

test("P2: an allowed parked call whose runner dies before its sent mark is sent once by the next runner, never interrupted", async (t) => {
  let hit;
  const atMark = new Promise((resolve) => (hit = resolve));
  const run = await cliRun(t, { timing: SHORT, wrap: (store) => sentWatched(store, () => (hit(), new Promise(() => {}))) });
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  await run.server.command("run-1", { kind: "approve", body: { approval: CALL_ID } });
  await atMark;
  run.crashRunner();
  await reached(async () => (await run.server.runs.get("run-1")).state === "ended", "the next runner ends the run");
  const { entries } = await run.settled();
  assert.equal(toolCalls(run.fake).length, 1, "sent once, by the next runner");
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => [data.status, data.output]), [["done", "5"]], "its real result, not interrupted");
  assert.ok(run.seen.followUps?.at(-1)?.endsWith("\n5"), run.seen.followUps?.at(-1));
});

test("P6: an allowed parked call whose runner dies after its sent mark, before the send, ends interrupted and is never sent again", async (t) => {
  let hit;
  const atMark = new Promise((resolve) => (hit = resolve));
  const run = await cliRun(t, { timing: SHORT, wrap: (store) => sentWatched(store, async (commit) => {
    const landed = await commit();
    hit();
    await new Promise(() => {});
    return landed;
  }) });
  await run.server.command("run-1", { kind: "approve", body: { approval: CALL_ID } });
  await atMark;
  run.crashRunner();
  await reached(async () => (await run.server.runs.get("run-1")).state === "ended", "the next runner ends the run");
  const { entries } = await run.settled();
  assert.ok(toolCalls(run.fake).length <= 1, `never sent twice: ${toolCalls(run.fake).length}`);
  assert.equal(toolCalls(run.fake).length, 0, "the first runner died before the send");
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => data.status), ["interrupted"]);
  assert.ok(run.seen.followUps?.at(-1)?.includes(INTERRUPTED_TEXT), run.seen.followUps?.at(-1));
});

test("P4: a stop withdraws a parked call: its record ends in the withdrawal's words, never interrupted, and nothing is sent", async (t) => {
  const run = await cliRun(t);
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  const parkedAt = run.row.epoch;
  await run.server.command("run-1", { kind: "stop" });
  await reached(async () => (await run.server.runs.get("run-1")).state === "stopped", "the run ends stopped");
  const { entries, row } = await run.settled();
  // The stop is taken by the one claim that read it (its end is its release): never released parked and claimed again.
  assert.ok(row.epoch - parkedAt <= 2, `one claim for the stop, not a loop: the epoch moved ${row.epoch - parkedAt}`);
  assert.equal((await run.server.commands("run-1", 0)).find((one) => one.kind === "stop")?.refused, null, "the stop row taken");
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => [data.status, data.output]), [["refused", STOPPED_WHILE_WAITING]]);
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
});

test("P5: a parked call the owner denies ends refused on the record in the deny's words, and nothing is sent", async (t) => {
  const run = await cliRun(t);
  await run.server.command("run-1", { kind: "deny", body: { approval: CALL_ID, note: "not today" } });
  await reached(async () => (await run.server.runs.get("run-1")).state === "ended", "the run ends");
  const { entries } = await run.settled();
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => [data.status, data.output]), [["refused", deniedText("mcp:fake/add", "not today")]]);
  assert.equal(toolCalls(run.fake).length, 0, "nothing sent");
});

test("P7: an allowed call whose runner dies after its start and before its sent mark is run once when the CLI issues it again, never interrupted", async (t) => {
  let hit;
  const atMark = new Promise((resolve) => (hit = resolve));
  const run = await cliRun(t, {
    settings: { "mcp:fake/add": { permission: "allow" } },
    timing: SHORT,
    reissue: true,
    wrap: (store) => sentWatched(store, () => (hit(), new Promise(() => {}))),
  }).catch((error) => assert.fail(error));
  await atMark;
  run.crashRunner();
  await reached(async () => (await run.server.runs.get("run-1")).state === "ended", "the next runner ends the run");
  const { entries } = await run.settled();
  assert.equal(toolCalls(run.fake).length, 1, "sent once, on the CLI's re-issue");
  assert.deepEqual([ofCall(entries, KINDS.callStart).length, ofCall(entries, SENT).length], [1, 1], "one start, one sent mark");
  assert.deepEqual(ofCall(entries, KINDS.callEnd).map((data) => [data.status, data.output]), [["done", "5"]], "its real result, never interrupted");
});
