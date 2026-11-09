// Two pieces of pi's adapter bookkeeping, each pinned on its own:
// - a refused call's words (pi.ts refusalWords) are held from the refusal to the call's result, and let go on every
//   result kind, never only on pi's blocked one, so a session holds none it will never use;
// - an answer's booking (adapter-loop bookingOfAnswer) is the one booking no answer was given yet: two generations of
//   one turn each read their own, and two bookings no answer was given (requests in flight together, which pi does not
//   make) read unknown, never the other request's figure.
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
    if (kind === "blocked") assert.deepEqual(replaced, { output: [{ type: "text", text: "Permission denied: read is set to deny on this server." }], isError: true });
    else assert.equal(replaced, undefined, `${kind}: pi's own result stands`);
  }
});

const turn = (n, usd) => ({ kind: "runner.turn", data: { turn: n, usd } });
const request = (n) => ({ kind: "runner.request", data: { turn: n } });

test("two generations of one turn each read their own booking; two bookings no answer was given read unknown, never the other's", () => {
  const given = new Set();
  // The first generation's request booked: it reads its own.
  const first = bookingOfAnswer([request(1), turn(1, 0.25)], given);
  assert.deepEqual(first, { turn: 1, usd: 0.25 });
  given.add(first.turn);
  // The second generation's, after it: it reads its own, never the first's again.
  const second = bookingOfAnswer([request(1), turn(1, 0.25), request(2), turn(2, 0.5)], given);
  assert.deepEqual(second, { turn: 2, usd: 0.5 });
  given.add(second.turn);
  // Two requests booked with no answer given either: which is whose cannot be told, so the cost is unknown.
  assert.equal(bookingOfAnswer([turn(1, 0.25), turn(2, 0.5), turn(3, 0.75), turn(4, 1)], given), "ambiguous");
  // None booked since: none.
  assert.equal(bookingOfAnswer([turn(1, 0.25), turn(2, 0.5)], given), "none");
  assert.deepEqual(turnsOf([request(1), turn(1, 0.25), turn(2, 0.5)]), [1, 2]);
});
