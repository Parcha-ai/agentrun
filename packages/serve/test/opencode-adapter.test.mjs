// The OpenCode adapter (src/harness-opencode) on the stand-in for `opencode serve` (fixtures/fake-opencode-serve.mjs), its model requests through the
// session's real proxy to a scripted provider and its tool calls through the adapter's real MCP server. No network, no
// OpenCode binary.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "@parcha/agentrun-dsl";
import { createHarnessRunner } from "@parcha/agentrun-kernel";
import { foldSession, pendingSubmissions } from "@parcha/agentrun-kernel/kernel";
import { transcriptOf } from "@parcha/agentrun-kernel/process";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { OPENCODE_INSTALL, OPENCODE_VERSION, openCodeAdapter } from "../dist/harness-opencode/index.js";

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "agentrun-opencode-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCHEMAS = { Out: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } };
const doc = (root) => ({ v: 2, name: "opencode", schemas: SCHEMAS, output: { schemaId: "Out", path: "final" }, root });
const agent = (extra = {}) => ({ node: "agent", label: "task", instructions: "Answer.", out: "Out", as: "final", ...extra });

/** A Responses stream: a function call, or text, then the response's usage. */
function answer(step, i) {
  const events = [];
  if (step.call) {
    const item = { type: "function_call", id: `fc_${i}`, call_id: step.callId ?? `call_${i}`, name: step.call, arguments: JSON.stringify(step.args ?? {}), status: "completed" };
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item });
  } else {
    events.push({ type: "response.output_text.delta", item_id: `m_${i}`, output_index: 0, content_index: 0, delta: step.text });
  }
  events.push({ type: "response.completed", response: { id: `resp_${i}`, object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } } } });
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")}`;
}

/** The provider: request i answered by `script[i]` (a step, or a function of the request's body that gives one). */
function provider(script) {
  const seen = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const i = seen.length;
    seen.push({ url, headers: { ...init.headers }, body });
    let step = script[i] ?? { text: "done" };
    if (typeof step === "function") step = await step(body);
    return new Response(answer(step, i), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { seen, fetch };
}

function adapter(script, extra = {}) {
  const dir = scratch();
  const trace = join(dir, "trace.jsonl");
  writeFileSync(trace, "");
  const p = provider(script);
  const a = openCodeAdapter({
    model: "gpt-test",
    provider: { origin: "https://provider.invalid", credential: () => "provider-secret" },
    price: (_model, usage) => (usage.input + usage.output + usage.cacheRead) / 1e6,
    sessionsDir: join(dir, "sessions"),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_OPENCODE_TRACE: trace, ...(extra.standInEnv ?? {}) } },
    fetch: p.fetch,
    ...(extra.options ?? {}),
  });
  const traced = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { adapter: a, provider: p, traced, dir };
}

/** One session on `store`, its events and its bookings, as a host opens it. */
async function session(a, store, spec, writer) {
  const events = [];
  const booked = [];
  const admitted = [];
  const io = {
    writer: writer ?? (await store.open(spec.key)),
    models: {
      beforeRequest: async (request) => { admitted.push(request); return { turn: admitted.length }; },
      afterRequest: async (usage, ticket) => void booked.push({ usage, ticket }),
    },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  };
  return { session: await a.open(spec, io), events, booked, admitted, io };
}

const spec = (tools, extra = {}) => ({ key: `s-${n}`, label: "task", system: ["You answer."], tools, context: "fresh", ...extra });

test("the adapter says which OpenCode it runs and how to install it", () => {
  const { adapter: a } = adapter([]);
  assert.equal(a.id, "opencode");
  assert.equal(a.version, OPENCODE_VERSION);
  assert.equal(OPENCODE_VERSION, "1.19.5");
  assert.equal(OPENCODE_INSTALL, "npm install --save-exact opencode-ai@1.19.5");
});

