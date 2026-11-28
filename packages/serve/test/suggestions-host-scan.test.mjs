// A scan whose run its host starts (suggestions.ts Suggestions.scan with `start: "host"`): the server reserves the
// repository's row and answers the scout agent and the run's input, starting nothing; the host starts that run itself
// (under its own metered key and billing) and binds it with the claim's token. A claim binds one run of its scout, once;
// a bind with another token, after the claim lapsed (SCAN_CLAIM_MS), or of a run the server does not take as the scout's
// in this workspace, is the one 404, which names neither. The same bind sent again answers the same scan. Where the host
// must start a workspace's runs (`hostStarts`), a scan sent without `start: "host"` is refused before anything is reserved.
import assert from "node:assert/strict";
import { test } from "node:test";

const { Suggestions, SCAN_CLAIM_MS } = await import("../dist/suggestions.js");
const { ApiError } = await import("../dist/errors.js");

const REPO = "faux-org/demo";

/** The store's settings, in memory, as the store compares rows (their JSON). */
function settings() {
  const rows = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    putIfAbsent: async (key, value) => { if (!rows.has(key)) rows.set(key, structuredClone(value)); return structuredClone(rows.get(key)); },
    replaceIf: async (key, was, value) => { if (!rows.has(key) || !same(rows.get(key), was)) return false; rows.set(key, structuredClone(value)); return true; },
    removeIf: async (key, was) => { if (!rows.has(key) || !same(rows.get(key), was)) return false; rows.delete(key); return true; },
    all: async ({ prefix }) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value), updatedAt: 0 })),
  };
}

/** The service with a clock the test moves; `scout` runs are the ones the server takes as its scout's here. */
function service({ hostStarts = false } = {}) {
  let now = 1_000_000;
  const runs = { read: async () => ({ status: "running" }) };
  const started = [];
  const scoutRuns = new Set(["run_scout_1", "run_scout_2"]);
  const s = new Suggestions({
    settings: settings(),
    github: { view: () => undefined, settingsUrl: () => undefined, api: "http://127.0.0.1:9", repoInstallation: async () => ({ unusable: "none", reason: "not_connected" }), tokenWith: async () => ({ unusable: "none" }), revokeToken: async () => {} },
    scoutAgent: async () => "scout",
    startScan: async (agentId, content) => (started.push({ agentId, content }), "run_started_here"),
    readRun: (...args) => runs.read(...args),
    makeAgent: async () => { throw new Error("no create here"); },
    agentFrom: async () => undefined,
    cancelScan: async () => {},
    hostStarts: () => hostStarts,
    scoutRun: async (runId, agentId) => agentId === "scout" && scoutRuns.has(runId),
    now: () => now,
  });
  return { s, started, runs, tick: (ms) => (now += ms) };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return { code: error.code, message: error.message };
  }
  assert.fail("not refused");
};

test("start: host reserves the repository and answers the scout and the run's input, starting nothing", async () => {
  const { s, started } = service({ hostStarts: true });
  const reserved = await s.scan({ repo: REPO, start: "host" });
  assert.equal(reserved.status, 200);
  assert.equal(reserved.body.status, "starting");
  assert.equal(reserved.body.repo, REPO);
  assert.equal(reserved.body.agent_id, "scout");
  assert.match(reserved.body.input.content, /Scan https:\/\/github\.com\/faux-org\/demo/);
  assert.match(reserved.body.scan, /^[0-9a-f-]{36}$/);
  assert.deepEqual(started, [], "no run started here");
  // The row is held: a second scan, either way, is told one is starting.
  assert.equal((await refusal(s.scan({ repo: REPO, start: "host" }))).code, "home_busy");
});

test("where the host starts a workspace's runs, a scan without start: host is refused, and nothing is reserved", async () => {
  const { s, started } = service({ hostStarts: true });
  const refused = await refusal(s.scan({ repo: REPO }));
  assert.equal(refused.code, "agent_not_runnable");
  assert.match(refused.message, /start: "host"/);
  assert.deepEqual(started, []);
  // Nothing was reserved: the host's own start goes through at once.
  assert.equal((await s.scan({ repo: REPO, start: "host" })).body.status, "starting");
});

test("elsewhere a scan without start: host starts its run here, as before", async () => {
  const { s, started } = service({ hostStarts: false });
  const scanned = await s.scan({ repo: REPO });
  assert.equal(scanned.status, 202);
  assert.equal(scanned.body.run_id, "run_started_here");
  assert.equal(started.length, 1);
});

test("a bind with the claim's token binds the scout's run, once; the same bind again answers the same scan", async () => {
  const { s } = service({ hostStarts: true });
  const { body: claim } = await s.scan({ repo: REPO, start: "host" });
  const bound = await s.scan({ repo: REPO, run_id: "run_scout_1", scan: claim.scan });
  assert.deepEqual(bound, { status: 202, body: { repo: REPO, run_id: "run_scout_1", agent_id: "scout", status: "running", already_running: false } });
  assert.deepEqual(await s.scan({ repo: REPO, run_id: "run_scout_1", scan: claim.scan }), bound, "a replay answers the same");
  // Another run under the spent claim is not bound.
  const other = await refusal(s.scan({ repo: REPO, run_id: "run_scout_2", scan: claim.scan }));
  assert.equal(other.code, "not_found");
  const listed = await s.list({});
  assert.equal(listed.repositories.find((r) => r.repo === REPO)?.scan?.run_id, "run_scout_1");
});

