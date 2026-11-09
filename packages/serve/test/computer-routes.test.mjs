// A run's desktop or phone take-over and hand-back through serve's routes (computer-routes.ts): POST
// /v2/runs/{id}/computer/take-over and POST .../hand-back, driven at the route's own handler (computerRoute) as serve's
// dispatch calls it: no server, no socket, no port. Until the store-backed take-over lands, both answer 501
// unsupported_here in words, after the owner check (a token is refused) and the body check. Watching the computer
// (GET /v2/runs/{id}/computer) is the computer view's route, not one of these.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_ROUTES, computerRoute, TAKE_OVER_NOT_YET } from "../dist/computer-routes.js";
import { ERROR_STATUS } from "../dist/errors.js";
import { openapiDocument } from "../dist/openapi.js";
import { ROUTES } from "../dist/server.js";

/** The owner's signed-in page, and a token, as serve's dispatch tells the route. */
const OWNER = { ownerSession: true, token: false, accounts: true };
const TOKEN = { ownerSession: false, token: true, accounts: true };
const NAMES = ["takeOverRunComputer", "handBackRunComputer"];
/** The route's refusal as serve answers it: its status, its code and its words. */
async function answer(name, request = OWNER) {
  try {
    await computerRoute(name, request);
    return { status: 200 };
  } catch (error) {
    if (!(error?.code in ERROR_STATUS)) throw error;
    return { status: ERROR_STATUS[error.code], code: error.code, message: error.message };
  }
}

test("serve's route table and document carry the two POSTs as these routes", () => {
  const table = Object.fromEntries(ROUTES.filter((route) => COMPUTER_ROUTES.has(route.name)).map((route) => [route.name, route.method]));
  assert.deepEqual(table, { takeOverRunComputer: "POST", handBackRunComputer: "POST" });
  const doc = openapiDocument(() => undefined);
  assert.equal(doc.paths["/runs/{run_id}/computer/take-over"].post.operationId, "takeOverRunComputer");
  assert.equal(doc.paths["/runs/{run_id}/computer/hand-back"].post.operationId, "handBackRunComputer");
  for (const path of ["/runs/{run_id}/computer/take-over", "/runs/{run_id}/computer/hand-back"]) {
    assert.ok("501" in doc.paths[path].post.responses, `${path} documents its 501`);
  }
});

test("the owner's take-over and hand-back answer 501 unsupported_here, in words naming the store-backed take-over", async () => {
  for (const name of NAMES) {
    const refused = await answer(name, { ...OWNER, body: {} });
    assert.deepEqual([refused.status, refused.code, refused.message], [501, "unsupported_here", TAKE_OVER_NOT_YET], name);
    assert.match(refused.message, /store-backed take-over/);
  }
});

test("a token is refused before anything else, in words; a body field is refused; an unknown route name is not found", async () => {
  for (const name of NAMES) {
    const refused = await answer(name, TOKEN);
    assert.deepEqual([refused.status, refused.code], [403, "forbidden"], `${name}: a token never reaches a run's computer`);
    assert.match(refused.message, /owner's password sign-in in the console, never a token/);
    assert.match((await answer(name, { ...TOKEN, accounts: false })).message, /no accounts \(AGENTRUN_ACCOUNTS=0\)/);
    const extra = await answer(name, { ...OWNER, body: { why: "x" } });
    assert.deepEqual([extra.status, extra.code], [422, "input_invalid"], `${name}: a field the route does not take is refused`);
  }
  assert.equal((await answer("listRuns")).status, 404, "a route not in COMPUTER_ROUTES is none of these");
});
