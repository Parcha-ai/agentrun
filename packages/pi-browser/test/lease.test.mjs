import assert from "node:assert/strict";
import test from "node:test";
import { isLeaseTransition, leaseTag } from "../dist/index.js";

const STATES = ["creating", "live", "releasing", "released", "lost"];
const ALLOWED = new Set(["none>creating", "creating>live", "creating>released", "creating>releasing", "live>releasing", "live>released", "live>lost", "releasing>released", "releasing>lost"]);
const TAG = /^[A-Za-z0-9_.-]{1,60}$/;

test("the lease moves only along its custody edges: released and lost are final, and only nothing becomes creating", () => {
  for (const from of ["none", ...STATES]) for (const to of STATES) {
    assert.equal(isLeaseTransition(from, to), ALLOWED.has(`${from}>${to}`), `${from} -> ${to}`);
  }
});

test("a tag of clean, short parts reads as its parts", () => {
  assert.equal(leaseTag("ar", "run_0123.abc", 4, 1), "ar-run_0123.abc-4-1");
  assert.equal(leaseTag("pib", "r", "1a2b3c4d", 12), "pib-r-1a2b3c4d-12");
});

test("a tag is the same for the same parts", () => {
  assert.equal(leaseTag("ar", "run/with:odd chars", "conversation-77", 3), leaseTag("ar", "run/with:odd chars", "conversation-77", 3));
});

test("parts that clean or cut to the same text still give distinct tags", () => {
  const head = "r".repeat(40);
  const pairs = [[["ar", "a/b", 1, 1], ["ar", "a:b", 1, 1]], [["ar", `${head}1`, 1, 1], ["ar", `${head}2`, 1, 1]], [["ar", "run", "c".repeat(20) + "x", 1], ["ar", "run", "c".repeat(20) + "y", 1]], [["ar", "run", 1, 12345678901], ["ar", "run", 1, 12345678902]]];
  for (const [a, b] of pairs) assert.notEqual(leaseTag(...a), leaseTag(...b), `${a} vs ${b}`);
});

test("a '-' outside the run part never lets two part lists make one tag", () => {
  const pairs = [[["ar", "r", "c-1", 2], ["ar", "r-c", "1", 2]], [["a-r", "x", 1, 1], ["a", "r-x", 1, 1]], [["ar", "r", "c", -1], ["ar", "r", "c-", 1]]];
  for (const [a, b] of pairs) assert.notEqual(leaseTag(...a), leaseTag(...b), `${a} vs ${b}`);
});

test("a run id with '-' keeps its tag as it reads", () => {
  assert.equal(leaseTag("ar", "job-2026-10-12-c7", 4, 1), "ar-job-2026-10-12-c7-4-1");
});

test("every tag is at most 60 characters of [A-Za-z0-9_.-], whatever its parts", () => {
  const parts = ["", "x", "ar", "pib", "agentrun", "a b", "ünïcødé", "../../etc", "x".repeat(200), "run-with-dashes-and-a-long-uuid-0f4b7c1e-9a2d-4c3b-8e5f-123456789abc", "\"quoted\" 'tag'"];
  for (const prefix of parts) for (const run of parts) for (const conversation of [...parts, 0, 123456789012345]) for (const seq of [1, 99, 12345678901234]) {
    const tag = leaseTag(prefix, run, conversation, seq);
    assert.match(tag, TAG, JSON.stringify([prefix, run, conversation, seq]));
  }
});
