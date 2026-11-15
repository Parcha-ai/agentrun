// A sandbox run resumed on a fresh sandbox after its earlier claim deleted its own (a server's clean stop): the provider
// lists no older computer of the run, so the one fact the later claim has is the run's journal, where the earlier claim's
// pass recorded the computer it made (agentrun.computer.made). The resumed claim's ready line says it's a new sandbox,
// and the model's first request after the resume carries the server's note once, in the sandbox's words; the first claim
// gets neither. A park keeps the sandbox 10 minutes (computer-kept.ts): a resume within them goes on on the same one, what
// it holds outside the run's folder still there, never called new; one after them is told as after a stop. Through the runner, its store and the spec builder pi really uses (adapter-run-spec.ts); the
// sandbox is a loopback stand-in for Docker's (the kind registry is workspace-kinds-fixture.mjs), and the model a script.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
after(closeOpenSessions);

/** The sandbox's note, exactly (Mode 1: no kept run folder). */
const NOTE = "AgentRun server note: your computer was replaced. The earlier one is gone, with its files and processes. Check its files again before relying on them.";
const NOTES = /AgentRun server note: your computer was replaced[^<]*/g;
const READY = "The sandbox is ready: Linux (amd64), from Docker.";
const NEW_ONE = `${READY} It's a new sandbox: the one before is gone, with what was on it.`;
const ROW = "AgentRun: Your computer was replaced. The earlier one is gone, with its files and processes. Check its files again before relying on them.";

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Docker's stand-in: each claim's sandbox made over the run's folder it binds, and deleted at its release; it lists only
 *  the sandboxes it holds now, so a claim after a release finds none to let go of. */
