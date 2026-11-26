// ask_person on the runner's pi line. On main ask_person is pi's own native tool (tools.ts installTool -> defineExtension):
// calling it returns control.terminate, so pi ends the turn and the run parks on the person's question (input_required).
// The runner carries it the same way, as a pi-native extension on the root agent (adapter-run-spec.ts, through the pi
// adapter's PiAdapterOptions.extensions, which both offers and runs it), so pi keeps its terminate; the loop reads that
// turn end (endedOnTurnEndingTool) and commits the run parked on a KINDS.personAsked entry, never ending it. A person's
// message resumes it as the next user turn. The same run on claude-agent and codex, which get ask_person as a host tool,
// is runner-ask-person-harnesses.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const QUESTION = "Which region should I pick?";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const VIEW_DEPS = { origin: "https://run.test", serverSecrets: () => [] };

const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const modelCalls = (gw) => gw.requests.filter((r) => r.path.endsWith("/messages"));

/** The gateway's answer: on a request offering ask_person with no tool result yet (the first turn), the model calls it;
 *  once its result is in (the resume turn, pi replays the prior turn), the model has nothing to ask and says "done". */
const driveAsk = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes("ask_person") && !hasResult) return { name: "ask_person", input: { question: QUESTION } };
  return undefined;
};

/** A pi run granted `tools`, through the runner's adapter loop; its model calls ask_person once. Settles to its park (or,
 *  with `settled`, to what that reads). `personWait`: a tool host's hold the spec's lifecycle carries (HostLifecycle
 *  .personWait), as the browser's is. `mcpOf(claim)`: the n-th claim's MCP (1 first), in place of the spec's.
 *  `sessionOf(session, claim)`: the n-th claim's session as the loop sees it, in place of the one its adapter opened.
 *  `outputSchema`: the agent's output contract. `stoppedBeforeInput`: the first claim's spec waits until the run is stopped
 *  and then fails, as a harness's first-use install does when a person stops the run during it, so the run ends stopped
 *  with its session never sent its input. `endCheckout(claim, own)`: the n-th claim's end checkout (writeEnd runs it
 *  before the end commits), handed the spec's own. The runner stays up so a test may resume it; its store, server and
 *  gateway are returned. */
