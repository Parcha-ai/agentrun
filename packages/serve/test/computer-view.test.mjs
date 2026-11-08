// A run's desktop or phone through serve's API (computer-view.ts): GET /v2/runs/{id}/computer, POST .../take-over and
// POST .../hand-back, owner-only. The run's computer here is a fake one registered as the process holding the run's
// claim registers it, with a fake stream: no provider is called. The owner's take-over gives a viewer that drives and
// parks the run's screen and input calls; the hand-back gives it back. A token is refused; a run with no desktop or phone
// is off; the browser keeps its own routes. Driven by the API and events: nothing sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, cookieOf, follow, serve } from "./support.mjs";
import { computerStateOf, registerRunComputer } from "../dist/computer-view.js";
import { computerHold, heldHands, personHadWords, TAKEN_OVER } from "../dist/workspace/computer-hold.js";

const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");

/** A signed-in owner's server and a finished faux run, whose computer the test then registers. */
async function owned(t) {
  const server = await serve(t, { accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "screen", name: "screen", instructions: "Look." } })).status, 201);
  const started = await server.api("POST", "/agents/screen/runs", { input: { content: "Look at the screen." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(server.api, runId, ["completed"]);
  const owner = (method, path, headers = { cookie }) => call(server.port, { method, path: `/v2/runs/${runId}/computer${path}`, headers: { ...json, origin, ...headers }, ...(method === "POST" ? { body: {} } : {}) });
  return { server, runId, owner, cookie, origin };
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
  const hands = heldHands({ maxExecS: 600, screen: { shot: async () => (calls.push("shot"), { png: new Uint8Array([1]), width: 1, height: 1 }) }, input: { actions: async () => void calls.push("actions") } }, hold);
  return { computer, hands, streams, calls, end: () => { up = false; } };
}

test("the owner watches a run's desktop, takes it over (the agent's input parks), and hands it back (the parked act is not done, in words); the run read says taken_over meanwhile", async (t) => {
  const { runId, owner } = await owned(t);
  const desktop = fakeDesktop();
  const letGo = registerRunComputer(runId, desktop.computer);
  t.after(letGo);

  const watched = await owner("GET", "");
  assert.deepEqual([watched.status, watched.json], [200, { kind: "desktop", state: "live", taken_over: false, viewer: { url: "https://stream.example/desktop?view" } }], "view-only while the agent works");

  const taken = await owner("POST", "/take-over");
  assert.equal(taken.status, 200, taken.text);
  assert.deepEqual([taken.json.state, taken.json.taken_over, taken.json.viewer], ["live", true, { url: "https://stream.example/desktop?drive" }], "a viewer that drives");
  assert.match(taken.json.taken_until, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await owner("POST", "/take-over")).json.taken_over, true, "taking it again is the same answer");

  // The agent's act made while the owner holds it waits, and reaches nothing.
  const acting = desktop.hands.input.actions([{ type: "click" }]).then(() => "done", (error) => error);
  const looking = desktop.hands.screen.shot();
  assert.equal(computerStateOf(runId, "ready"), "taken_over", "the run read's computer state while the owner holds it");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(desktop.calls, [], "parked: nothing reached the desktop");

  const back = await owner("POST", "/hand-back");
  assert.deepEqual([back.status, back.json.taken_over, back.json.viewer], [200, false, { url: "https://stream.example/desktop?view" }]);
  const parked = await acting;
  assert.deepEqual([parked.code, parked.message], [TAKEN_OVER, personHadWords("desktop", "input")], "the parked act was not done, in words");
  assert.equal(computerStateOf(runId, "ready"), "ready", "and back with the agent");
  await looking;
  assert.deepEqual(desktop.calls, ["shot"], "the look ran after the hand-back; the act never did");
  assert.equal((await owner("POST", "/hand-back")).status, 200, "handing back one nobody holds is the same answer");
  assert.deepEqual(desktop.streams, [true, false, false, true, true], "view-only, then driving while held, then view-only again");
});

test("a token is refused; a run with no desktop or phone is off (the browser keeps its routes); one not up is none, and its take-over 409", async (t) => {
  const { server, runId, owner, cookie, origin } = await owned(t);
  const byToken = await server.api("GET", `/runs/${runId}/computer`);
  assert.equal(byToken.status, 403, "a token never reaches a run's computer view");
  assert.equal((await server.api("POST", `/runs/${runId}/computer/take-over`)).status, 403);

  assert.deepEqual((await owner("GET", "")).json, { kind: null, state: "off", taken_over: false, viewer: null });
  assert.equal((await owner("POST", "/take-over")).status, 404);
  assert.equal((await owner("POST", "/hand-back")).status, 404);

  const desktop = fakeDesktop();
  const letGo = registerRunComputer(runId, desktop.computer);
  desktop.end();
  assert.deepEqual((await owner("GET", "")).json, { kind: "desktop", state: "none", taken_over: false, viewer: null });
  const refused = await owner("POST", "/take-over");
  assert.deepEqual([refused.status, refused.json.error.code], [409, "computer_not_live"]);
  letGo();
  assert.equal((await owner("GET", "")).json.state, "off", "let go at the run's end");
  const extra = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/computer/take-over`, headers: { ...json, origin, cookie }, body: { why: "x" } });
  assert.deepEqual([extra.status, extra.json.error.code], [422, "input_invalid"], "an unknown field is refused");
});
