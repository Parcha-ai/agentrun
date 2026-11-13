// A --faux server's run on the faux desktop, through the production composition alone: the server's start check
// (server.ts computerReady) and the runner beside it (runner/main.ts runnerComputers, as runnerBeside and the CLI's
// runner compose it) both read --faux's computers beside the package's, so the run starts (no 409), its desktop is
// made at the claim by --faux's launch, and its live view is opened there (computer-live.ts openClaimView) on the faux
// desktop's watch. No test stand-in for the composition, the provider or openComputerView: the test gives only the faux
// model (fixtures/faux-desktop-held.mjs), which holds the agent between its two looks. GET /computer is live with the
// viewer's link while the run works; Take over (POST .../computer/take-over) answers 200 and the person holds the
// desktop; the agent's next look waits for the hand-back; POST .../computer/hand-back answers 200, and the run ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, call, clientOwnerSession, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-desktop-held.mjs", import.meta.url).pathname;
const HELD = Symbol.for("agentrun.test.held");
const LOOKED = Symbol.for("agentrun.test.looked");

/** Until `check()` holds, bounded; each try after the next turn of the timers. */
async function until(check, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("under --faux, a run on the faux desktop starts, its live view is published by the real runner composition, and Take over holds the run until the hand-back", { timeout: 120_000 }, async (t) => {
  let letGo;
  globalThis[HELD] = new Promise((resolve) => (letGo = resolve));
  let looked;
  const lookedAgain = new Promise((resolve) => (looked = resolve));
  globalThis[LOOKED] = looked;
  t.after(() => {
    letGo();
    delete globalThis[HELD];
    delete globalThis[LOOKED];
  });
  const server = await serve(t, { accounts: true, openSetup: true, faux: FAUX });
  const owner = await clientOwnerSession(server);
  const asOwner = (method, path, body) => call(server.port, { method, path, headers: { cookie: owner.cookie, origin: owner.origin, ...(body ? { "content-type": "application/json" } : {}) }, body });

  const made = await server.api("POST", "/agents", agent("desk", { computer: { kind: "desktop", provider: "faux-desktop" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await server.api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
  assert.equal(started.status, 202, `the faux desktop is a computer this server knows: ${JSON.stringify(started.body)}`);
  const runId = started.body.run_id;
  const path = `/v2/runs/${runId}/computer`;

  // The runner made the desktop at the claim and opened its view there: GET /computer is live, with the viewer's link.
  await until(async () => (await asOwner("GET", path)).json?.state === "live", "the run's desktop went live");
  const live = (await asOwner("GET", path)).json;
  assert.deepEqual({ ...live, viewer: "" }, { state: "live", kind: "desktop", viewer: "", hold: "agent" });
  assert.match(live.viewer, /^\/v2\/runs\/[^/]+\/computer\/live\/v\/[A-Za-z0-9_-]{22}#t=[A-Za-z0-9_-]{43}$/);
  const [row] = await server.store.liveViewers.of(runId);
  assert.deepEqual([row?.kind, row?.tag], ["desktop", "faux-desktop-1"], "the viewer's row is the faux desktop's, put by the runner");

  // Take over, once the run's journal says its desktop is up (its first look committed): 200, and the person holds it.
  await until(async () => (await server.api("GET", `/runs/${runId}`)).body.computer?.state === "ready", "the run's journal says its desktop is up");
  const taken = await asOwner("POST", `${path}/take-over`, {});
  assert.equal(taken.status, 200, taken.text);
  await until(async () => (await asOwner("GET", path)).json?.hold === "person", "the person holds the desktop");

  // The agent goes on: its next look is asked for, and waits for the hand-back; the run keeps working meanwhile.
  letGo();
  await lookedAgain;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal((await server.api("GET", `/runs/${runId}`)).body.status, "working", "the run waits for the hand-back");
  assert.equal((await asOwner("GET", path)).json?.state, "live", "its view stays live while the person holds the desktop");

  const given = await asOwner("POST", `${path}/hand-back`, {});
  assert.equal(given.status, 200, given.text);
  await follow(server.api, runId, ["completed"]);
  assert.notEqual((await asOwner("GET", path)).json.state, "live", "no viewer once the run ended");
  const said = JSON.stringify((await server.api("GET", `/runs/${runId}/timeline`)).body);
  assert.match(said, /You took over the desktop/);
  assert.match(said, /You handed the desktop back/);
});
