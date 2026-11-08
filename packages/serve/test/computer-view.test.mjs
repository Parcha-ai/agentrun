// A run's desktop or phone through serve's routes (computer-view.ts): GET /v2/runs/{id}/computer, POST .../take-over and
// POST .../hand-back, owner-only, driven at the route's own handler (computerRoute) as serve's dispatch calls it: no
// server, no socket, no port. The run's computer is a fake one registered as the process holding the run's claim
// registers it, with a fake stream: no provider is called. The owner's take-over gives a viewer that drives and parks the
// run's screen and input calls; the hand-back gives it back. A token is refused; a run with no desktop or phone is off;
// the browser keeps its own routes. Driven by events: nothing sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_ROUTES, computerRoute, computerStateOf, registerRunComputer } from "../dist/computer-view.js";
import { ERROR_STATUS } from "../dist/errors.js";
import { openapiDocument } from "../dist/openapi.js";
import { ROUTES } from "../dist/server.js";
import { computerHold, heldHands, personHadWords, TAKEN_OVER } from "../dist/workspace/computer-hold.js";

/** The owner's signed-in page, and a token, as serve's dispatch tells the route. */
const OWNER = { ownerSession: true, token: false, accounts: true };
const TOKEN = { ownerSession: false, token: true, accounts: true };
const routes = { GET: "getRunComputer", "take-over": "takeOverRunComputer", "hand-back": "handBackRunComputer" };
/** The route's answer, or its refusal as serve answers it: its status and its code. */
async function answer(name, runId, request = OWNER) {
  try {
    return { status: 200, body: await computerRoute(name, runId, request) };
  } catch (error) {
    if (!(error?.code in ERROR_STATUS)) throw error;
    return { status: ERROR_STATUS[error.code], code: error.code, message: error.message };
  }
}

/** A fake desktop: its stream says whether it drives; its ports record each call. */
function fakeDesktop() {
  const streams = [];
  const calls = [];
  let up = true;
  const hold = computerHold();
  const computer = {
    kind: "desktop", hold, live: () => up,
    stream: async ({ viewOnly }) => (streams.push(viewOnly), { url: `https://stream.example/desktop?${viewOnly ? "view" : "drive"}` }),
  };
  const hands = heldHands({ screen: { shot: async () => (calls.push("shot"), { png: new Uint8Array([1]), width: 1, height: 1 }) }, input: { actions: async () => void calls.push("actions") } }, hold);
  return { computer, hands, streams, calls, end: () => { up = false; } };
}

test("serve's route table and document carry the three routes", () => {
  const table = Object.fromEntries(ROUTES.filter((route) => COMPUTER_ROUTES.has(route.name)).map((route) => [route.name, route.method]));
  assert.deepEqual(table, { getRunComputer: "GET", takeOverRunComputer: "POST", handBackRunComputer: "POST" });
  const doc = openapiDocument(() => undefined);
  assert.equal(doc.paths["/runs/{run_id}/computer"].get.operationId, "getRunComputer");
  assert.equal(doc.paths["/runs/{run_id}/computer/take-over"].post.operationId, "takeOverRunComputer");
  assert.equal(doc.paths["/runs/{run_id}/computer/hand-back"].post.operationId, "handBackRunComputer");
});

test("the owner watches a run's desktop, takes it over (the agent's input parks), and hands it back (the parked act is not done, in words); the run read says taken_over meanwhile", async (t) => {
  const runId = "run-desktop";
  const desktop = fakeDesktop();
  t.after(registerRunComputer(runId, desktop.computer));

  assert.deepEqual(await answer(routes.GET, runId), { status: 200, body: { kind: "desktop", state: "live", taken_over: false, viewer: { url: "https://stream.example/desktop?view" } } }, "view-only while the agent works");

  const taken = await answer(routes["take-over"], runId, { ...OWNER, body: {} });
  assert.equal(taken.status, 200);
  assert.deepEqual([taken.body.state, taken.body.taken_over, taken.body.viewer], ["live", true, { url: "https://stream.example/desktop?drive" }], "a viewer that drives");
  assert.match(taken.body.taken_until, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await answer(routes["take-over"], runId)).body.taken_over, true, "taking it again is the same answer");
  assert.equal(computerStateOf(runId, "ready"), "taken_over", "the run read's computer state while the owner holds it");

  // The agent's act made while the owner holds it waits, and reaches nothing; so does its look.
  const acting = desktop.hands.input.actions([{ type: "click" }]).then(() => "done", (error) => error);
  const looking = desktop.hands.screen.shot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(desktop.calls, [], "parked: nothing reached the desktop");

  const back = await answer(routes["hand-back"], runId, { ...OWNER, body: {} });
  assert.deepEqual([back.status, back.body.taken_over, back.body.viewer], [200, false, { url: "https://stream.example/desktop?view" }]);
  const parked = await acting;
  assert.deepEqual([parked.code, parked.message], [TAKEN_OVER, personHadWords("desktop", "input")], "the parked act was not done, in words");
  await looking;
  assert.deepEqual(desktop.calls, ["shot"], "the look ran after the hand-back; the act never did");
  assert.equal(computerStateOf(runId, "ready"), "ready", "and back with the agent");
  assert.equal((await answer(routes["hand-back"], runId)).status, 200, "handing back one nobody holds is the same answer");
  assert.deepEqual(desktop.streams, [true, false, false, true, true], "view-only, then driving while held, then view-only again");
});

test("a token is refused; a run with no desktop or phone is off (the browser keeps its routes); one not up is none, and its take-over 409; a body field is refused", async () => {
  const runId = "run-not-up";
  for (const name of Object.values(routes)) {
    const refused = await answer(name, runId, TOKEN);
    assert.deepEqual([refused.status, refused.code], [403, "forbidden"], `${name}: a token never reaches a run's computer view`);
    assert.match(refused.message, /owner's password sign-in in the console, never a token/);
  }
  assert.match((await answer(routes.GET, runId, { ...TOKEN, accounts: false })).message, /no accounts \(AGENTRUN_ACCOUNTS=0\)/);

  assert.deepEqual(await answer(routes.GET, runId), { status: 200, body: { kind: null, state: "off", taken_over: false, viewer: null } });
  assert.equal((await answer(routes["take-over"], runId)).status, 404);
  assert.equal((await answer(routes["hand-back"], runId)).status, 404);

  const desktop = fakeDesktop();
  const letGo = registerRunComputer(runId, desktop.computer);
  desktop.end();
  assert.deepEqual(await answer(routes.GET, runId), { status: 200, body: { kind: "desktop", state: "none", taken_over: false, viewer: null } });
  const notLive = await answer(routes["take-over"], runId);
  assert.deepEqual([notLive.status, notLive.code], [409, "computer_not_live"]);
  const extra = await answer(routes["take-over"], runId, { ...OWNER, body: { why: "x" } });
  assert.deepEqual([extra.status, extra.code], [422, "input_invalid"], "a field the route does not take is refused");
  letGo();
  assert.equal((await answer(routes.GET, runId)).body.state, "off", "let go at the run's end");
});