function sandboxes() {
  const held = new Map();
  const made = [];
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    async list(labels) {
      const listed = [...held.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: listed.map((one) => ({ ref: one.ref, labels: one.labels, state: "running", network: "none" })) };
    },
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push(ref.id);
      // The sandbox's own /tmp, outside the run's folder: `cat /tmp/<name>` prints what it holds, else fails.
      const tmp = new Map();
      const computer = fakeComputer(spec.mount.path);
      let argv = [];
      computer.overrides["process.start"] = (params) => ((argv = params.argv), { id: "p1", pid: 42 });
      computer.overrides["process.read"] = ({ stream, offset }) => {
        const file = /cat \/tmp\/(\S+)/.exec(argv.join(" "))?.[1];
        const text = stream === "stdout" && offset === 0 && file && tmp.has(file) ? tmp.get(file) : "";
        return { data: Buffer.from(text).toString("base64"), nextOffset: offset + Buffer.byteLength(text), dropped: 0, exited: true };
      };
      held.set(ref.id, { ref, labels: spec.labels, computer, tmp });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      return { ok: true, value: { client: held.get(ref.id).computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } };
    },
    async attach(ref) {
      const read = await held.get(ref.id).computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      held.delete(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return { provider, made, held };
}

async function opened(t, body = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-replaced-sandbox-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [server];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores.reverse()) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer: { kind: "sandbox", provider: "docker" }, ...body } });
  const launch = { input: { content: "Work." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  // Someone can answer an ask (server-approvers.ts APPROVERS_KEY), so a tool's ask parks.
  await server.settings.put("approvers", { approvers: true });
  await server.flush?.();
  const docker = sandboxes();
  const clock = { offset: 0 };
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf }, now: () => Date.now() + clock.offset };
  /** A runner named `name` on its own store connection, its model `fetch`. */
  const start = async (name, fetch) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
    const runner = startRunner({ store, name, ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
    runners.push(runner);
    return runner;
  };
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run is released ${states.join(" or ")}`);
  const summaries = async () => (await runTimeline(server, RUN, ctx)).map((row) => row.summary);
  const made = async () => {
    const row = await server.runs.get(RUN);
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    return JSON.stringify(records).match(/agentrun\.computer\.made/g)?.length ?? 0;
  };
  /** The run's open ask, at its park. */
  const ask = async () => {
    const row = await server.runs.get(RUN);
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    return records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data).at(-1);
  };
  return { server, docker, clock, start, settled, summaries, made, ask };
}

const reminders = (body) => JSON.stringify(body).match(NOTES) ?? [];
/** The server's rows of the replaced computer, each checked labelled once. */
const serverRows = (said) => {
  assert.ok(!said.some((summary) => summary?.includes("AgentRun server note")), `no row is labelled twice: ${JSON.stringify(said)}`);
  return said.filter((summary) => summary?.startsWith("AgentRun: Your computer"));
};

test("a server's clean stop mid-request, then a restart: the resumed sandbox run's ready line says it's a new sandbox, and its first request carries the sandbox's note once; the first claim gets neither", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  // The first runner's request is in flight until the stop cuts it.
  const before = [];
  let inFlight;
  const asked = new Promise((resolve) => (inFlight = resolve));
  const cuts = [];
  const hanging = async (_url, init = {}) => {
    before.push(JSON.parse(String(init.body ?? "{}")));
    inFlight();
    return await new Promise((_resolve, reject) => {
      const cut = () => reject(Object.assign(new Error("the server stopped"), { name: "AbortError" }));
      cuts.push(cut);
      init.signal?.addEventListener("abort", cut, { once: true });
    });
  };
  const first = await run.start("runner-a", hanging);
  await asked;
  assert.equal(run.docker.held.size, 1, "the first claim's sandbox is up");
  const stopping = first.close();
  for (const cut of cuts) cut();
  await stopping;
  assert.equal(run.docker.held.size, 0, "the stop deleted it: the provider lists none of the run's");

  const after = [];
  await run.start("runner-b", scriptedOrigin([{ say: "done" }], after));
  const row = await run.settled(["ended"]);
  assert.equal(row.state, "ended");
  assert.deepEqual(run.docker.made, ["c1", "c2"], "a fresh sandbox for the resume");
  assert.deepEqual(before.map((body) => reminders(body).length), [0], "the first claim's request carries none");
  assert.ok(after.length >= 1, "the resume sent a request");
  assert.deepEqual(after.map(reminders), [[NOTE], ...after.slice(1).map(() => [])], "the resume's first request carries it once, in the sandbox's words; no later one");
  const said = await run.summaries();
  assert.deepEqual(said.filter((summary) => summary?.startsWith("The sandbox is ready")), [READY, NEW_ONE], "the first claim's ready line, then the resume's, which says it's a new sandbox");
  assert.deepEqual(serverRows(said), [ROW], "one row of the server's, labelled once");
  assert.ok(!said.some((summary) => summary?.includes("computer.made")), "the record is never on the Timeline");
  assert.equal(await run.made(), 2, "each claim's pass recorded the sandbox it made");
});

const HOLD = "The sandbox is kept for 10 minutes while you decide.";
const SAME = `${READY} It's the same sandbox, as the wait left it.`;
const LAPSED_NEW = `${READY} The sandbox wasn't kept: 10 minutes passed. It's a new sandbox: the one before is gone, with what was on it.`;
const BASH_ASKS = { tools: ["bash"], toolSettings: { bash: { permission: "ask" } } };
const CAT = [{ call: "bash", args: { command: "cat /tmp/outside-1" } }, { say: "done" }];

/** A sandbox run parked on its bash's ask, a file left in the sandbox's /tmp (outside the run's folder) before it. */
async function parkedOnBash(t) {
  const run = await opened(t, BASH_ASKS);
  const requests = [];
  await run.start("runner-a", scriptedOrigin(CAT, requests));
  const parked = await run.settled(["parked"]);
  assert.equal(parked.state, "parked");
  const ask = await run.ask();
  assert.ok(ask, "parked on the bash's ask");
  return { run, requests, ask };
}

test("a sandbox run parked on bash's ask and approved within 10 minutes goes on on the same sandbox: no create, the file outside its folder still there, no replaced row, no note", { timeout: 120_000 }, async (t) => {
  const { run, requests, ask } = await parkedOnBash(t);
  assert.deepEqual([...run.docker.held.keys()], ["c1"], "the park kept the sandbox");
  run.docker.held.get("c1").tmp.set("outside-1", "left before the park");
  run.clock.offset = 60_000;
  await run.server.command(RUN, { kind: "approve", body: { approval: ask.callId } });
  await run.settled(["ended"]);
  assert.deepEqual(run.docker.made, ["c1"], "no create at the resume");
  assert.match(JSON.stringify(requests.at(-1)), /left before the park/, "the approved bash read the file on the same sandbox");
  assert.deepEqual(requests.map(reminders).flat(), [], "no note to the model");
  const said = await run.summaries();
  assert.equal(said.filter((summary) => summary === HOLD).length, 1, `the park said it is kept: ${JSON.stringify(said)}`);
  assert.deepEqual(said.filter((summary) => summary?.startsWith("The sandbox is ready")), [READY, SAME], "the resume said it is the same one");
  assert.deepEqual(serverRows(said), [], "no replaced row");
  assert.equal(run.docker.held.size, 0, "the run's end let it go");
});

test("a sandbox run approved after 10 minutes goes on on a new sandbox: the kept one let go, said once with why, the replaced row and the note once", { timeout: 120_000 }, async (t) => {
  const { run, requests, ask } = await parkedOnBash(t);
  run.docker.held.get("c1").tmp.set("outside-1", "left before the park");
  run.clock.offset = 10 * 60_000 + 1_000;
  const first = requests.length;
  await run.server.command(RUN, { kind: "approve", body: { approval: ask.callId } });
  await run.settled(["ended"]);
  assert.deepEqual(run.docker.made, ["c1", "c2"], "a new sandbox");
  assert.doesNotMatch(JSON.stringify(requests.slice(first)), /left before the park/, "the file went with the kept one");
  assert.deepEqual(requests.slice(first).map(reminders), [[NOTE], ...requests.slice(first + 1).map(() => [])], "the model told once");
  const said = await run.summaries();
  assert.deepEqual(said.filter((summary) => summary?.startsWith("The sandbox is ready")), [READY, LAPSED_NEW], "said once, with why");
  assert.deepEqual(serverRows(said), [ROW], "the replaced row once");
  assert.equal(run.docker.held.size, 0, "nothing left");
});

test("an ask_person park keeps the sandbox too: the answer goes on on the same one", { timeout: 120_000 }, async (t) => {
  const run = await opened(t, { tools: ["ask_person"] });
  const requests = [];
  await run.start("runner-a", scriptedOrigin([{ call: "ask_person", args: { question: "Which region?" } }, { say: "done" }], requests));
  await run.settled(["parked"]);
  assert.equal(run.docker.held.size, 1, "kept at the park");
  await sendCommand(run.server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await run.settled(["ended"]);
  assert.deepEqual(run.docker.made, ["c1"], "the same sandbox");
  assert.deepEqual(requests.map(reminders).flat(), []);
  assert.deepEqual(serverRows(await run.summaries()), []);
});
