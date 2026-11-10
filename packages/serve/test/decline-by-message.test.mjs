// A person's message while a call waits for approval declines it, and every reader keeps that it was their message: the
// message route's deny row says so (`by: "message"`), the runner's answer carries it, and the call's approval row reads
// main's "Declined by your message" (runs.ts declineBy); a deny the owner gives directly reads as their decline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queue, stores } from "./runner-support.mjs";

const { message } = await import("../dist/runs-over-store.js");
const { answersOf, withApprovalRows } = await import("../dist/run-view.js");

test("the message route's decline of a waiting call is a deny row marked as the person's message, with their words", async () => {
  const { server } = await stores({ runners: 0 });
  await queue(server, "run-1");
  const moment = { id: "run-1", agentId: "agent-1", kind: "agentic", cancelled: false, terminal: false, working: false, waitsOnPerson: true, waitingApprovalId: "c1" };
  const said = await message(server, moment, "use the cached sum instead");
  assert.equal(said.mode, "answer");
  const [row] = await server.commands("run-1", 0);
  assert.deepEqual([row.kind, row.body], ["deny", { approval: "c1", note: "use the cached sum instead", by: "message" }]);
});

test("a call its answer says a message declined reads Declined by your message; a direct deny reads as asked", () => {
  const ask = { kind: "agentrun.ask", data: { callId: "c1", tool: "add", args: {}, requestedAt: "2026-11-09T00:00:00.000Z" } };
  const asks = new Map([["c1", { id: "c1", tool: "add", call_id: "c1", args_json: "{}", requested_at: "2026-11-09T00:00:00.000Z" }]]);
  const head = (answer) => withApprovalRows([{ id: "r0", seq: 0, kind: "tool_use", tool_use_id: "c1", tool_name: "add", summary: "add", text: "" }], asks, answersOf([ask, { kind: "agentrun.answer", data: answer }]), (text) => text).find((one) => one.kind === "tool_approval_requested").summary.split(":")[0];
  assert.equal(head({ callId: "c1", approved: false, decision: "deny", note: "use the cached sum instead", by: "message" }), "Declined by your message");
  assert.equal(head({ callId: "c1", approved: false, decision: "deny", note: "not today" }), "Asked your approval");
});
