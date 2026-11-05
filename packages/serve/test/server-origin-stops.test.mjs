// A message the server writes counts, in serve's own reading of a run, as the message its turn took, as a person's does:
// a stop right after it is a stop at it, and one after a declined approval names the declined message's own place. The
// Timeline shows it as the server's row (`origin: "server"`); the run's stop and arrival reads count that row as a message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { stopMark, stoppedAt } from "../dist/runs.js";

const RAISED = "The cap was raised to $5; continue the task.";
const user = (id, text, origin) => ({ kind: "pi.user", id, conversationId: 0, model: [{ role: "user", content: text, timestamp: 0 }], ...(origin ? { data: { origin } } : {}) });
const said = (id, text) => ({ kind: "pi.assistant", id, conversationId: 0, model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }] });

test("a stop right after a message the server wrote is a stop at that message: the run stays stopped there until the person's next message", () => {
  const entries = [user(1, "Write the report."), said(2, "Stopped at the cap."), user(3, RAISED, { kind: "server", reason: "cap_raised" })];
  const mark = stopMark(timelineOf(entries));
  assert.equal(mark.stopped_at, "0:3", "the stop is at the server's message, the one its turn took");
  assert.equal(stoppedAt(mark, timelineOf(entries)), true, "stopped there");
  assert.equal(stoppedAt(mark, timelineOf([...entries, user(4, "Go on.")])), false, "the person's next message is past the stop");
});

test("a stop after an approval a person's message declined names that message's own place, a number", () => {
  const declined = { kind: "server", reason: "approval_declined", said: "No, not that one." };
  const mark = stopMark(timelineOf([user(1, "Fetch the page."), user(3, "[tool approval] This answers your fetch_page call call_1.", declined)]));
  assert.equal(mark.stopped_at, "0:3", "the declined message's place, never a row id that reads as no number");
});