async function askRun(t, { tools, personWait, beforeRelease, settled, loopOptions = {}, upstream, drive = driveAsk, outcomes = [], mcpOf, sessionOf, personOnly, beforeStart, outputSchema, stoppedBeforeInput = false, endCheckout }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-ask-person-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: drive, text: "done" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Asks" }, { id: "rev-1", kind: "agentic", body: { instructions: "Ask the person.", tools, ...(outputSchema ? { outputSchema } : {}) } });
  const launch = { input: { content: "Pick a region." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 2 + (usage.output ?? 0) * 10) / 1e6;
  const route = { model: "claude-sonnet-5-5", provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 2, output: 10 }, outputCeiling: 8_192, price, fetch: (...args) => (upstream ?? globalThis.fetch)(...args) };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  let claims = 0;
  const specOf = async (claim, run) => {
    if (stoppedBeforeInput && claims === 0) {
      await new Promise((resolve) => (run.stopped.aborted ? resolve() : run.stopped.addEventListener("abort", resolve, { once: true })));
      claims += 1;
      throw new Error("the harness's install was stopped");
    }
    const made = await adapterRunSpecFromLaunch(launch, run, deps, claim);
    claims += 1;
    const nth = claims;
    const adapter = sessionOf ? new Proxy(made.adapter, { get: (target, key) => (key === "open" ? async (...args) => sessionOf(await target.open(...args), nth) : Reflect.get(target, key, target)) }) : made.adapter;
    const spec = { ...made, adapter, ...(mcpOf ? { mcp: mcpOf(claims) } : {}), ...(personOnly ? { personOnly } : {}), ...(endCheckout ? { endCheckout: () => endCheckout(nth, made.endCheckout) } : {}) };
    // `beforeRelease`: a tool host's release (HostLifecycle.beforeRelease, as the browser's session release is), which a
    // park runs before its seal.
    const lifecycle = { ...spec.lifecycle, ...(personWait ? { personWait: [personWait] } : {}), ...(beforeRelease ? { beforeRelease: [...(spec.lifecycle?.beforeRelease ?? []), beforeRelease] } : {}) };
    return personWait || beforeRelease ? { ...spec, lifecycle } : spec;
  };
  // What each claim's loop answered each command row it was handed (`outcomes`, the caller's: the runner writes only a
  // refusal of them).
  const loops = createAdapterLoop(specOf, loopOptions);
  const createLoop = (loopDeps) => {
    const loop = loops(loopDeps);
    return { ...loop, command: async (command) => {
      const outcome = await loop.command(command);
      outcomes.push({ id: command.id, outcome });
      return outcome;
    } };
  };
  const start = (name) => (runner = startRunner({ store, name, ...TIMING, createLoop }));
  // `beforeStart`: rows written before any runner claims the run, so its claim's first read hands them all on.
  await beforeStart?.(server);
  start("runner-a");
  /** The runner shut down (its claims let go, as a deploy's drain does), `between` done with no runner up, and another
   *  started on the same store. */
  const restart = async (between) => {
    await runner.close();
    await between?.();
    start("runner-b");
  };
  const row = await until(settled ? () => settled(server) : async () => {
    const now = await server.runs.get(RUN);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's park or end");
  return { row, server, store, gw, restart, outcomes };
}

test("park: a pi run that calls ask_person parks on its question, input_required with the question pending, claim released, one request and no re-run", async (t) => {
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"] });
  assert.equal(row.state, "parked", `the run parks on ask_person, never completes with no question: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(row.runner, null, "the claim is released");
  // One model request: the turn ended on the ask, and the parked run is not claimed again with nothing to answer (the
  // re-claim-stays-parked case — before the state was committed the run looped, re-running the turn every poll).
  assert.equal(modelCalls(gw).length, 1, `one request, the run parked and was never re-run: ${modelCalls(gw).length}`);
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required", `the view reads input_required: ${JSON.stringify(view.status)}`);
  assert.equal(view.state, "waiting", `waiting on the person: ${JSON.stringify(view.state)}`);
  assert.equal(view.pending?.kind, "question", `a question is pending: ${JSON.stringify(view.pending)}`);
  assert.equal(view.pending?.question, QUESTION, `the question is the model's, read through the cut: ${JSON.stringify(view.pending)}`);
  assert.ok(!(row.summary ?? "").includes(QUESTION), `the run row never copies the question text: ${JSON.stringify(row.summary)}`);
});

test("resume: the person's message resumes the parked run as its next user turn, and nothing is re-asked", async (t) => {
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"] });
  assert.equal(row.state, "parked");
  const before = modelCalls(gw).length;
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the person's message resumes and ends the run");
  assert.equal(ended.state, "ended", `the reply resumed the run to its end: ${JSON.stringify(ended)}`);
  const after = modelCalls(gw);
  assert.ok(after.length > before, `the resume ran a new turn: ${before} -> ${after.length}`);
  const last = after[after.length - 1].body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the person's message is the resume's user turn");
  // ask_person was asked exactly once across the whole run: the resume did not re-ask, so the question is not billed twice.
  const asks = after.flatMap((call) => (call.body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block?.type === "tool_use" && block?.name === "ask_person"));
  assert.equal(asks.length, 1, `ask_person was asked once, never re-asked on the resume: ${asks.length}`);
});

// #2291 (part of #2230): the server tells run.needs_input for a run held in its claim by the row's waiting summary. A
// parked question's answer claims the run again; were the summary left until the end commit, the answer's turn would read
// as that held wait and the server would tell the same question a second time.
test("resume: the answer to a parked question clears the row's waiting summary in its take, so the answer's turn never reads as a wait held in the claim", async (t) => {
  let hold;
  const held = new Promise((resolve) => (hold = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let asked = 0;
  // The resume's model request (the run's second) waits until the row is read: the answer is taken, its turn running.
  const upstream = async (url, init) => {
    if (++asked === 2) {
      hold();
      await released;
    }
    return globalThis.fetch(url, init);
  };
  t.after(() => release());
  const { row, server } = await askRun(t, { tools: ["ask_person"], upstream });
  assert.deepEqual([row.state, row.summary], ["parked", "Waiting for your reply"], "parked on its question, the row saying so");
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await held;
  const during = await server.runs.get(RUN);
  assert.equal(during.state, "running", "the answer's turn runs");
  assert.notEqual(during.runner, null, "in its claim");
  assert.equal(during.summary, null, `the waiting summary went with the answer's take, never left to the end: ${JSON.stringify(during.summary)}`);
  release();
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer ends the run");
  assert.equal(ended.summary, null);
});

// Issue 2230, the runner's half: any answer to an ask clears the row's waiting summary in its take, not only an in-claim
// wait's or a first claim's. A run that ended, was reopened by a follow-up and then parked on a question holds its earlier
// end in its journal, so the answer's claim reads as reopened and its steer takes the reopened path: that take clears the
// summary too.
test("resume after a follow-up: a reopened run that parks on its question has its waiting summary cleared by the answer's take", async (t) => {
  const FOLLOW_UP = "Now ask me which region.";
  // The model asks only on the follow-up's turn: the first input is answered, and the answer's turn says "done".
  const drive = ({ body }) => {
    const lastUser = (body?.messages ?? []).findLast((message) => message.role === "user");
    const asked = JSON.stringify(lastUser?.content ?? "").includes(FOLLOW_UP);
    return (body?.tools ?? []).some((tool) => tool?.name === "ask_person") && asked ? { name: "ask_person", input: { question: QUESTION } } : undefined;
  };
  let hold;
  const held = new Promise((resolve) => (hold = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let holding = true;
  // The answer's model request waits until the row is read: the answer is taken, its turn running.
  const upstream = async (url, init) => {
    const sent = typeof init?.body === "string" ? init.body : init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "";
    if (holding && sent.includes("us-west-2")) {
      holding = false;
      hold();
      await released;
    }
    return globalThis.fetch(url, init);
  };
  t.after(() => release());
  const { row, server } = await askRun(t, { tools: ["ask_person"], upstream, drive });
  assert.equal(row.state, "ended", `the first input is answered and the run ends: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  await server.runs.reopen(RUN, { kind: "steer", body: { text: FOLLOW_UP } });
  const parked = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "parked" && now.runner === null && now;
  }, "the follow-up's turn asks and the run parks on its question");
  assert.equal(parked.summary, "Waiting for your reply", "parked on its question, the row saying so");
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await held;
  const during = await server.runs.get(RUN);
  assert.equal(during.state, "running", "the answer's turn runs");
  assert.notEqual(during.runner, null, "in its claim");
  assert.equal(during.summary, null, `the waiting summary went with the answer's take, never left to the end: ${JSON.stringify(during.summary)}`);
  release();
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer ends the run");
  assert.equal(ended.summary, null);
});

/** A tool host's hold for the wait in the claim (HostLifecycle.personWait), as the browser's is: what it was asked, how
 *  often it was dropped, and its lapse, for the test to fire. `holds: false` holds nothing (undefined), as with no browser. */
function fakeWait({ holds = true } = {}) {
  const seen = { asked: [], dropped: 0 };
  let lapse = () => {};
  const lapsed = new Promise((resolve) => (lapse = resolve));
  const personWait = async (_harness, callId, since) => {
    seen.asked.push(callId);
    (seen.since ??= []).push(since);
    return holds ? { lapsed, drop: () => void (seen.dropped += 1), confirmed: () => void (seen.confirmed = (seen.confirmed ?? 0) + 1) } : undefined;
  };
  return { seen, personWait, lapse: (words) => lapse(words) };
}
/** The run waits in its claim: running, a runner holding it, and the host asked for its hold. */
const waitingInClaim = (seen) => async (server) => {
  const now = await server.runs.get(RUN);
  return now.state === "running" && now.runner !== null && seen.asked.length > 0 && now;
};

test("wait in the claim: a tool host that holds for the wait keeps the run claimed and input_required on its question; the person's message is its next turn in the same claim, the hold dropped as it is placed", async (t) => {
  const wait = fakeWait();
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  assert.equal(row.state, "running", "never parked");
  assert.equal(wait.seen.asked.length, 1, "the host was asked once, for the ask_person call");
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required", `the view reads input_required while the run waits in its claim: ${JSON.stringify(view.status)}`);
  assert.equal(view.state, "waiting");
  assert.equal(view.pending?.question, QUESTION, JSON.stringify(view.pending));
  assert.equal(wait.seen.dropped, 0, "held while it waits");
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer's turn ends the run");
  // The claim's release moves the epoch once: a park and a new claim would have moved it more.
  assert.equal(ended.epoch, row.epoch + 1, "the answer ran in the same claim, never a park and a new claim");
  const { entries } = await journalRecords(server.readJournal(RUN), BACKGROUND_CONTEXT);
  assert.equal(entries.filter((entry) => entry.kind === "agentrun.person.asked" && entry.data?.inClaim !== true).length, 0, "no park entry was written (only the wait's own, in the claim)");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  const last = modelCalls(gw).at(-1).body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the person's message is the next user turn");
  const asks = modelCalls(gw).flatMap((call) => (call.body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block?.type === "tool_use" && block?.name === "ask_person"));
  assert.equal(asks.length, 1, `ask_person was asked once: ${asks.length}`);
});

test("wait in the claim: a hold that lapses before the answer (the cap refused more of the person's time, or the browser went) parks the run on its question, and the answer resumes it from the park", async (t) => {
  const wait = fakeWait();
  const { server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  wait.lapse("spend_cap_reached: no room for more of your time");
  const parked = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "parked" && now.runner === null && now;
  }, "the lapsed wait parks the run");
  assert.equal(parked.state, "parked");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  assert.equal(wait.seen.confirmed ?? 0, 1, "a hold that lapsed is confirmed to its host as its lapse, once");
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required");
  assert.equal(view.pending?.question, QUESTION, JSON.stringify(view.pending));
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer resumes it from the park");
});

/** The claim's session with the send of `text` held until the test refuses it: `sending` settles once that send was
 *  made, `refuse()` fails it, once. Every other send goes through. */
function refusedSend(text) {
  let made = () => {};
  const sending = new Promise((resolve) => (made = resolve));
  let refuse = () => {};
  const refused = new Promise((_, reject) => (refuse = () => reject(new Error("the session refused the message"))));
  refused.catch(() => undefined);
  let once = false;
  const sessionOf = (session) => new Proxy(session, {
    get: (target, key) => {
      if (key === "send") return async (content, ...rest) => {
        if (content !== text || once) return target.send(content, ...rest);
        once = true;
        made();
        return refused;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { sessionOf, sending, refuse: () => refuse() };
}

test("wait in the claim: a hold that lapses while the person's answer is being placed, the answer then refused, parks the run on its question, the lapse confirmed to its host, and a later answer resumes it", async (t) => {
  const wait = fakeWait();
  const ANSWER = "us-west-2";
  const send = refusedSend(ANSWER);
  const outcomes = [];
  const { server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen), sessionOf: send.sessionOf, outcomes });
  const sent = await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } });
  await send.sending;
  // The hold lapses while the answer is in the session's hands: the answer's turn would stand, so the wait holds on.
  wait.lapse("spend_cap_reached: no room for more of your time");
  await new Promise((resolve) => setTimeout(resolve, 100));
  send.refuse();
  const { outcome } = await until(() => outcomes.find((one) => one.id === sent.id), "the loop's answer to the person's message");
  assert.ok("refused" in outcome, `the answer the session refused is refused: ${JSON.stringify(outcome)}`);
  // Nothing more reaches the wait: its hold has lapsed and the answer was refused, so the run parks on its question at once,
  // never left running in a claim that holds nothing.
  const end = Date.now() + 5_000;
  let now = await server.runs.get(RUN);
  while (!(now.state === "parked" && now.runner === null) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    now = await server.runs.get(RUN);
  }
  assert.equal(now.state, "parked", `the lapsed wait parks once the answer is refused: ${JSON.stringify({ state: now.state, runner: now.runner })}`);
  assert.equal(wait.seen.confirmed ?? 0, 1, "the lapse is confirmed to its host, once");
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required");
  assert.equal(view.pending?.question, QUESTION, JSON.stringify(view.pending));
  await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } });
  await until(async () => {
    const again = await server.runs.get(RUN);
    return again.state === "ended" && again.runner === null && again;
  }, "a later answer resumes it from the park");
});

/** A claim's MCP that left the server `gw` out of its tools (ClaimMcp.leftOut) and finds it connected at every check
 *  since (`fresh`): a message the claim is handed reads as one that hands gw's credential. */
const leftOutGw = { tools: [], unconnected: ["gw"], leftOut: ["gw"], catalogOf: () => undefined, argumentsOf: () => undefined, priceOf: () => undefined, effectOf: () => undefined, fresh: async () => [], release: () => {} };

test("wait in the claim: a message that hands the credential of a server the claim left out ends the wait at once, never held to the hold's lapse: the run parks on its question, and that message and the person's answer after it run in the order they came", async (t) => {
  const wait = fakeWait();
  const CREDENTIAL = "Here is gw's credential.";
  const ANSWER = "us-west-2";
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen), mcpOf: (claim) => (claim === 1 ? leftOutGw : undefined) });
  assert.equal(row.state, "running", "the run waits in its claim");
  await sendCommand(server, RUN, { kind: "steer", body: { text: CREDENTIAL } });
  await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } });
  // The hold never lapses here (fakeWait lapses only on the test's word): a run still waiting on it would never end.
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the run ends without waiting out the hold", 15_000);
  assert.ok(ended.epoch > row.epoch + 1, `the wait ended in a park and the messages ran on a new claim: epoch ${row.epoch} -> ${ended.epoch}`);
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  assert.equal(wait.seen.confirmed ?? 0, 0, "never recorded as the host's lapse");
  const last = JSON.stringify(modelCalls(gw).at(-1).body.messages ?? []);
  assert.ok(last.includes(CREDENTIAL) && last.includes(ANSWER), `both messages reached the model: ${last.slice(-600)}`);
  assert.ok(last.indexOf(CREDENTIAL) < last.indexOf(ANSWER), `in the order they came: ${last.slice(-600)}`);
});

