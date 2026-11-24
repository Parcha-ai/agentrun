// The classifier step is off unless a decider is given: a web with none answers, writes for the model, and receipts
// byte for byte what createWeb did before the step existed. web-runs.golden.json was written by createWeb at e937809c71
// (PR-B's head, before decide/) running the same steps on the same fakes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeWeb, steps } from "./fixtures/web-runs.mjs";

const golden = readFileSync(new URL("./fixtures/web-runs.golden.json", import.meta.url), "utf8");

test("with no decider, every answer, the text the model reads and every receipt are byte-identical to createWeb's before the step", async () => {
  const now = await steps(fakeWeb());
  assert.equal(`${JSON.stringify(now, null, 1)}\n`, golden);
});

test("a decider given as undefined is no decider: the same bytes", async () => {
  const now = await steps(fakeWeb({ decider: undefined, bounds: { decideMs: 5 } }));
  assert.equal(`${JSON.stringify(now, null, 1)}\n`, golden);
});
