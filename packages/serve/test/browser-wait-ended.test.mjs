// The Screen tab's ended state (browser-wait-ended.ts, computer-view.ts): a going run's browser let go while it waited
// for its person says so, with when, until a new session opens; any other `none` says nothing more.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWaitEnded } from "../dist/browser-wait-ended.js";
import { computerView } from "../dist/computer-view.js";

const phase = (summary, timestamp) => ({ kind: "phase", summary, timestamp });

test("the newest wait-end row, with no session opened after it, is the browser's ended state", () => {
  const rows = [
    phase("A live browser session started", "2026-11-11T14:10:00.000Z"),
    { kind: "tool_use", summary: "Asked you a question", timestamp: "2026-11-11T14:11:00.000Z" },
    phase("The browser was released after 15 min waiting for you", "2026-11-11T14:26:00.000Z"),
  ];
  assert.deepEqual(browserWaitEnded(rows), { at: "2026-11-11T14:26:00.000Z", why: "The browser was released after 15 min waiting for you" });
  assert.deepEqual(browserWaitEnded([...rows.slice(0, 2), phase("The browser session ended while the run waited for you", "2026-11-11T14:12:00.000Z")]).why, "The browser session ended while the run waited for you");
  assert.equal(browserWaitEnded([...rows, phase("A live browser session started", "2026-11-11T14:40:00.000Z")]), undefined, "the answer re-opened a browser: nothing ended now");
  assert.equal(browserWaitEnded([phase("You took over the browser", "2026-11-11T14:12:00.000Z")]), undefined);
  assert.equal(browserWaitEnded([]), undefined);
});

test("GET /computer's none carries `ended` for a browser only, and only when there is one", async () => {
  const none = (kind, ended) => computerView({ viewer: async () => undefined, computer: () => ({ kind }), ended: async () => ended });
  const ended = { at: "2026-11-11T14:26:00.000Z", why: "The browser was released after 15 min waiting for you" };
  assert.deepEqual(await none("browser", ended), { state: "none", kind: "browser", hold: "agent", ended });
  assert.deepEqual(await none("browser", undefined), { state: "none", kind: "browser", hold: "agent" });
  assert.deepEqual(await none("desktop", ended), { state: "none", kind: "desktop", hold: "agent" }, "a desktop's none says nothing of a browser's wait");
  const live = await computerView({ viewer: async () => ({ kind: "browser", viewer: "/v2/runs/r/computer/live/v/1#t=x" }), computer: () => ({ kind: "browser" }), ended: async () => { throw new Error("not read while a viewer is open"); } });
  assert.equal(live.state, "live");
});