// A message that hands the credential of a server the claim left out, left for the run's next turn before the wait
// holds: as the turn that asks has ended, before the wait starts (adapter-loop's beforePersonWait), or while the wait is
// starting, its host asked to hold (the host's personWait). Either way the run parks at once on its question.
for (const window of ["before the wait starts", "while the host is asked to hold"]) {
  test(`wait in the claim: a message that hands the credential of a server the claim left out, left for the next turn ${window}, parks the run at once, never held to the hold's lapse; the answer runs after that message`, async (t) => {
    const wait = fakeWait();
    const outcomes = [];
    const CREDENTIAL = "Here is gw's credential.";
    const ANSWER = "us-west-2";
    let server;
    let sent;
    // The message, then the person's answer: each left for the run's next turn.
    const leave = async () => {
      if (sent) return;
      sent = [await sendCommand(server, RUN, { kind: "steer", body: { text: CREDENTIAL } }), await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } })];
      for (const one of sent) {
        const { outcome } = await until(() => outcomes.find((seen) => seen.id === one.id), "the message reached the loop");
        assert.ok("later" in outcome, `left for the run's next turn: ${JSON.stringify(outcome)}`);
      }
    };
    const holding = window === "while the host is asked to hold";
    const personWait = holding ? async (...args) => (await leave(), wait.personWait(...args)) : wait.personWait;
    const loopOptions = holding ? {} : { beforePersonWait: leave };
    // The hold never lapses here (fakeWait lapses only on the test's word): a run still waiting on it would never end.
    let claims = 0;
    const mcpOf = (claim) => ((claims = claim), claim === 1 ? leftOutGw : undefined);
    const { gw } = await askRun(t, { tools: ["ask_person"], personWait, loopOptions, outcomes, mcpOf, settled: async (s) => {
      server = s;
      const now = await s.runs.get(RUN);
      return now.state === "ended" && now.runner === null && now;
    } });
    assert.ok(sent, "the messages were sent in the window");
    assert.ok(claims >= 2, `the claim parked and a new one ran the messages: ${claims} claim(s)`);
    if (holding) assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
    else assert.deepEqual(wait.seen.asked, [], "the host was never asked to hold");
    assert.equal(wait.seen.confirmed ?? 0, 0, "never recorded as the host's lapse");
    const last = JSON.stringify(modelCalls(gw).at(-1).body.messages ?? []);
    assert.ok(last.includes(CREDENTIAL) && last.includes(ANSWER) && last.indexOf(CREDENTIAL) < last.indexOf(ANSWER), `both, in the order they came: ${last.slice(-600)}`);
  });
}

