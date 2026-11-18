// Two pieces of pi's adapter bookkeeping, each pinned on its own:
// - a refused call's words (pi.ts refusalWords) are held from the refusal to the call's result, and let go on every
//   result kind, never only on pi's blocked one, so a session holds none it will never use;
// - an answer's booking (adapter-loop bookingOfAnswer) is the session's own bookings no answer was given yet: two
//   generations of one turn each read their own; a side request's booking (its request marked side or under a host
//   label) is given and never read; own bookings since the answer before are summed, unknown when one is. With
//   several conversations asking at once, an answer's own are its conversation's: another's are left for its answer.
import assert from "node:assert/strict";
import { test } from "node:test";

const { refusalWords } = await import("../dist/runner/adapters/pi.js");
const { bookingOfAnswer, turnsOf } = await import("../dist/runner/adapter-loop.js");

test("a refused call's words are let go whatever its result: blocked, an error, a success or an abort", () => {
  for (const [kind, result] of [
    ["blocked", { diagnostics: [{ code: "blocked" }] }],
    ["an error", { isError: true, diagnostics: [{ code: "tool_error" }] }],
    ["a success", { output: [{ type: "text", text: "ok" }] }],
    ["an abort", { diagnostics: [{ code: "aborted" }] }],
  ]) {
    const words = refusalWords();
    words.refuse("call-1", "Permission denied: read is set to deny on this server.");
    const replaced = words.resultOf("call-1", result);
    assert.equal(words.held, 0, `${kind}: no words held after the call's result`);
    // Marked refused in its details (CALL_REFUSED), which the model never reads: its Timeline rows say it was refused.
    if (kind === "blocked") assert.deepEqual(replaced, { output: [{ type: "text", text: "Permission denied: read is set to deny on this server." }], isError: true, details: { "agentrun.refused": true } });
    else assert.equal(replaced, undefined, `${kind}: pi's own result stands`);
  }
});

const turn = (n, usd) => ({ kind: "runner.turn", data: { turn: n, usd } });
const request = (n, marks = {}) => ({ kind: "runner.request", data: { turn: n, ...marks } });

test("two generations of one turn each read their own booking; a side request's booking is given and never read; own bookings since are summed, unknown when one is", () => {
  const given = new Set();
  const give = (booking) => booking.turns.forEach((n) => given.add(n));
  // The first generation's request booked: it reads its own.
  const first = bookingOfAnswer([request(1), turn(1, 0.25)], given);
  assert.deepEqual(first, { turns: [1], usd: 0.25 });
  give(first);
  // The second generation's, after it: it reads its own, never the first's again.
  const second = bookingOfAnswer([request(1), turn(1, 0.25), request(2), turn(2, 0.5)], given);
  assert.deepEqual(second, { turns: [2], usd: 0.5 });
  give(second);
  // A side request (marked side) and a host's own (under a label) booked before the next answer's: given, never read.
  const sides = [request(3, { side: true }), turn(3, 0.125), request(4, { host: "learned_workflow" }), turn(4, 0.0625), request(5), turn(5, 1)];
  const third = bookingOfAnswer(sides, given);
  assert.deepEqual(third, { turns: [3, 4, 5], usd: 1 });
  give(third);
  // Two of the session's own booked since (a retry booked with no answer of its own): summed; one unknown makes it unknown.
  assert.deepEqual(bookingOfAnswer([request(6), turn(6, 0), request(7), turn(7, 0.25)], given), { turns: [6, 7], usd: 0.25 });
  const unknown = bookingOfAnswer([request(6), turn(6, null), request(7), turn(7, 0.25)], given);
  assert.deepEqual(unknown, { turns: [6, 7], usd: null });
  give(unknown);
  // The next answer reads its own again.
  assert.deepEqual(bookingOfAnswer([request(8), turn(8, 0.5)], given), { turns: [8], usd: 0.5 });
  // Only side requests booked since: nothing of the answer's own, the side ones still given.
  assert.deepEqual(bookingOfAnswer([request(9, { side: true }), turn(9, 0.125)], given), { turns: [9], usd: undefined });
  // None booked since: nothing.
  assert.deepEqual(bookingOfAnswer([turn(1, 0.25), turn(2, 0.5)], given), { turns: [], usd: undefined });
  assert.deepEqual(turnsOf([request(1), turn(1, 0.25), turn(2, 0.5)]), [1, 2]);
});

test("conversations asking at once each read their own bookings: one that asks first takes none of another's, a retry is summed in its own conversation's answer, and a side request is still no answer's", () => {
  const given = new Set();
  const give = (booking) => booking.turns.forEach((n) => given.add(n));
  // Three children's requests booked together, at three prices, and a side request among them.
  const askedIn = new Map([[1, "a"], [2, "b"], [3, "c"], [5, "b"]]);
  const of = (conversation) => (n) => askedIn.get(n) === conversation;
  const records = [request(1), request(2), request(3), request(4, { side: true }), turn(2, 0.5), turn(1, 0.25), turn(4, 0.125), turn(3, null)];
  // b asks first: its own, and the side request given; a's and c's are left for their answers.
  const b = bookingOfAnswer(records, given, of("b"));
  assert.deepEqual(b, { turns: [2, 4], usd: 0.5 });
  give(b);
  const c = bookingOfAnswer(records, given, of("c"));
  assert.deepEqual(c, { turns: [3], usd: null }, "an unknown figure is its own conversation's alone");
  give(c);
  const a = bookingOfAnswer(records, given, of("a"));
  assert.deepEqual(a, { turns: [1], usd: 0.25 });
  give(a);
  // A conversation with nothing booked since its last answer reads nothing, though another's booking waits.
  const later = [...records, request(5), turn(5, 1)];
  assert.deepEqual(bookingOfAnswer(later, given, of("a")), { turns: [], usd: undefined });
  assert.deepEqual(bookingOfAnswer(later, given, of("b")), { turns: [5], usd: 1 });
  // Two requests of one conversation booked before its answer (a retry with no answer of its own): summed in that answer.
  const retried = new Map([[6, "a"], [7, "b"], [8, "a"]]);
  assert.deepEqual(bookingOfAnswer([request(6), turn(6, 0), request(7), turn(7, 0.5), request(8), turn(8, 0.25)], new Set(), (n) => retried.get(n) === "a"), { turns: [6, 8], usd: 0.25 });
});
