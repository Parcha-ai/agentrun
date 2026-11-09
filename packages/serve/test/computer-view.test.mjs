// A run's desktop or phone through serve's routes (computer-view.ts): GET /v2/runs/{id}/computer, POST .../take-over and
// POST .../hand-back, owner-only, driven at the route's own handler (computerRoute) as serve's dispatch calls it: no
// server, no socket, no port. Everything is read from the store: the run's journal entries (given here as the runner
// would commit them, computer-commands.ts's contract) and its command rows (a real store in a temp dir). A token is
// refused; a run with no desktop or phone is off; one whose computer is not up is none; the agent's ask is answered by a
// hand-back, the first answer winning; a hand-back with nothing to hand back is 404. The runner's side, and a take-over
// and hand-back end to end, are computer-takeover-store.test.mjs's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { COMPUTER_ROUTES, computerRoute, runViewedKind, takenOverIn } from "../dist/computer-view.js";
import { COMPUTER_HAND_BACK, COMPUTER_HANDOVER_KIND, COMPUTER_HOLD_KIND, COMPUTER_TAKE_OVER, computerAsk } from "../dist/computer-commands.js";
import { ERROR_STATUS } from "../dist/errors.js";
import { openapiDocument } from "../dist/openapi.js";
import { ROUTES } from "../dist/server.js";
import { openSqliteStore } from "../dist/store/index.js";

const OWNER = { ownerSession: true, token: false, accounts: true };
const TOKEN = { ownerSession: false, token: true, accounts: true };
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const routes = { GET: "getRunComputer", "take-over": "takeOverRunComputer", "hand-back": "handBackRunComputer" };

const dirs = [];
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A run in a real store, its revision asking for `computer`, and its journal the test's own list. */
async function world(t, computer = { kind: "desktop", provider: "e2b" }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-view-"));
  dirs.push(dir);
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => store.close().catch(() => {}));
  await store.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: computer ? { computer } : {} });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const entries = [];
  const deps = async () => ({ store, entries: async () => entries, kind: await runViewedKind(store, "run-1"), now: () => NOW });
  /** The route's answer, or its refusal as serve answers it: its status, code and words. */
  const answer = async (name, request = OWNER) => {
    try {
      return { status: 200, body: await computerRoute(name, "run-1", request, await deps()) };
    } catch (error) {
      if (!(error?.code in ERROR_STATUS)) throw error;
      return { status: ERROR_STATUS[error.code], code: error.code, message: error.message };
    }
  };
  const up = () => entries.push({ kind: COMPUTER_HOLD_KIND, data: { up: true, computer: "desktop", at: NOW } });
  return { store, entries, answer, up };
}

const ask = (id, over = {}) => ({ kind: COMPUTER_HANDOVER_KIND, data: { state: "waiting", id, computer: "desktop", instruction: "Sign in to the bank", completion_condition: "the statements show", asked_at: new Date(NOW - 60_000).toISOString(), expires_at: new Date(NOW + 60_000).toISOString(), reason: "Sign in to the bank", ...over } });

test("serve's route table and document carry the three routes", () => {
  const table = Object.fromEntries(ROUTES.filter((route) => COMPUTER_ROUTES.has(route.name)).map((route) => [route.name, route.method]));
  assert.deepEqual(table, { getRunComputer: "GET", takeOverRunComputer: "POST", handBackRunComputer: "POST" });
  const doc = openapiDocument(() => undefined);
  assert.equal(doc.paths["/runs/{run_id}/computer"].get.operationId, "getRunComputer");
  assert.equal(doc.paths["/runs/{run_id}/computer/take-over"].post.operationId, "takeOverRunComputer");
  assert.equal(doc.paths["/runs/{run_id}/computer/hand-back"].post.operationId, "handBackRunComputer");
});

test("a token is refused; a run with no desktop or phone is off; one not up is none, and its take-over 409; a field the route does not take is refused", async (t) => {
  const off = await world(t, null);
  for (const name of Object.values(routes)) {
    const refused = await off.answer(name, TOKEN);
    assert.deepEqual([refused.status, refused.code], [403, "forbidden"], `${name}: a token never reaches a run's computer view`);
    assert.match(refused.message, /owner's password sign-in in the console, never a token/);
  }
  assert.match((await off.answer(routes.GET, { ...TOKEN, accounts: false })).message, /no accounts \(AGENTRUN_ACCOUNTS=0\)/);
  assert.deepEqual(await off.answer(routes.GET), { status: 200, body: { kind: null, state: "off", hold: "agent", taken_over: false, viewer: null, why: "this run has no desktop or phone computer (a browser is watched at /v2/runs/{run_id}/browser)" } });
  assert.equal((await off.answer(routes["take-over"])).status, 404);
  assert.equal((await off.answer(routes["hand-back"])).status, 404);

  const desk = await world(t);
  assert.deepEqual(await desk.answer(routes.GET), { status: 200, body: { kind: "desktop", state: "none", hold: "agent", taken_over: false, viewer: null, why: "this run's desktop is not up now" } }, "none until the runner says it is up");
  const notLive = await desk.answer(routes["take-over"], { ...OWNER, body: {} });
  assert.deepEqual([notLive.status, notLive.code], [409, "computer_not_live"]);
  desk.up();
  const extra = await desk.answer(routes["take-over"], { ...OWNER, body: { why: "x" } });
  assert.deepEqual([extra.status, extra.code], [422, "input_invalid"]);
  const badOutcome = await desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "expired" } });
  assert.deepEqual([badOutcome.status, badOutcome.code], [422, "input_invalid"], "an expiry is the run's own, never a person's");
  const nothing = await desk.answer(routes["hand-back"], { ...OWNER, body: {} });
  assert.deepEqual([nothing.status, nothing.code], [404, "not_found"], "nothing asked, nothing taken");
  assert.deepEqual(await desk.store.commands("run-1", 0), [], "no refused request wrote a row");
});