// A message handed on while the session was still new waits for the run's first input (adapter-loop's afterFirst): its
// row reads taken at once, so the runner hands on the next row while it is still to be placed. Placed once the run waits
// in its claim on its question, it is the person's answer, and a message handed on meanwhile that hands the credential of
// a server the claim left out is left for the next turn while the answer is in the session's hands. The answer refused,
// no message reaches the wait any more: the run parks on its question at once, never held to the hold's lapse.
test("wait in the claim: an answer that waited for the run's first input, refused after a later message was left for the next turn, parks the run at once, never held to the hold's lapse", async (t) => {
  const wait = fakeWait();
  const outcomes = [];
  const EARLY = "Before you start: keep it short.";
  const ANSWER = "us-west-2";
  const CREDENTIAL = "Here is gw's credential.";
  // gw is left out of the first claim's tools and still unconnected at each check, until the credential's message.
  let handing = false;
  let claims = 0;
  const mcpOf = (claim) => ((claims = claim), claim === 1 ? { ...leftOutGw, fresh: async () => (handing ? [] : ["gw"]) } : undefined);
  let early;
  const queued = () => early && early.every((row) => outcomes.some((one) => one.id === row.id && "taken" in one.outcome));
  // The first claim's session: its input sent once both early messages are queued behind it; the early message's steer
  // into the first turn held until the test refuses it; the answer's send held until the test refuses it.
  let steerMade = () => {};
  const steerHeld = new Promise((resolve) => (steerMade = resolve));
  let refuseSteer = () => {};
  const steerRefused = new Promise((_, reject) => (refuseSteer = () => reject(new Error("the session refused the steer"))));
  steerRefused.catch(() => undefined);
  let answerMade = () => {};
  const answerHeld = new Promise((resolve) => (answerMade = resolve));
  let refuseAnswer = () => {};
  const answerRefused = new Promise((_, reject) => (refuseAnswer = () => reject(new Error("the session refused the message"))));
  answerRefused.catch(() => undefined);
  const sessionOf = (session, claim) => new Proxy(session, {
    get: (target, key) => {
      if (claim === 1 && key === "send") return async (content, ...rest) => {
        if (content === ANSWER) return (answerMade(), answerRefused);
        await until(queued, "both early messages queued for the run's first input");
        return target.send(content, ...rest);
      };
      if (claim === 1 && key === "steer") return async (text, ...rest) => (text === EARLY ? (steerMade(), steerRefused) : target.steer(text, ...rest));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The first turn's model request waits until the early message is in the session's hands: it is steered into that turn.
  let requests = 0;
  const upstream = async (input, init) => {
    if (new URL(String(input?.url ?? input)).pathname.endsWith("/messages") && requests++ === 0) await steerHeld;
    return globalThis.fetch(input, init);
  };
  const beforeStart = async (s) => {
    early = [await sendCommand(s, RUN, { kind: "steer", body: { text: EARLY } }), await sendCommand(s, RUN, { kind: "steer", body: { text: ANSWER } })];
  };
  const { row, server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen), outcomes, mcpOf, sessionOf, upstream, beforeStart });
  assert.equal(row.state, "running", "the run waits in its claim");
  refuseSteer();
  // The answer, queued behind the early message, is placed as the wait's answer: its send is in the session's hands.
  await answerHeld;
  handing = true;
  const credential = await sendCommand(server, RUN, { kind: "steer", body: { text: CREDENTIAL } });
  const { outcome } = await until(() => outcomes.find((one) => one.id === credential.id), "the loop's answer to the credential's message");
  assert.ok("later" in outcome, `left for the run's next turn: ${JSON.stringify(outcome)}`);
  refuseAnswer();
  // The hold never lapses here (fakeWait lapses only on the test's word): a run still waiting on it would never end.
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the run parks on its question and its next claim runs the messages, without waiting out the hold", 15_000);
  assert.ok(ended.epoch > row.epoch + 1, `the wait ended in a park and the messages ran on a new claim: epoch ${row.epoch} -> ${ended.epoch}`);
  assert.ok(claims >= 2, `a new claim ran the messages: ${claims} claim(s)`);
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  assert.equal(wait.seen.confirmed ?? 0, 0, "never recorded as the host's lapse");
});

// A run reopened by a trigger's message into a session on its owner's sign-in (personOnly): that message, the reopen's
// own, is refused, so the claim's turn is never sent. A person's message after it is no reopen's message: one that hands
// the credential of a server the claim left out waits for the run's next turn, on a claim that lists the server's tools,
// never run as this claim's turn without them.
test("reopen: when the reopen's own message is refused, a later message that hands the credential of a server the claim left out runs on the next claim, never as the turn of the claim that left the server out", async (t) => {
  const TRIGGER = "A push came in.";
  const CREDENTIAL = "Here is gw's credential.";
  const outcomes = [];
  /** Each text a claim's session was sent or steered, with the claim's number. */
  const placed = [];
  const sessionOf = (session, claim) => new Proxy(session, {
    get: (target, key) => {
      if (key === "send" || key === "steer") return async (text, ...rest) => (placed.push({ text, claim }), target[key](text, ...rest));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { row, server, restart } = await askRun(t, { tools: ["ask_person"], drive: () => undefined, personOnly: "this session runs on its owner's sign-in: a trigger's message is not placed in it", mcpOf: (claim) => (claim === 2 ? leftOutGw : undefined), sessionOf, outcomes });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  // Both rows in before the reopen's claim, so its first read hands both on, the trigger's first.
  let trigger;
  let credential;
  await restart(async () => {
    trigger = await server.runs.reopen(RUN, { kind: "steer", body: { text: TRIGGER, answers: false, origin: { kind: "trigger", trigger_id: "trigger-1", source: "webhook", owner: false } } });
    credential = await sendCommand(server, RUN, { kind: "steer", body: { text: CREDENTIAL } });
  });
  await until(async () => {
    const now = await server.runs.get(RUN);
    const taken = (await server.commands(RUN, 0)).find((one) => one.id === credential.id)?.takenAt != null;
    return now.state === "ended" && now.runner === null && taken && now;
  }, "the credential's message runs and the run ends");
  assert.ok("refused" in (outcomes.find((one) => one.id === trigger.id)?.outcome ?? {}), `the trigger's message is refused: ${JSON.stringify(outcomes)}`);
  const first = outcomes.find((one) => one.id === credential.id)?.outcome;
  assert.ok(first && "later" in first, `the credential's message is left for the run's next turn on the claim that left gw out: ${JSON.stringify(outcomes)}`);
  const ran = placed.filter((one) => one.text.includes(CREDENTIAL));
  assert.ok(ran.length > 0 && ran.every((one) => one.claim > 2), `the credential's message ran on a claim after the one that left gw out: ${JSON.stringify(placed)}`);
});

// A run a person stopped before its first input was sent (as during a harness's first-use install: its session never
// sent anything), reopened by a trigger's message into a session on its owner's sign-in (personOnly; the pi spec carries
// it here, and the check that refuses the message reads no harness). The reopen's own message is refused, so no message
// is the claim's turn: the claim sends nothing into the session that never started, never asks again for an output the
// run never gave, and ends the run on the end it had before, its stop. A message handed on after that refusal is left for
// the run's next claim, which sends it after the job's input, as the first input of a run stopped before it is.
const TRIGGER_BODY = { text: "A push came in.", answers: false, origin: { kind: "trigger", trigger_id: "trigger-1", source: "webhook", owner: false } };
const SIGN_IN_ONLY = "this session runs on its owner's sign-in: a trigger's message is not placed in it";
const JOB = "Pick a region.";

/** A run stopped before its first input, then reopened (no runner up meanwhile) by the trigger's message, settled once
 *  the reopen's claim let it go (and `done(server, rows)` holds): its row when it stopped, its row now, the model
 *  requests, each text a claim's session was sent or steered (with the claim's number), and the loop's answers to the
 *  rows. */
async function stoppedThenReopened(t, { done, outcomes = [], ...options } = {}) {
  const placed = [];
  const sessionOf = (session, claim) => new Proxy(session, {
    get: (target, key) => {
      if (key === "send" || key === "steer") return async (text, ...rest) => (placed.push({ text, claim }), target[key](text, ...rest));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let stopSent = false;
  const { row: stopped, server, gw, restart } = await askRun(t, { tools: ["ask_person"], stoppedBeforeInput: true, personOnly: SIGN_IN_ONLY, sessionOf, outcomes, ...options, settled: async (s) => {
    const now = await s.runs.get(RUN);
    if (!stopSent && now.runner !== null) {
      stopSent = true;
      await sendCommand(s, RUN, { kind: "stop", body: {} });
    }
    return now.state === "stopped" && now.runner === null && now;
  } });
  assert.deepEqual(placed, [], "nothing was sent before the stop");
  let trigger;
  await restart(async () => {
    trigger = await server.runs.reopen(RUN, { kind: "steer", body: TRIGGER_BODY });
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    const rows = await server.commands(RUN, 0);
    const refused = rows.find((one) => one.id === trigger.id)?.refused != null;
    return refused && now.runner === null && ["parked", "ended", "stopped", "failed"].includes(now.state) && now.epoch > stopped.epoch && (await (done ?? (() => true))(server, rows)) && now;
  }, "the reopen's claim let the run go");
  return { stopped, row, server, gw, placed, outcomes, trigger };
}

test("reopen of a run stopped before its first input, by a trigger's message its session refuses: the run is back at its stop, nothing sent and no model request", async (t) => {
  const { stopped, row, gw, placed, outcomes, trigger } = await stoppedThenReopened(t);
  assert.deepEqual([stopped.state, stopped.outcome], ["stopped", "stopped"], JSON.stringify(stopped));
  assert.deepEqual(outcomes.find((one) => one.id === trigger.id)?.outcome, { refused: SIGN_IN_ONLY }, "the trigger's message is refused");
  assert.deepEqual([row.state, row.outcome, row.summary], [stopped.state, stopped.outcome, stopped.summary], `back at the end it had before, never ended over its stop: ${JSON.stringify(row)}`);
  assert.deepEqual(placed, [], "nothing was sent into the session that never started");
  assert.equal(modelCalls(gw).length, 0, "no model request");
});

test("reopen of a run stopped before its first input, with an output schema, by a trigger's message its session refuses: no output retry is asked, no model request, and the run is back at its stop", async (t) => {
  const outputSchema = { type: "object", properties: { region: { type: "string" } }, required: ["region"] };
  const { stopped, row, gw, placed } = await stoppedThenReopened(t, { outputSchema });
  assert.deepEqual([row.state, row.outcome, row.summary], [stopped.state, stopped.outcome, stopped.summary], `back at the end it had before: ${JSON.stringify(row)}`);
  assert.deepEqual(placed, [], `no output retry, nor anything else, was sent into the session that never started: ${JSON.stringify(placed)}`);
  assert.equal(modelCalls(gw).length, 0, "no model request");
});

test("reopen of a run stopped before its first input, by a trigger's message its session refuses, then a person's message as the claim ends: that message is left for the run's next claim, never placed into the session that never started, and runs there after the job's input", async (t) => {
  const PERSON = "Use the cheapest region.";
  // The person's message comes once the reopen's claim, woken by the refusal, ends the run: while its end is written.
  let server;
  let person;
  const outcomes = [];
  const endCheckout = async (claim, own) => {
    if (claim === 2 && !person) {
      person = await sendCommand(server, RUN, { kind: "steer", body: { text: PERSON } });
      await until(() => outcomes.some((one) => one.id === person.id), "the loop answered the person's message");
    }
    await own?.();
  };
  const done = async (_server, rows) => rows.find((one) => one.id === person?.id)?.takenAt != null;
  const { row, gw, placed } = await stoppedThenReopened(t, { outcomes, endCheckout, drive: () => undefined, done, beforeStart: (s) => void (server = s) });
  const first = outcomes.find((one) => one.id === person.id)?.outcome;
  assert.ok(first && "later" in first, `left for the run's next claim, never reported taken on the claim that sends nothing: ${JSON.stringify(outcomes)}`);
  const sentPerson = placed.filter((one) => one.text.includes(PERSON));
  assert.ok(sentPerson.length > 0 && sentPerson.every((one) => one.claim > 2), `placed only on a claim after the reopen's: ${JSON.stringify(placed)}`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const asked = JSON.stringify(modelCalls(gw).at(0)?.body?.messages ?? []);
  assert.ok(asked.includes(JOB) && asked.includes(PERSON) && asked.indexOf(JOB) < asked.indexOf(PERSON), `its turn carries the job's input, then the message: ${asked.slice(0, 600)}`);
});

test("wait in the claim: a stop while the run waits ends it stopped, and the hold is dropped", async (t) => {
  const wait = fakeWait();
  const { server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  await sendCommand(server, RUN, { kind: "stop", body: {} });
  const stopped = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "stopped" && now.runner === null && now;
  }, "the stop ends the waiting run");
  assert.equal(stopped.state, "stopped");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
});

test("wait in the claim: a host that holds nothing (no browser session open) leaves the park as it was", async (t) => {
  const wait = fakeWait({ holds: false });
  const { row } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait });
  assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(wait.seen.asked.length, 1, "the host was asked");
});

/** The person's answer `sent` (or none yet), and the loop's outcome for it, from `outcomes`. */
const answerOf = (outcomes, sent) => (sent ? outcomes.find((one) => one.id === sent.id)?.outcome : undefined);
/** The run settled after an answer that came during its park: ended, or parked again with that answer's row taken (lost:
 *  nothing is left to wake it), its runner gone either way. */
const settledAfter = (box) => async (s) => {
  box.server = s;
  const now = await s.runs.get(RUN);
  if (now.runner !== null || !box.sent) return undefined;
  const taken = (await s.commands(RUN, 0)).find((row) => row.id === box.sent.id)?.takenAt != null;
  return (now.state === "ended" || (now.state === "parked" && taken)) && now;
};

// The browser's cap case (browser-take-over.test.mjs, cap: Take over): the run's turn ends on its question, no hold of
// the person's time fits its cap, so it parks, and the person answers while the park lets the browser's session go (its
// host's release, before the park's seal). That answer is the resume's, never placed into a turn the seal then cuts:
// placed so, its row was taken, the run parked with nothing left to wake it, and it read working/idle for good.
for (const [name, personWait] of [["a host that holds nothing (no room under the cap)", () => fakeWait({ holds: false }).personWait], ["no host to hold anything", () => undefined]]) {
  test(`park on a question, ${name}: the person's answer that lands while the park releases its host waits for the resume, and resumes the run to its end`, async (t) => {
    const box = {};
    const outcomes = [];
    // Inside the park's release, before its seal: the answer sent, and the loop's answer to it awaited there.
    const beforeRelease = async () => {
      if (box.sent) return;
      box.sent = await sendCommand(box.server, RUN, { kind: "steer", body: { text: "us-west-2" } });
      await until(() => answerOf(outcomes, box.sent), "the loop's answer to the person's message");
    };
    const { row, gw } = await askRun(t, { tools: ["ask_person"], personWait: personWait(), beforeRelease, outcomes, settled: settledAfter(box) });
    const view = await viewOverStore(box.server, RUN, VIEW_DEPS);
    assert.equal(row.state, "ended", `the answer resumed the run to its end, never lost to the park: ${row.state}, the view ${view.status}/${view.state}, the loop answered ${JSON.stringify(answerOf(outcomes, box.sent))}`);
    assert.ok("later" in answerOf(outcomes, box.sent), "left for the resume during the park");
    const last = modelCalls(gw).at(-1).body;
    assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the answer was the resumed run's turn");
  });
}

test("park on a question with no host to hold anything: the person's answer that lands between the question's turn end and the park is its next turn, in the same claim", async (t) => {
  const box = {};
  // Fires once the turn ended on its question, before the park (adapter-loop's beforePersonWait): the answer lands there,
  // placed as a steer of the idle session.
  const beforePersonWait = async () => {
    if (box.sent) return;
    box.sent = await sendCommand(box.server, RUN, { kind: "steer", body: { text: "us-west-2" } });
    await until(async () => (await box.server.commands(RUN, 0)).find((row) => row.id === box.sent.id)?.takenAt != null, "the answer taken");
  };
  const { row, gw } = await askRun(t, { tools: ["ask_person"], loopOptions: { beforePersonWait }, settled: settledAfter(box) });
  const view = await viewOverStore(box.server, RUN, VIEW_DEPS);
  assert.ok(box.sent, "the answer was sent in the window");
  assert.equal(row.state, "ended", `the answer's turn ended the run, never cut by the park: ${row.state}, the view ${view.status}/${view.state}`);
  const { entries } = await journalRecords(box.server.readJournal(RUN), BACKGROUND_CONTEXT);
  assert.equal(entries.filter((entry) => entry.kind === "agentrun.person.asked").length, 0, "in the same claim: no park entry was written");
  const last = modelCalls(gw).at(-1).body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the answer was the run's next turn");
});

test("wait in the claim: the person's answer that lands between the turn's end and the wait's start ends the wait at once, in the same claim, never held to its bound", async (t) => {
  const wait = fakeWait();
  let server;
  let sent;
  // Fires at the start of the wait, before it takes the person's message (adapter-loop's beforePersonWait): the answer
  // lands there, placed as a steer of the idle session.
  const beforePersonWait = async () => {
    if (sent) return;
    sent = await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
    await until(async () => (await server.commands(RUN, 0)).find((row) => row.id === sent.id)?.takenAt != null, "the answer taken");
  };
  const opened = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, loopOptions: { beforePersonWait }, settled: async (s) => {
    server = s;
    const now = await s.runs.get(RUN);
    return now.state !== "queued" && now.state !== "running" && now.runner === null && now;
  } });
  assert.ok(sent, "the answer was sent in the window");
  assert.equal(opened.row.state, "ended", `the answer's turn ended the run, never held to the bound: ${JSON.stringify({ state: opened.row.state, summary: opened.row.summary })}`);
  const last = modelCalls(opened.gw).at(-1).body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the answer was the run's next turn");
});

test("wait in the claim across a re-claim: the next claim waits again from the ask's first start (the bound never restarts), and the answer ends the run", async (t) => {
  const wait = fakeWait();
  const { server, restart } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  const first = await server.runs.get(RUN);
  await restart();
  const again = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "running" && now.runner === "runner-b" && wait.seen.asked.length >= 2 && now;
  }, "the next claim waits again");
  assert.ok(again.epoch > first.epoch, "a new claim");
  assert.equal(wait.seen.since.length, 2);
  assert.equal(wait.seen.since[1], wait.seen.since[0], `the wait's start is the ask's first, from the journal: ${JSON.stringify(wait.seen.since)}`);
  assert.ok(Number.isFinite(wait.seen.since[0]));
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer ends the run");
});

test("wait in the claim: the run row says it waits on the person while its claim is held (the server tells run.needs_input from it), and says so no more once the answer is taken", async (t) => {
  const wait = fakeWait();
  const { row, server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  const waiting = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.summary === "Waiting for your reply" && now;
  }, "the row's waiting summary");
  assert.equal(waiting.state, "running");
  assert.notEqual(waiting.runner, null);
  assert.equal(waiting.epoch, row.epoch);
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer ends the run");
  assert.notEqual(ended.summary, "Waiting for your reply", "the waiting summary is gone with the answer");
});