test("a bind with another token, of a run not the scout's here, or after the claim lapsed is the one 404, naming neither", async () => {
  const { s, tick } = service({ hostStarts: true });
  const { body: claim } = await s.scan({ repo: REPO, start: "host" });
  const unknownToken = await refusal(s.scan({ repo: REPO, run_id: "run_scout_1", scan: "00000000-0000-4000-8000-000000000000" }));
  const notScouts = await refusal(s.scan({ repo: REPO, run_id: "run_other", scan: claim.scan }));
  assert.equal(unknownToken.code, "not_found");
  assert.equal(notScouts.code, "not_found");
  // The words name the request's own repository and run alone, so a foreign run reads as a missing one.
  assert.equal(notScouts.message, (await refusal(s.scan({ repo: REPO, run_id: "run_other", scan: "00000000-0000-4000-8000-000000000000" }))).message);
  // The claim still stands after refused binds.
  tick(SCAN_CLAIM_MS);
  const lapsed = await refusal(s.scan({ repo: REPO, run_id: "run_scout_1", scan: claim.scan }));
  assert.equal(lapsed.code, "not_found");
  // A lapsed claim holds nothing: a new reservation takes the row.
  assert.equal((await s.scan({ repo: REPO, start: "host" })).body.status, "starting");
});

test("a release with the claim's token frees the reservation: the next reserve goes through at once", async () => {
  const { s, started } = service({ hostStarts: true });
  const { body: claim } = await s.scan({ repo: REPO, start: "host" });
  assert.equal((await refusal(s.scan({ repo: REPO, start: "host" }))).code, "home_busy");
  const released = await s.scan({ repo: REPO, scan: claim.scan });
  assert.deepEqual(released, { status: 200, body: { repo: REPO, status: "released" } });
  assert.deepEqual(started, []);
  const next = await s.scan({ repo: REPO, start: "host" });
  assert.equal(next.body.status, "starting");
  assert.notEqual(next.body.scan, claim.scan);
  // The released claim binds nothing.
  assert.equal((await refusal(s.scan({ repo: REPO, run_id: "run_scout_1", scan: claim.scan }))).code, "not_found");
});

test("a release with another token, of a bound scan, or after the claim lapsed is the one 404, and the row stays", async () => {
  const { s } = service({ hostStarts: true });
  const { body: claim } = await s.scan({ repo: REPO, start: "host" });
  const other = await refusal(s.scan({ repo: REPO, scan: "00000000-0000-4000-8000-000000000000" }));
  assert.equal(other.code, "not_found");
  assert.equal((await refusal(s.scan({ repo: REPO, start: "host" }))).code, "home_busy", "another token frees nothing");
  // A bound scan is not released, not even by the token that bound it.
  await s.scan({ repo: REPO, run_id: "run_scout_1", scan: claim.scan });
  assert.deepEqual(await refusal(s.scan({ repo: REPO, scan: claim.scan })), other, "the same 404, whatever the token");
  assert.equal((await s.list({})).repositories.find((r) => r.repo === REPO)?.scan?.run_id, "run_scout_1");
  // A lapsed claim is not released by its token either.
  const { s: later, tick } = service({ hostStarts: true });
  const { body: old } = await later.scan({ repo: REPO, start: "host" });
  tick(SCAN_CLAIM_MS);
  assert.deepEqual(await refusal(later.scan({ repo: REPO, scan: old.scan })), other);
});

test("a release puts back the repository's last scan, which the reservation stood over", async () => {
  const { s, runs } = service({ hostStarts: true });
  const { body: first } = await s.scan({ repo: REPO, start: "host" });
  await s.scan({ repo: REPO, run_id: "run_scout_1", scan: first.scan });
  // The first scan's run is gone, so it is read (failed) and a new scan may be reserved over it.
  runs.read = async () => undefined;
  const before = (await s.list({})).repositories.find((r) => r.repo === REPO)?.scan;
  assert.equal(before?.run_id, "run_scout_1");
  const { body: claim } = await s.scan({ repo: REPO, start: "host" });
  assert.equal(claim.status, "starting");
  await s.scan({ repo: REPO, scan: claim.scan });
  assert.deepEqual((await s.list({})).repositories.find((r) => r.repo === REPO)?.scan, before);
});

test("a scan body takes start: host, run_id with scan, or scan alone, never start with either", async () => {
  const { s } = service({ hostStarts: true });
  for (const body of [{ repo: REPO, start: "here" }, { repo: REPO, run_id: "run_scout_1" }, { repo: REPO, start: "host", scan: "x" }, { repo: REPO, start: "host", run_id: "run_scout_1", scan: "x" }, { repo: REPO, run_id: "", scan: "x" }]) {
    assert.equal((await refusal(s.scan(body))).code, "input_invalid", JSON.stringify(body));
  }
});