test("a take-over writes one row and shows pending until the runner applies it; the journal's hold is what shows then; taking again writes nothing", async (t) => {
  const desk = await world(t);
  desk.up();
  assert.deepEqual((await desk.answer(routes.GET)).body, { kind: "desktop", state: "live", hold: "agent", taken_over: false, viewer: null });
  const taken = await desk.answer(routes["take-over"], { ...OWNER, body: {} });
  assert.deepEqual([taken.status, taken.body.hold, taken.body.taken_over], [200, "pending", false]);
  assert.equal((await desk.answer(routes["take-over"], { ...OWNER, body: {} })).body.hold, "pending", "the same answer");
  const rows = await desk.store.commands("run-1", 0);
  assert.deepEqual(rows.map((row) => [row.kind, row.body]), [[COMPUTER_TAKE_OVER, { at: NOW }]], "one row");
  // The runner applied it: the person's hold in the run's journal.
  desk.entries.push({ kind: COMPUTER_HOLD_KIND, data: { state: "person", take: `c${rows[0].id}`, computer: "desktop", at: NOW, by: rows[0].id } });
  assert.deepEqual((await desk.answer(routes.GET)).body, { kind: "desktop", state: "live", hold: "person", taken_over: true, viewer: null });
  assert.equal(takenOverIn(desk.entries, await desk.store.commands("run-1", 0)), true, "the run read's computer field says taken_over");
  const back = await desk.answer(routes["hand-back"], { ...OWNER, body: {} });
  assert.equal(back.status, 200);
  const handBack = (await desk.store.commands("run-1", 0)).find((row) => row.kind === COMPUTER_HAND_BACK);
  assert.deepEqual(handBack.body, { take: `c${rows[0].id}`, at: NOW }, "the hand-back names the take it ends");
});

test("the agent's ask: the run waits on it; the first hand-back answers it, the same answer again is that answer, a different one is 409 in words; an expired ask is 409 in its words", async (t) => {
  const desk = await world(t);
  desk.up();
  desk.entries.push(ask("ask-1"));
  assert.equal(computerAsk(desk.entries, [], NOW).instruction, "Sign in to the bank", "the run read's pending is the open ask");
  const done = await desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "done" } });
  assert.deepEqual([done.status, done.body.outcome], [200, "done"]);
  assert.equal(computerAsk(desk.entries, await desk.store.commands("run-1", 0), NOW), undefined, "answered: the run waits no more");
  // The runner applied it.
  desk.entries.push({ kind: COMPUTER_HANDOVER_KIND, data: { state: "done", id: "ask-1", at: NOW } });
  const again = await desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "cancelled" } });
  assert.deepEqual(again, { status: 409, code: "handoff_answered", message: "The agent's hand-over was already answered done." });

  desk.entries.push(ask("ask-2", { asked_at: new Date(NOW - 20 * 60_000).toISOString(), expires_at: new Date(NOW - 5 * 60_000).toISOString() }));
  desk.entries.push({ kind: COMPUTER_HANDOVER_KIND, data: { state: "expired", id: "ask-2", at: NOW - 5 * 60_000 } });
  const late = await desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "done" } });
  assert.deepEqual(late, { status: 409, code: "handoff_answered", message: "The agent's hand-over expired before this answer: the agent was told it expired." });
});

test("two answers to one ask written together: the lowest row wins, the other with a different outcome is 409", async (t) => {
  const desk = await world(t);
  desk.up();
  desk.entries.push(ask("ask-1"));
  const [a, b] = await Promise.all([desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "done" } }), desk.answer(routes["hand-back"], { ...OWNER, body: { outcome: "cancelled" } })]);
  const rows = (await desk.store.commands("run-1", 0)).filter((row) => row.kind === COMPUTER_HAND_BACK);
  const first = rows[0].body.outcome;
  const [won, lost] = first === "done" ? [a, b] : [b, a];
  assert.equal(won.status, 200);
  assert.deepEqual(lost, { status: 409, code: "handoff_answered", message: `The agent's hand-over was already answered ${first}.` });
});