/** The loop's answer to the trigger's row once it has one: `later` (left untaken), never taken as the answer nor refused. */
async function leftForLater(outcomes, trigger) {
  const { outcome } = await until(() => outcomes.find((one) => one.id === trigger.id), "the trigger's row reached the loop");
  assert.ok("later" in outcome, `the trigger's row is left untaken, never taken or refused: ${JSON.stringify(outcome)}`);
}

/** The person answers; the answer is the next request's, and the trigger's message runs after it as a turn of its own,
 *  its row taken and never refused: its firing's `sent` is true. */
async function answeredThenTheTrigger(server, gw, trigger) {
  const asks = modelCalls(gw).length;
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await until(async () => {
    const [r, rows] = [await server.runs.get(RUN), await server.commands(RUN, 0)];
    return r.state === "ended" && r.runner === null && rows.find((c) => c.id === trigger.id)?.takenAt !== null && r;
  }, "the answer's turn, then the trigger's, end the run");
  const row = (await server.commands(RUN, 0)).find((c) => c.id === trigger.id);
  assert.equal(row.refused, null, JSON.stringify(row));
  const asked = modelCalls(gw).slice(asks).map((call) => JSON.stringify(call.body?.messages ?? []));
  assert.ok(asked[0]?.includes("us-west-2") && !asked[0].includes("A push came in."), `the answer's request is the person's alone: ${asked[0]?.slice(-400)}`);
  assert.ok(asked.slice(1).some((body) => body.includes("A push came in.")), `the trigger's message is a later request: ${asked.length} requests`);
}

