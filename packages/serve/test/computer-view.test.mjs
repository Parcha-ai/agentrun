// GET /v2/runs/{run_id}/computer's answer (computer-view.ts), one family for every kind: `live` with the run's computer
// kind, the viewer's link and who holds it, while a viewer is open (a running viewer is served even when its computer
// would resolve off now: the run holds the keys it started with); else `off` with why when there is no computer here (no
// kind); else `none` with its kind and where its session is (sessionIn: unopened, opening, closed). Never a token but the
// viewer link's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerView, lapsedOf, sessionIn } from "../dist/computer-view.js";

const LINK = "/v2/runs/run-1/computer/live/v/AbCdEfGhIjKlMnOpQrStUv#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const opening = () => "opening";

test("live, none and off, each with who holds the computer", async () => {
  const browser = { kind: "browser" };
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "browser", viewer: LINK }), computer: () => browser, session: opening, hold: () => "agent" }), { state: "live", kind: "browser", viewer: LINK, hold: "agent" });
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "desktop", viewer: LINK }), computer: () => ({ kind: "desktop" }), session: opening, hold: () => "person" }), { state: "live", kind: "desktop", viewer: LINK, hold: "person" });
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "phone" }), session: opening, hold: () => "pending" }), { state: "none", kind: "phone", hold: "pending", session: "opening" });
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ off: "this run's agent has no computer" }), session: opening, hold: () => "person" }), { state: "off", hold: "agent", why: "this run's agent has no computer" }, "off: nobody's to hold, no kind");
});

test("a viewer open is live whatever the computer resolves to now, and the computer is read only when none is open", async () => {
  let read = 0;
  const computer = () => (read++, { off: "no key" });
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "browser", viewer: LINK }), computer, session: opening, hold: () => "agent" }), { state: "live", kind: "browser", viewer: LINK, hold: "agent" });
  assert.equal(read, 0);
});

test("with no hold seam the agent drives (the store-backed computer hold is not wired yet)", async () => {
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "browser" }), session: () => "unopened" }), { state: "none", kind: "browser", hold: "agent", session: "unopened" });
});

test("none's session is read for the computer's own kind", async () => {
  const asked = [];
  await computerView({ viewer: async () => undefined, computer: () => ({ kind: "desktop" }), session: (kind) => (asked.push(kind), "opening") });
  assert.deepEqual(asked, ["desktop"]);
});

test("a parked run's desktop or phone kept at its park says nothing while kept; past its time ended in the timeout's words; its end begun before its time, not kept, with no reason and no time to come; a sandbox's row or none says nothing", () => {
  const until = Date.parse("2026-11-15T12:10:00.000Z");
  const row = { provider: "e2b", kind: "desktop", id: "c1", name: "c1", epoch: 3, until };
  assert.equal(lapsedOf("desktop", row, until - 1), undefined, "kept: the run's timeline says until when");
  const lapsed = { at: "2026-11-15T12:10:00.000Z", why: "The desktop wasn't kept: 10 minutes passed. A new one starts when the run goes on." };
  assert.deepEqual(lapsedOf("desktop", row, until), lapsed);
  // Ending or ended before its time: a claim that could not reach it gave its row back so, or a park that kept nothing
  // marked it so (another runner's, still there). Its 10 minutes did not pass, and nothing happens at its `until`: not
  // kept, said with no reason, at the time it is read.
  const early = until - 4 * 60_000;
  const unkept = { at: new Date(early).toISOString(), why: "The desktop wasn't kept. A new one starts when the run goes on." };
  assert.deepEqual(lapsedOf("desktop", { ...row, ending: true }, early), unkept, "ending before its time: no '10 minutes passed', no time to come");
  assert.deepEqual(lapsedOf("desktop", { ...row, ended: true }, early), unkept, "ended before its time: the same");
  assert.ok(Date.parse(lapsedOf("desktop", { ...row, ending: true }, early).at) <= early, "never a time still to come");
  // Once its time has passed, ending or ended reads as lapsed, at its time.
  assert.deepEqual(lapsedOf("desktop", { ...row, ending: true }, until), lapsed, "ending past its time: the timeout's words");
  assert.deepEqual(lapsedOf("desktop", { ...row, ended: true }, until + 60_000), lapsed, "ended past its time: the same");
  assert.equal(lapsedOf("desktop", undefined, until), undefined);
  assert.equal(lapsedOf("desktop", { ...row, kind: "sandbox" }, until), undefined, "a sandbox's row: no screen to say it of");
});

