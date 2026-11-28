// A computer that reaches less than the internet tells the model so once in the run, on its first request, as the
// server's note, and the person reading the run sees it once on its timeline: one made with network "none" (its
// provider makes no other, or the run allows none) that nothing on it reaches the internet; one made with an allow list
// the hosts it reaches, on ports 80 and 443, and that anything else is refused. One made open gets no such note. A
// resumed claim (a park on a tool's approval, then the approval) never tells it again. Through the runner, the pi spec
// and the adapter loop as they really run, the claim's computer the runner's own (claimComputer: the run's box_allow
// read from its launch row) and its spec built by the server's own spec builder (computerSpecOf).
//
// The sandbox is a loopback stand-in for Docker's over the run's folder; the model is a script.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { claimComputer, computerSpecOf } = await import("../dist/workspace/index.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
after(closeOpenSessions);

const TAIL = "Don't retry what fails for that; say in your answer what needed it. Tools of yours that don't run on the sandbox aren't affected.";
/** The notes the model is told, exactly, labelled as the server's: a sandbox with no network, and one on a list. */
const NONE = `AgentRun server note: this sandbox has no internet access: nothing on it reaches a website or a server outside it, so a page, a download or a package install from the internet fails there. ${TAIL}`;
const LISTED = `AgentRun server note: this sandbox reaches only these hosts on the internet, on ports 80 and 443: pypi.org, files.pythonhosted.org. Anything else from it is refused. ${TAIL}`;
/** Their rows on the run's timeline: the server's, labelled once. */
const rowOf = (note) => `AgentRun: T${note.slice("AgentRun server note: t".length)}`;
const NOTES = /AgentRun server note: this sandbox (?:has no internet access|reaches only these hosts)[^<]*/g;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Docker's stand-in: a box over the run's folder; each create's spec kept in `specs`. */
function box() {
  const made = [];
  const specs = [];
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      specs.push(spec);
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push({ ref, computer: fakeComputer(spec.mount.path) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      return { ok: true, value: { client: one.computer.client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release() {
      return { ok: true, value: undefined };
    },
  };
  return { provider, specs };
}

/** run-1 on a Docker sandbox, its launch stamped with `boxAllow` (the run's box_allow), run by a runner on the pi spec
 *  with `script` as its model; `spec`, given, stands in for the server's spec builder; `body`, the agent's; `approvers`,
 *  given, the server's approvers row. Each pi request's body is kept in `requests`. */
async function sandboxRun(t, { script, boxAllow, spec, body = { tools: ["read", "write"] }, approvers }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-reach-note-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: { kind: "sandbox", provider: "docker" }, ...body } });
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, ...(boxAllow === undefined ? {} : { box_allow: boxAllow }) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  if (approvers !== undefined) await server.settings.put("approvers", { approvers });
  await server.flush?.();
  const docker = box();
  const requests = [];
  const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests) };
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: spec ?? computerSpecOf({}), check: { readBackOf } };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: claimComputer, computerDeps };
  runner = startRunner({ store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  return { server, requests, docker };
}

/** Until the run rests in one of `states`, released; its row. */
const rests = (one, states) => until(async () => {
  const now = await one.server.runs.get(RUN);
  return [...states, "failed", "stopped"].includes(now.state) && now.runner === null && now;
}, `the run rests (${states.join(", ")})`);

const count = (requests) => requests.map((body) => (JSON.stringify(body).match(NOTES) ?? []).length);
const reachRows = async (one) => (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary).filter((summary) => /^AgentRun: This \w+ (?:has no internet access|reaches only these hosts)/.test(summary ?? ""));

const WRITE = { call: "write", args: { path: "notes.txt", content: "looked" } };

for (const [what, boxAllow, network, note] of [
  ["no network (box_allow none)", "none", "none", NONE],
  ["an allow list (box_allow)", ["pypi.org", "files.pythonhosted.org"], { allow: ["pypi.org", "files.pythonhosted.org"] }, LISTED],
]) {
  test(`a sandbox the run gives ${what}: the spec asks it, the model's first request carries the reach note once, in its words, and the timeline shows it once`, { timeout: 120_000 }, async (t) => {
    const one = await sandboxRun(t, { script: [WRITE, { say: "done" }], boxAllow });
    const row = await rests(one, ["ended"]);
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.deepEqual(one.docker.specs[0]?.network, network, "the sandbox was made with it");
    assert.equal(one.requests.length, 2, "a write, then the answer");
    assert.deepEqual(count(one.requests), [1, 0], "the first request carries it, the next does not");
    assert.equal(JSON.stringify(one.requests[0]).match(NOTES)[0], note, "in its exact words");
    assert.deepEqual(await reachRows(one), [rowOf(note)], "one row of the server's, labelled once");
  });
}

test("a sandbox made open: no request carries a reach note and the timeline shows none", { timeout: 120_000 }, async (t) => {
  const one = await sandboxRun(t, { script: [WRITE, { say: "done" }], spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "open" }) });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(one.docker.specs[0]?.network, "open", "the sandbox was made open");
  assert.equal(one.requests.length, 2, "a write, then the answer");
  assert.deepEqual(count(one.requests), [0, 0], "no request carries a reach note");
  assert.doesNotMatch(JSON.stringify(one.requests), /has no internet access|reaches only these hosts/, "nor any words of one");
  assert.deepEqual(await reachRows(one), [], "no row");
});

test("the reach note is told once a run: the claim that resumes it after a park never tells it again", { timeout: 120_000 }, async (t) => {
  const one = await sandboxRun(t, {
    script: [WRITE, { say: "done" }],
    boxAllow: "none",
    body: { tools: ["read", "write"], toolSettings: { write: { permission: "ask" } } },
    approvers: true,
  });
  const parked = await rests(one, ["ended", "parked"]);
  assert.equal(parked.state, "parked", JSON.stringify(parked));
  const records = await journalRecords(one.server.journal({ runId: RUN, runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), ctx);
  const [ask] = records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.ok(ask, "parked on the write's ask");
  const before = one.requests.length;
  await one.server.command(RUN, { kind: "approve", body: { approval: ask.callId } });
  const row = await until(async () => {
    const now = await one.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ends");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(one.requests.length > before, "the resume asked the model");
  assert.equal(count(one.requests).reduce((a, b) => a + b, 0), 1, `the reach note once in the whole run: ${JSON.stringify(count(one.requests))}`);
  assert.deepEqual(await reachRows(one), [rowOf(NONE)], "its row once");
});