test("wait in the claim: a trigger's message (answers: false) delivered while the run waits is left untaken, never taken as the person's answer, and runs as a turn of its own after it", async (t) => {
  const wait = fakeWait();
  const outcomes = [];
  const { server, gw } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen), outcomes });
  const before = modelCalls(gw).length;
  const trigger = await sendCommand(server, RUN, { kind: "steer", body: { text: "A push came in.", answers: false } });
  // Not taken, it is no answer: the run reads waiting on its question still (the server tells run.needs_input by it).
  await leftForLater(outcomes, trigger);
  assert.equal((await viewOverStore(server, RUN, VIEW_DEPS)).status, "input_required", "a trigger's message counts as no answer");
  const now = await until(async () => {
    const r = await server.runs.get(RUN);
    return r.summary === "Waiting for your reply" && r;
  }, "the row's waiting summary").catch(() => server.runs.get(RUN));
  assert.deepEqual([now.state, now.summary], ["running", "Waiting for your reply"], "still waiting on the person");
  assert.equal(modelCalls(gw).length, before, "the agent was not resumed");
  await answeredThenTheTrigger(server, gw, trigger);
});

test("wait in the claim: a trigger's message (answers: false) delivered between the question's turn end and the wait's start is left untaken too, never taken as the answer", async (t) => {
  const wait = fakeWait();
  const outcomes = [];
  let server;
  let trigger;
  let wrong;
  const beforePersonWait = async () => {
    if (trigger) return;
    trigger = await sendCommand(server, RUN, { kind: "steer", body: { text: "A push came in.", answers: false } });
    // Kept, not thrown here: a throw in the loop's hook would end the claim, and the test would fail on a wait instead.
    await leftForLater(outcomes, trigger).catch((error) => (wrong = error));
  };
  const { gw } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, loopOptions: { beforePersonWait }, outcomes, settled: async (s) => {
    server = s;
    return wrong ? s.runs.get(RUN) : waitingInClaim(wait.seen)(s);
  } });
  if (wrong) throw wrong;
  // The wait's start lands just after its hold: the row says so then.
  const now = await until(async () => {
    const r = await server.runs.get(RUN);
    return r.summary === "Waiting for your reply" && r;
  }, "the row's waiting summary").catch(() => server.runs.get(RUN));
  assert.deepEqual([now.state, now.summary], ["running", "Waiting for your reply"], "the run waits on its person");
  await answeredThenTheTrigger(server, gw, trigger);
});

