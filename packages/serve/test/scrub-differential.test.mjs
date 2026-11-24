// The scrubber cuts every character main's scrubber cut on a fixed corpus of command lines (fixtures/scrub-differential):
// a reader change may add cuts, never drop one. expected.json is main's (generate.mjs states the commit and how to
// rebuild it); a row it lacks fails here by name rather than passing unread. Every input is synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { scrub } from "../dist/secret-cut.js";
import { corpus, covered, uncovered, WRAPS } from "./fixtures/scrub-differential/corpus.mjs";

const expected = JSON.parse(readFileSync(new URL("./fixtures/scrub-differential/expected.json", import.meta.url), "utf8"));

test("the differential corpus: every row, in each wrap, has a recorded baseline from main", () => {
  assert.match(expected.base, /^[0-9a-f]{40}$/);
  const missing = corpus().flatMap((row) => Object.keys(WRAPS).filter((wrap) => !expected.rows[row.id]?.[wrap]).map((wrap) => `${row.id} (${wrap})`));
  assert.deepEqual(missing, [], `expected.json has no baseline for these rows: run generate.mjs against ${expected.base}'s build (its header says how)`);
});

test("the differential corpus: every character main cut is cut still, raw and JSON-wrapped", async () => {
  const less = [];
  for (const row of corpus()) {
    for (const [wrap, write] of Object.entries(WRAPS)) {
      const want = expected.rows[row.id]?.[wrap];
      if (!want) continue;
      const text = write(row.text);
      const left = uncovered(want, covered((await scrub(text, { mode: "count" })).cuts));
      if (left.length) less.push(`${row.id} (${wrap}): ${left.map(([s, e]) => JSON.stringify(text.slice(s, e))).join(", ")} left in ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(less, [], `cut by main (${expected.base.slice(0, 10)}), not here`);
});