test("computerView reads a parked desktop's lapse as ended; a browser's is its own", async () => {
  const ended = { at: "2026-11-15T12:10:00.000Z", why: "The desktop wasn't kept: 10 minutes passed. A new one starts when the run goes on." };
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "desktop" }), session: () => "closed", lapsed: async () => ended }), { state: "none", kind: "desktop", hold: "agent", session: "closed", ended });
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "desktop" }), session: opening, lapsed: async () => undefined }), { state: "none", kind: "desktop", hold: "agent", session: "opening" });
  let asked = 0;
  await computerView({ viewer: async () => undefined, computer: () => ({ kind: "browser" }), session: opening, lapsed: async () => (asked++, ended) });
  assert.equal(asked, 0, "a browser's is its own (ended)");
});

// The journal as runEntries reads it: pi's assistant entries (their message in model[0]) and tool results.
const call = (id, name, stopReason = "toolUse") => ({ kind: "pi.assistant", data: {}, model: [{ role: "assistant", stopReason, content: [{ type: "text", text: "Looking." }, { type: "toolCall", id, name, arguments: {} }] }] });
const result = (id) => ({ kind: "pi.tool-result", data: {}, model: [{ role: "toolResult", toolCallId: id, content: [] }] });
const said = { kind: "pi.assistant", data: {}, model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }] };

test("a browser no step ever opened is unopened: a run that only fetched pages, waiting for its person", () => {
  assert.equal(sessionIn("browser", []), "unopened");
  assert.equal(sessionIn("browser", [call("c1", "web_fetch"), result("c1"), call("c2", "ask_person")]), "unopened", "web_fetch and an open ask are no browser step");
  assert.equal(sessionIn("browser", [call("c1", "browser_release"), result("c1"), said]), "unopened", "a release opens nothing");
  assert.equal(sessionIn("browser", [call("c1", "browser_request_handoff")]), "unopened", "nor a hand-over asked with no session open (refused: nothing to hold)");
  assert.equal(sessionIn("browser", [call("c1", "browser_request_handoff"), result("c1")]), "unopened");
});

test("a browser step with no result yet is the browser opening; one answered, with no viewer now, is closed", () => {
  assert.equal(sessionIn("browser", [call("c1", "snapshot")]), "opening");
  assert.equal(sessionIn("browser", [call("c1", "snapshot"), result("c1")]), "closed");
  assert.equal(sessionIn("browser", [call("c1", "run"), result("c1"), call("c2", "browser_release"), result("c2"), call("c3", "screenshot")]), "opening", "opened again after a release");
  assert.equal(sessionIn("browser", [call("c1", "snapshot", "aborted")]), "unopened", "an aborted message's call never ran");
  assert.equal(sessionIn("browser", [call("c1", "snapshot", "error")]), "unopened", "nor an errored one's");
});

test("every browser step but its release and its hand-over opens a session: an upload or a relaunch first counts too", () => {
  for (const name of ["browser_upload", "browser_relaunch", "browser_downloads", "browser_read"]) {
    assert.equal(sessionIn("browser", [call("c1", name)]), "opening", name);
    assert.equal(sessionIn("browser", [call("c1", name), result("c1")]), "closed", name);
  }
});

test("a CLI harness's browser calls (its record's call start and end) read the same as a pi run's", () => {
  const start = (callId, tool) => ({ kind: "agentrun.call.start", data: { callId, tool, input: {}, at: 1 } });
  const end = (callId) => ({ kind: "agentrun.call.end", data: { callId, status: "done", output: "ok", at: 2 } });
  assert.equal(sessionIn("browser", [start("k1", "web_fetch"), end("k1")]), "unopened");
  assert.equal(sessionIn("browser", [start("k1", "snapshot")]), "opening");
  assert.equal(sessionIn("browser", [start("k1", "snapshot"), end("k1")]), "closed");
});

test("a desktop or a phone opens with the run's claim: opening until its viewer answers", () => {
  const up = { kind: "computer.hold", data: { up: true, computer: "desktop", at: 1 } };
  for (const kind of ["desktop", "phone"]) {
    assert.equal(sessionIn(kind, []), "opening", `a ${kind} not claimed yet`);
    assert.equal(sessionIn(kind, [up]), "opening", `a ${kind} up with no viewer answering yet`);
    assert.equal(sessionIn(kind, [call("c1", "snapshot"), result("c1")]), "opening", "browser steps are no desktop's");
  }
});

test("an ended run's computer is never opening: its desktop or phone closed with the run, as did a browser step left unanswered", () => {
  for (const kind of ["desktop", "phone"]) assert.equal(sessionIn(kind, [], true), "closed", kind);
  assert.equal(sessionIn("browser", [call("c1", "snapshot")], true), "closed", "a browser step the run ended under");
  assert.equal(sessionIn("browser", [call("c1", "web_fetch"), result("c1")], true), "unopened", "a browser no step opened stays unopened");
});