test("park: a trigger's message (answers: false) that reaches the runner while the turn that asks is in flight never runs before the answer: the run parks on its question, the row untaken, and the message runs as a turn of its own after the answer", async (t) => {
  const outcomes = [];
  let server;
  let trigger;
  let requests = 0;
  // The first model request held until the loop has the trigger's row: the message reaches the runner mid-turn, and the
  // turn then ends on ask_person.
  const upstream = async (input, init) => {
    if (new URL(String(input?.url ?? input)).pathname.endsWith("/messages") && requests++ === 0) {
      const store = await until(() => server, "the server's store");
      trigger = await sendCommand(store, RUN, { kind: "steer", body: { text: "A push came in.", answers: false } });
      await until(() => outcomes.some((one) => one.id === trigger.id), "the trigger's row reached the loop while the turn is in flight");
    }
    return globalThis.fetch(input, init);
  };
  const { row, gw } = await askRun(t, { tools: ["ask_person"], upstream, outcomes, settled: async (s) => {
    server = s;
    const now = await s.runs.get(RUN);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  } });
  assert.equal(row.state, "parked", `the run parks on its question, never ended by the trigger's message: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(modelCalls(gw).length, 1, "the trigger's message never reached the model while the question stood");
  const held = (await server.commands(RUN, 0)).find((c) => c.id === trigger.id);
  assert.deepEqual([held.takenAt, held.refused], [null, null], `the trigger's row waits untaken, never refused: ${JSON.stringify(held)}`);
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.deepEqual([view.status, view.state, view.pending?.kind], ["input_required", "waiting", "question"], "the question stands, unanswered");
  await answeredThenTheTrigger(server, gw, trigger);
});

test("a parked question's answer whose turn fails ends the run failed, never ended: the claim that resumes it reads the answer's own submission", async (t) => {
  let refuse = false;
  // Once the question is asked, the provider refuses every request for good (a 400 no retry fixes).
  const upstream = (url, init) => refuse
    ? Promise.resolve(new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "this request is refused (a test's upstream)" } }), { status: 400, headers: { "content-type": "application/json" } }))
    : globalThis.fetch(url, init);
  const { row, server } = await askRun(t, { tools: ["ask_person"], upstream });
  assert.equal(row.state, "parked");
  refuse = true;
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the answer's turn ends the run");
  assert.equal(ended.state, "failed", `its answer's turn failed, so the run did: ${JSON.stringify({ state: ended.state, summary: ended.summary })}`);
});