test("a DSL agent node runs on OpenCode: the host tool, then submit, through the proxy to the provider", async () => {
  const calls = [];
  const lookup = { name: "lookup", description: "Look a thing up.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, replay: "safe", call: async (args) => { calls.push(args); return { text: "found" }; } };
  const { adapter: a, provider: p } = adapter([{ call: "hands_lookup", args: { q: "x" } }, { call: "hands_submit", args: { value: { answer: "found" } } }, { text: "Submitted." }]);
  const store = memorySessionStore();
  const events = [];
  const runNode = createHarnessRunner(a, { store, tools: [lookup], onEvent: (e) => events.push(e) });
  const result = await runWorkflow(doc(agent({ tools: ["lookup"] })), {}, { runNode });

  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.deepEqual(result.output, { answer: "found" });
  assert.deepEqual(calls, [{ q: "x" }]);
  assert.deepEqual(events.filter((e) => e.type === "tool_start").map((e) => e.name), ["lookup", "submit"], "the host's names, never hands_");
  assert.ok(p.seen.length >= 2);
  for (const r of p.seen) {
    assert.equal(r.url, "https://provider.invalid/v1/responses");
    assert.equal(r.headers.authorization, "Bearer provider-secret");
    assert.equal(r.body.model, "gpt-test");
    assert.equal(r.body.store, false);
    assert.deepEqual(r.body.tools.map((t) => t.name).sort(), ["hands_lookup", "hands_submit"], "exactly the host's tools, as OpenCode names its MCP tools");
  }
  assert.equal(events.filter((e) => e.type === "request_end").length, p.seen.length, "each paid request booked once");
});

test("a session's events are exactly text, tool_start (its call id, the host's name, its whole args), tool_end (its result text) and turn_end; cost only on the booking", async () => {
  const read = { name: "read", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, replay: "safe", call: async () => ({ text: "line one\nline two" }) };
  const broken = { name: "broken", description: "Fails.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => ({ text: "no such file", isError: true }) };
  const { adapter: a, provider: p } = adapter([{ call: "hands_read", args: { path: "notes/a.md" }, callId: "call_r" }, { call: "hands_broken", callId: "call_b" }, { text: "Read it." }]);
  const store = memorySessionStore();
  const s = await session(a, store, spec([read, broken]));
  assert.equal(s.session.state, "new");
  await s.session.send("Read notes/a.md.");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.close();
  assert.deepEqual([...new Set(s.events.map((e) => e.type))].sort(), ["text", "tool_end", "tool_start", "turn_end"]);
  assert.deepEqual(s.events.filter((e) => e.type !== "text"), [
    { type: "tool_start", callId: "call_r", name: "read", args: { path: "notes/a.md" } },
    { type: "tool_end", callId: "call_r", name: "read", isError: false, result: "line one\nline two" },
    { type: "tool_start", callId: "call_b", name: "broken", args: {} },
    { type: "tool_end", callId: "call_b", name: "broken", isError: true, result: "no such file" },
    { type: "turn_end", status: "completed" },
  ]);
  assert.equal(s.events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Read it.");
  assert.ok(s.events.every((e) => !JSON.stringify(e).includes("hands_")), "no row sees OpenCode's MCP prefix");
  assert.ok(s.events.every((e) => !("usd" in e) && !("usage" in e)), "no adapter event carries a cost");
  // Each paid request admitted, then booked once, under its own ticket, with the cached tokens apart.
  assert.equal(s.admitted.length, p.seen.length);
  assert.deepEqual(s.booked.map((b) => b.ticket), s.admitted.map((_, i) => ({ turn: i + 1 })));
  assert.deepEqual(s.booked.map((b) => [b.usage.input, b.usage.output, b.usage.cacheRead]), p.seen.map(() => [60, 10, 40]));
  assert.equal(s.booked[0].usage.usd, 110 / 1e6);
});

test("a request the host refuses is never sent: the node fails with the host's own words", async () => {
  const { adapter: a, provider: p } = adapter([{ text: "never" }]);
  const store = memorySessionStore();
  const runNode = createHarnessRunner(a, { store, tools: [], beforeRequest: () => ({ refuse: "the run's spend cap is reached: the model request was not sent" }) });
  await assert.rejects(runWorkflow(doc(agent()), {}, { runNode }), { name: "HarnessRunError", reason: "refused", message: "the run's spend cap is reached: the model request was not sent" });
  assert.equal(p.seen.length, 0, "nothing reached the provider");
});

test("a follow-up continues the same OpenCode session, given back to a new process from the session's records", async () => {
  const { adapter: a, provider: p, traced } = adapter([{ text: "First." }, { text: "Second." }]);
  const store = memorySessionStore();
  const s = await session(a, store, spec([]));
  await s.session.send("one");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.send("two");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.close();
  const replays = traced().filter((l) => l.replayed);
  assert.equal(replays.length, 1, "the second turn's process took the session back from the log");
  const users = p.seen[1].body.input.filter((item) => item.role === "user").map((item) => item.content[0].text);
  assert.deepEqual(users, ["one", "two"], "the second turn's model sees the first");
  assert.ok(p.seen[1].body.input.some((item) => item.role === "assistant" && item.content[0].text === "First."));
});

test("a stop ends the turn interrupted, OpenCode aborting it; the next message is a plain turn", async () => {
  const started = Promise.withResolvers();
  const slow = { name: "slow", description: "Waits.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: (_args, { signal }) => new Promise((resolve) => { started.resolve(); signal.addEventListener("abort", () => resolve({ text: "stopped", isError: true }), { once: true }); }) };
  const { adapter: a, provider: p } = adapter([{ call: "hands_slow" }, { text: "Again." }]);
  const store = memorySessionStore();
  const s = await session(a, store, spec([slow]));
  await s.session.send("wait");
  await started.promise;
  await s.session.interrupt();
  assert.deepEqual(await s.session.turnEnd(), { status: "interrupted" });
  await s.session.send("go on");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.close();
  const last = p.seen.at(-1).body.input;
  assert.ok(!JSON.stringify(last).includes("[Recovery]"), "no recovery note: the stopped turn's end is in the log");
});

test("a process killed mid-turn, inside a never call: the next process takes the session back from the log, reports the call, never runs it again, and the turn completes", async () => {
  const started = Promise.withResolvers();
  let runs = 0;
  const charge = { name: "charge", description: "Charges a card.", inputSchema: { type: "object", properties: { cents: { type: "number" } } }, replay: "never", call: (_args, { signal }) => new Promise((resolve) => { runs += 1; started.resolve(); signal.addEventListener("abort", () => resolve({ text: "cut", isError: true }), { once: true }); }) };
  const { adapter: a, provider: p, traced } = adapter([{ call: "hands_charge", args: { cents: 500 }, callId: "call_charge" }, { text: "Checked: the charge may have gone through." }]);
  const store = memorySessionStore();
  const s1 = await session(a, store, spec([charge]));
  const key = `s-${n}`;
  await s1.session.send("Charge 500.");
  await started.promise;
  // The crash: a newer process takes the session (the old writer is fenced), and OpenCode's process dies with the old one.
  const writer = await store.open(key);
  const pid = traced().find((l) => l.method === "POST" && l.path.endsWith("/prompt_async"))?.pid;
  assert.ok(pid, "OpenCode's process answered the prompt");
  process.kill(-pid, "SIGKILL");
  await s1.session.close();

  const s2 = await session(a, store, spec([charge]), writer);
  assert.equal(s2.session.state, "open_turn", "the cut turn is owed a recovery");
  await s2.session.recover();
  assert.deepEqual(await s2.session.turnEnd(), { status: "completed" });
  await s2.session.close();
  assert.equal(runs, 1, "the never call ran once");
  assert.ok(traced().some((l) => l.replayed), "OpenCode took the session back from the log");
  const input = JSON.stringify(p.seen.at(-1).body.input);
  assert.match(input, /Charge 500\./, "the restored session holds the user's message");
  assert.match(input, /\[Recovery\]/, "the model is told the turn was cut");
  assert.match(input, /charge.*call_charge.*interrupted before it reported a result\. It is not safe to repeat/s);
  const state = foldSession(key, await store.read(key));
  assert.equal(state.effects.get("tool:call_charge").error?.interrupted, true);
});

test("twenty follow-ups, each in a new OpenCode process that took the session back from the records: every drive's event stream opens at the first try", { timeout: 240_000 }, async (t) => {
  const said = [];
  const { adapter: a, traced } = adapter(Array.from({ length: 20 }, (_, i) => ({ text: `Answer ${i + 1}.` })), { options: { log: (message) => said.push(message) } });
  const store = memorySessionStore();
  const s = await session(a, store, spec([]));
  const ends = [];
  for (let i = 1; i <= 20; i++) {
    await s.session.send(`Message ${i}.`);
    ends.push((await s.session.turnEnd()).status);
  }
  await s.session.close();
  const reopened = said.filter((m) => m.includes("event stream is opened again")).length;
  t.diagnostic(`${ends.filter((e) => e === "completed").length}/20 drives completed; ${reopened} event streams opened again`);
  assert.deepEqual(ends, Array(20).fill("completed"));
  assert.equal(traced().filter((l) => l.replayed).length, 19, "every drive after the first took the session back with /sync/replay");
  assert.equal(reopened, 0);
  assert.equal(s.events.filter((e) => e.type === "text").map((e) => e.delta).join(" "), Array.from({ length: 20 }, (_, i) => `Answer ${i + 1}.`).join(" "));
});

test("an event stream that does not open is opened again and the turn completes; one that never opens fails the drive by name", { timeout: 60_000 }, async () => {
  const said = [];
  const once = adapter([{ text: "Late but here." }], { standInEnv: { FAKE_OPENCODE_STALL_EVENTS: "1" }, options: { eventConnectMs: 500, log: (message) => said.push(message) } });
  const s1 = await session(once.adapter, memorySessionStore(), spec([]));
  await s1.session.send("hi");
  assert.deepEqual(await s1.session.turnEnd(), { status: "completed" });
  await s1.session.close();
  assert.equal(said.filter((m) => m.includes("event stream is opened again")).length, 1);
  assert.equal(once.traced().filter((l) => l.stalled).length, 1);

  const never = adapter([{ text: "never" }], { standInEnv: { FAKE_OPENCODE_STALL_EVENTS: "3" }, options: { eventConnectMs: 500 } });
  const s2 = await session(never.adapter, memorySessionStore(), spec([]));
  await s2.session.send("hi");
  const ended = await s2.session.turnEnd();
  await s2.session.close();
  assert.equal(ended.status, "failed");
  assert.match(ended.error, /OpenCode's event stream did not open 3 times \(no server\.connected within 500 ms\)/);
  assert.equal(never.provider.seen.length, 0, "nothing was asked of the model");
});

test("a session closed while OpenCode's event stream has not opened yet stops at once: nothing is left waiting", { timeout: 60_000 }, async () => {
  // The stream never answers, and its tries wait long: close comes in the middle of the first.
  const { adapter: a, traced } = adapter([{ text: "never" }], { standInEnv: { FAKE_OPENCODE_STALL_EVENTS: "3" }, options: { eventConnectMs: 30_000 } });
  const s = await session(a, memorySessionStore(), spec([]));
  await s.session.send("hi");
  for (let i = 0; !traced().some((l) => l.stalled); i++) {
    assert.ok(i < 200, "the stand-in got the stream's request");
    await sleep(25);
  }
  const closed = await Promise.race([s.session.close().then(() => "closed"), sleep(10_000).then(() => "still waiting after 10 s")]);
  assert.equal(closed, "closed");
  const ended = await Promise.race([s.session.turnEnd(), sleep(5_000).then(() => "no end")]);
  assert.equal(ended.status, "interrupted", JSON.stringify(ended));
});

test("an answer given while the event stream was down reaches the session when it is opened again: the text, then the turn's end", { timeout: 60_000 }, async () => {
  const said = [];
  const { adapter: a, traced } = adapter([{ text: "Said while no one listened." }], { standInEnv: { FAKE_OPENCODE_DROP_EVENTS_IN_TURN: "1" }, options: { log: (message) => said.push(message) } });
  const s = await session(a, memorySessionStore(), spec([]));
  await s.session.send("hi");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.close();
  assert.ok(traced().some((l) => l.dropped), "the stand-in dropped the stream mid-turn");
  assert.ok(said.some((m) => m.includes("event stream is opened again")), "the stream was opened again");
  assert.equal(s.events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Said while no one listened.", "the answer's text reached the session");
});

test("an event stream that runs out of tries before any turn fails the next turn at once, naming it, and the drive ends with OpenCode and its servers closed", { timeout: 60_000 }, async (t) => {
  // The stream says server.connected, ends, then answers 503 while the drive mirrors its new session: no turn exists yet.
  const said = [];
  const { adapter: a, provider: p, traced } = adapter([{ text: "never" }], { standInEnv: { FAKE_OPENCODE_EVENTS_GONE: "3000" }, options: { log: (message, fields) => said.push({ message, ...fields }) } });
  const s = await session(a, memorySessionStore(), spec([]));
  // A turn that never ends leaves its drive waiting: the test closes it whatever happens.
  t.after(() => s.session.close().catch(() => {}));
  await s.session.send("hi");
  const ended = await Promise.race([s.session.turnEnd(), sleep(10_000).then(() => "no end after 10 s")]);
  assert.equal(ended.status, "failed", JSON.stringify(ended));
  assert.equal(ended.error, "OpenCode's event stream did not open 3 times (opencode: OpenCode's event stream answered 503)", "its last two tries were answered 503");
  assert.equal(p.seen.length, 0, "nothing reached the model");
  assert.ok(!traced().some((l) => l.path?.endsWith("/prompt_async")), "the message was never sent to OpenCode");
  const closed = await Promise.race([s.session.close().then(() => "closed"), sleep(10_000).then(() => "still waiting after 10 s")]);
  assert.equal(closed, "closed");
  const pid = traced().find((l) => l.pid)?.pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "OpenCode's process is gone");
  const mcp = said.find((l) => l.message === "opencode: OpenCode listens")?.mcp;
  assert.ok(mcp, "the adapter said where its MCP server listened");
  await assert.rejects(fetch(mcp, { method: "POST" }), "the adapter's MCP server is closed");
});

test("a message OpenCode refuses ends the turn failed with OpenCode's own status and reason", { timeout: 60_000 }, async () => {
  const { adapter: a, provider: p } = adapter([{ text: "never" }], { standInEnv: { FAKE_OPENCODE_REJECT_PROMPT: "1" } });
  const s = await session(a, memorySessionStore(), spec([]));
  await s.session.send("hi");
  const ended = await s.session.turnEnd();
  await s.session.close();
  assert.equal(ended.status, "failed");
  assert.match(ended.error, /OpenCode refused the message \(400\): .*agent hands is not configured/);
  assert.equal(p.seen.length, 0, "nothing reached the model");
});

/** What the model was asked in each request: the user messages' text, in order. */
const userTexts = (p) => p.seen.flatMap((r) => r.body.input.filter((i) => i.role === "user").flatMap((i) => (Array.isArray(i.content) ? i.content.map((c) => c.text) : [String(i.content)])));
const folded = async (store, key) => foldSession(key, await store.read(key));

test("a turn its session interrupted (a stop OpenCode did not end) is open to the next process; settled, it ends interrupted, sends nothing and stays ended, and the next message is a turn of its own", { timeout: 60_000 }, async () => {
  const started = Promise.withResolvers();
  const slow = { name: "slow", description: "Waits.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: (_args, { signal }) => new Promise((_resolve, reject) => { started.resolve(); signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); }) };
  const store = memorySessionStore();
  const sp = spec([slow], { key: "s-stop-open" });
  // OpenCode answers the abort and does not end the turn: the adapter halts the drive, and no end is written.
  const { adapter: first } = adapter([{ call: "hands_slow" }], { standInEnv: { FAKE_OPENCODE_IGNORE_ABORT: "1" } });
  const a = await session(first, store, sp);
  await a.session.send("wait");
  await started.promise;
  const ending = a.session.turnEnd();
  await a.session.interrupt();
  assert.equal((await ending).status, "interrupted");
  await a.session.close();

  const { adapter: next, provider: nextModel } = adapter([{ text: "Here." }]);
  const b = await session(next, store, sp);
  assert.equal(b.session.state, "open_turn", "the stopped turn is open to the next process");
  await b.session.settleOpenTurn();
  assert.equal(b.session.state, "idle");
  await b.session.send("and now?");
  assert.equal((await b.session.turnEnd()).status, "completed");
  await b.session.close();
  assert.ok(!JSON.stringify(nextModel.seen.map((r) => r.body.input)).includes("[Recovery]"), "the stopped turn is not resumed: no recovery note");

  const { adapter: later } = adapter([]);
  const c = await session(later, store, sp);
  assert.equal(c.session.state, "idle", "settled for good: no open turn for the process after");
  await c.session.close();
});

test("an opencode turn stopped before its prompt was placed: settled, its prompt is withdrawn, a later open finds no open turn and writes no second end, and the next message runs alone", { timeout: 60_000 }, async () => {
  const store = memorySessionStore();
  const sp = spec([], { key: "s-stop-early" });
  const { adapter: first } = adapter([]);
  const a = await session(first, store, sp);
  await a.session.send("go");
  // The stop lands at once: before the drive has started OpenCode and placed the prompt.
  const ending = a.session.turnEnd();
  await a.session.interrupt();
  assert.equal((await ending).status, "interrupted");
  await a.session.close();
  const stopped = await folded(store, sp.key);
  const go = stopped.submissions.find((x) => x.text === "go");
  assert.ok(go && !stopped.placed.has(go.id), "setup: the stop landed before the prompt was placed");

  const { adapter: next, provider: nextModel } = adapter([{ text: "unused" }]);
  const b = await session(next, store, sp);
  assert.equal(b.session.state, "open_turn", "setup: the stopped turn is open to the next process");
  await b.session.settleOpenTurn();
  const pendingAfterSettle = pendingSubmissions(await folded(store, sp.key)).map((x) => x.text);
  await b.session.close();

  // The process after it: serve's open settles a stopped turn it finds open, as here.
  const { adapter: later, provider: laterModel } = adapter([{ text: "Now." }]);
  const c = await session(later, store, sp);
  const laterOpen = c.session.state;
  if (c.session.state === "open_turn") await c.session.settleOpenTurn();
  const ends = transcriptOf(await folded(store, sp.key)).filter((r) => r.data?.type === "turn").map((r) => r.data.status);
  await c.session.send("and now?");
  assert.equal((await c.session.turnEnd()).status, "completed");
  await c.session.close();
  const ended = await folded(store, sp.key);
  const placed = ended.submissions.filter((x) => ended.placed.has(x.id)).map((x) => x.text);
  assert.deepEqual(
    { pendingAfterSettle, laterOpen, ends, placed, modelSaw: [...userTexts(nextModel), ...userTexts(laterModel)] },
    { pendingAfterSettle: [], laterOpen: "idle", ends: ["interrupted"], placed: ["and now?"], modelSaw: ["and now?"] },
    "the stopped turn's prompt is withdrawn at its settle: no later open finds it open or ends it again, and the next message is the only one sent",
  );
});

test("an opencode turn stopped before its prompt was placed, then a message in the same process: the session reads open_turn after the stop, its settle withdraws the prompt, and the message runs alone", { timeout: 60_000 }, async () => {
  const store = memorySessionStore();
  const sp = spec([], { key: "s-stop-early-here" });
  const { adapter: a, provider: p } = adapter([{ text: "Now." }]);
  const s = await session(a, store, sp);
  await s.session.send("go");
  // The stop lands at once: before the drive has started OpenCode and placed the prompt.
  const ending = s.session.turnEnd();
  await s.session.interrupt();
  assert.equal((await ending).status, "interrupted");
  const stopped = await folded(store, sp.key);
  const go = stopped.submissions.find((x) => x.text === "go");
  assert.ok(go && !stopped.placed.has(go.id), "setup: the stop landed before the prompt was placed");
  // As serve's stop does: a turn the session still holds open after the interrupt is settled there.
  const afterStop = s.session.state;
  if (s.session.state === "open_turn") await s.session.settleOpenTurn();
  await s.session.send("and now?");
  assert.equal((await s.session.turnEnd()).status, "completed");
  await s.session.close();
  const ended = await folded(store, sp.key);
  const placed = ended.submissions.filter((x) => ended.placed.has(x.id)).map((x) => x.text);
  assert.deepEqual(
    { afterStop, pending: pendingSubmissions(ended).map((x) => x.text), placed, modelSaw: userTexts(p) },
    { afterStop: "open_turn", pending: [], placed: ["and now?"], modelSaw: ["and now?"] },
    "the stopped prompt is never sent: the stop leaves the turn open to settle, and the next message is the only one sent",
  );
});

test("a host tool's result past the host's bound reaches OpenCode cut there, saying so, and its end is flagged truncated", { timeout: 60_000 }, async () => {
  const BOUND = 120_000;
  const whole = "x".repeat(130_000);
  const big = { name: "big", description: "Reads a big file.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => ({ text: whole }) };
  const { adapter: a, provider: p } = adapter([{ call: "hands_big", callId: "call_big" }, { text: "Read it." }]);
  const store = memorySessionStore();
  const s = await session(a, store, spec([big]));
  await s.session.send("Read the big file.");
  assert.deepEqual(await s.session.turnEnd(), { status: "completed" });
  await s.session.close();
  const ended = s.events.find((e) => e.type === "tool_end" && e.name === "big");
  assert.equal(ended?.truncated, true, "the host hears the call's end flagged truncated");
  // What OpenCode handed the model: the call's output in the next request, within the bound, ending with where it was cut.
  const output = p.seen.at(-1).body.input.find((i) => i.type === "function_call_output" && i.call_id === "call_big")?.output;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  assert.ok(text.length <= BOUND + 200, `${text.length} characters reached the model`);
  assert.match(text, /\[cut at \d+ of 130000 characters\]/);
});

test("a turn that starts while the event stream is down ends when OpenCode goes idle: the reopened stream's status check reads it busy", { timeout: 60_000 }, async () => {
  // The stream ends as the turn starts, before its busy status; the model's answer takes 1.5 s, so the stream is open again
  // (and OpenCode's status says busy) well before the turn goes idle.
  const { adapter: a } = adapter([async () => { await sleep(1_500); return { text: "Done." }; }], { standInEnv: { FAKE_OPENCODE_DROP_BUSY: "1" } });
  const s = await session(a, memorySessionStore(), spec([]));
  await s.session.send("go");
  const ended = await Promise.race([s.session.turnEnd(), sleep(10_000).then(() => "no end within 10 s")]);
  await s.session.close();
  assert.deepEqual(ended, { status: "completed" }, "the turn ends when OpenCode goes idle");
});

test("a host tool still running when OpenCode goes away settles before the drive ends: its real result is in, and it never runs twice at once", { timeout: 60_000 }, async () => {
  const order = [];
  let active = 0;
  let most = 0;
  // A safe tool that takes 1.5 s and does not stop when its signal aborts (as a write already under way would not).
  const slow = { name: "slow", description: "Takes a while.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => {
    active += 1;
    most = Math.max(most, active);
    await sleep(1_500);
    active -= 1;
    order.push("tool finished");
    return { text: "slow done" };
  } };
  // OpenCode's process exits once the call has reached the MCP server.
  const { adapter: a } = adapter([{ call: "hands_slow" }, { text: "After." }], { standInEnv: { FAKE_OPENCODE_EXIT_AFTER_CALL: "slow" } });
  const s = await session(a, memorySessionStore(), spec([slow]));
  await s.session.send("go");
  await s.session.turnEnd();
  order.push("turn ended");
  await s.session.send("again");
  await Promise.race([s.session.turnEnd(), sleep(20_000)]);
  await s.session.close();
  assert.deepEqual(order.slice(0, 2), ["tool finished", "turn ended"], "the drive ends after the call it started has settled");
  assert.equal(most, 1, "the tool never runs twice at once");
});

test("a drive whose MCP server cannot listen closes the model proxy it opened, and its turn fails", { timeout: 60_000 }, async (t) => {
  const http = await import("node:http");
  const listen = http.Server.prototype.listen;
  const servers = [];
  t.after(() => {
    http.Server.prototype.listen = listen;
    for (const server of servers) if (server.listening) server.close();
  });
  const s = await session(adapter([]).adapter, memorySessionStore(), spec([]));
  // The drive's first server (the model proxy) listens; its second (the MCP server) fails to.
  http.Server.prototype.listen = function (...args) {
    servers.push(this);
    if (servers.length !== 2) return listen.apply(this, args);
    process.nextTick(() => this.emit("error", Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" })));
    return this;
  };
  await s.session.send("go");
  const ended = await s.session.turnEnd();
  http.Server.prototype.listen = listen;
  await s.session.close();
  assert.equal(ended.status, "failed");
  assert.deepEqual(servers.map((server) => server.listening), [false, false], "nothing the failed start opened is left listening");
});

test("an opencode turn whose stop lands while send() is still recording the prompt: the session reads open_turn after it, and the next message is sent alone", { timeout: 60_000 }, async () => {
  const store = memorySessionStore();
  const sp = spec([], { key: "s-abort-submit" });
  // The session's writer, with the prompt's submission held at its append until the test lets it go.
  const inner = await store.open(sp.key);
  let held;
  const reached = new Promise((resolve) => { held = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => {
    if (records.some((r) => r.kind === "kernel.submission" && r.data?.text === "go")) { held(); await gate; }
    return inner.append(records);
  } };
  const { adapter: a, provider: p } = adapter([{ text: "Now." }]);
  const s = await session(a, store, sp, writer);
  const sending = s.session.send("go");
  await reached;
  // The stop lands while the prompt is being recorded: no turn is running yet.
  await s.session.interrupt();
  release();
  await sending;
  assert.equal((await s.session.turnEnd()).status, "interrupted");
  const stopped = await folded(store, sp.key);
  const go = stopped.submissions.find((x) => x.text === "go");
  assert.ok(go && !stopped.placed.has(go.id), "setup: the stopped prompt was recorded and never placed");
  // As serve's stop does: a turn the session still holds open after the stop is settled.
  const afterStop = s.session.state;
  if (s.session.state === "open_turn") await s.session.settleOpenTurn();
  await s.session.send("and now?");
  assert.equal((await s.session.turnEnd()).status, "completed");
  await s.session.close();
  const ended = await folded(store, sp.key);
  const placed = ended.submissions.filter((x) => ended.placed.has(x.id)).map((x) => x.text);
  assert.deepEqual(
    { afterStop, pending: pendingSubmissions(ended).map((x) => x.text), placed, modelSaw: userTexts(p) },
    { afterStop: "open_turn", pending: [], placed: ["and now?"], modelSaw: ["and now?"] },
    "a stop during the prompt's record leaves the turn open to settle, and the stopped prompt is never sent",
  );
});

test("instructions past what one environment string may hold (128 KiB on Linux) reach OpenCode: its config is a file, not an environment variable", { timeout: 60_000 }, async () => {
  const big = `Answer briefly.\n${"x".repeat(140 * 1024)}`;
  const { adapter: a, provider: p } = adapter([{ text: "Done." }]);
  const s = await session(a, memorySessionStore(), spec([], { system: [big] }));
  await s.session.send("go");
  const ended = await s.session.turnEnd();
  await s.session.close();
  assert.deepEqual(ended, { status: "completed" }, "the drive runs with the instructions whole");
  assert.ok(JSON.stringify(p.seen[0]?.body.input ?? []).includes("x".repeat(1024)), "the model was given them");
});

test("OpenCode's process holds no session key in its environment: the config, with the model proxy's and the MCP server's keys, is a file only its user reads (0600)", { timeout: 60_000 }, async () => {
  const started = Promise.withResolvers();
  const go = Promise.withResolvers();
  const wait = { name: "wait", description: "Waits.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => { started.resolve(); await go.promise; return { text: "waited" }; } };
  const { adapter: a, traced } = adapter([{ call: "hands_wait" }, { text: "Done." }]);
  const s = await session(a, memorySessionStore(), spec([wait]));
  await s.session.send("go");
  await started.promise;
  const pid = traced().find((line) => typeof line.pid === "number")?.pid;
  const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const named = (name) => environ.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const file = named("OPENCODE_CONFIG");
  // Read while the drive runs: its private directories go with it.
  const mode = file ? statSync(file).mode & 0o777 : undefined;
  go.resolve();
  await s.session.turnEnd();
  await s.session.close().catch(() => {});
  assert.deepEqual({ content: named("OPENCODE_CONFIG_CONTENT") !== undefined, file: typeof file === "string" }, { content: false, file: true }, "the config is a file OPENCODE_CONFIG names, not the environment's");
  assert.equal(mode, 0o600, "only OpenCode's user reads it");
});

test("a stream opened again after OpenCode took the prompt but before its turn started does not end the turn: it ends with OpenCode's answer", { timeout: 60_000 }, async () => {
  // The stream ends as the prompt is taken, and the turn starts 1.5 s later: the reopened stream finds OpenCode idle,
  // the prompt recorded, and no answer yet.
  const { adapter: a, provider: p } = adapter([{ text: "Done." }], { standInEnv: { FAKE_OPENCODE_SLOW_START: "1500" } });
  const s = await session(a, memorySessionStore(), spec([]));
  await s.session.send("go");
  const ended = await Promise.race([s.session.turnEnd(), sleep(15_000).then(() => "no end within 15 s")]);
  const asked = p.seen.length;
  const said = s.events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  await s.session.close();
  assert.deepEqual({ ended, asked, said }, { ended: { status: "completed" }, asked: 1, said: "Done." }, "the turn ends once OpenCode has answered it");
});
