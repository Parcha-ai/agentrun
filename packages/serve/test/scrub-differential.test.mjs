// The scrubber cuts every character main's scrubber cut on a fixed corpus of command lines (fixtures/scrub-differential):
// a reader change may add cuts, never drop one. expected.json is main's (generate.mjs states the commit and how to
// rebuild it); a row it lacks fails here by name rather than passing unread. That is a floor only, so the password each
// row gives its command must be gone too, but for the rows KNOWN_MISS names. Every input is synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { scrub } from "../dist/secret-cut.js";
import { BASE, corpus, covered, PASSWORD, uncovered, WRAPS } from "./fixtures/scrub-differential/corpus.mjs";

const expected = JSON.parse(readFileSync(new URL("./fixtures/scrub-differential/expected.json", import.meta.url), "utf8"));

/** Rows whose password the scrubber leaves, each with why. The exit (deleting the span scans) may shrink this list,
 *  never grow it. */
const KNOWN_MISS = new Map([
  // A backslash before a name that starts with r, n, b, f or t, outside a Windows path (a drive's, a quoted drive's,
  // `.\`'s), is read as a JSON string's escape (ruling A), so no view holds the name: `\redis-cli` reads as a carriage
  // return and `edis-cli`. Main leaves both too.
  ["name/escaped-first/redis-cli", "`\\r` is an escape to the views"],
  ["name/escaped-first/npm", "`\\n` is an escape to the views"],
]);

/** Rows main cut nothing of that the lexer read cuts: a baseline written from a build with the lexer would hold cuts
 *  here, so these fail by name if expected.json is regenerated from anything but main. */
const CANARIES = ["name/squoted/docker", "name/exe/mysql", "name/nbsp/npm", "redirect/before/5/redis-cli"];

/** Each row, in each wrap, scrubbed once (count mode) for the tests below. */
const scrubbed = (async () => {
  const out = [];
  for (const row of corpus()) {
    for (const [wrap, write] of Object.entries(WRAPS)) {
      const text = write(row.text);
      out.push({ row, wrap, text, cuts: covered((await scrub(text, { mode: "count" })).cuts) });
    }
  }
  return out;
})();

test("the differential corpus: expected.json is main's, row for row", () => {
  assert.equal(expected.base, BASE);
  assert.deepEqual(Object.keys(expected.rows).sort(), corpus().map((row) => row.id).sort(), "expected.json's rows are not the corpus's: run generate.mjs (its header says how)");
  const missing = corpus().flatMap((row) => Object.keys(WRAPS).filter((wrap) => !expected.rows[row.id]?.[wrap]).map((wrap) => `${row.id} (${wrap})`));
  assert.deepEqual(missing, [], `expected.json has no baseline for these rows: run generate.mjs against ${BASE}'s build (its header says how)`);
  for (const id of CANARIES) for (const wrap of Object.keys(WRAPS)) assert.deepEqual(expected.rows[id]?.[wrap], [], `${id} (${wrap}): main cut nothing here; a baseline that cuts it is no main's`);
});

test("the differential corpus: every character main cut is cut still, raw and JSON-wrapped", async () => {
  const less = [];
  for (const { row, wrap, text, cuts } of await scrubbed) {
    const want = expected.rows[row.id]?.[wrap];
    if (!want) continue;
    const left = uncovered(want, cuts);
    if (left.length) less.push(`${row.id} (${wrap}): ${left.map(([s, e]) => JSON.stringify(text.slice(s, e))).join(", ")} left in ${JSON.stringify(text)}`);
  }
  assert.deepEqual(less, [], `cut by main (${BASE.slice(0, 10)}), not here`);
});

test("the differential corpus: every row's password is gone, raw and JSON-wrapped, but the known misses", async () => {
  const leaks = [];
  const missed = new Set();
  for (const { row, wrap, text, cuts } of await scrubbed) {
    const spans = [];
    for (let at = text.indexOf(PASSWORD); at >= 0; at = text.indexOf(PASSWORD, at + 1)) spans.push([at, at + PASSWORD.length]);
    if (!uncovered(spans, cuts).length) continue;
    if (KNOWN_MISS.has(row.id)) missed.add(row.id);
    else leaks.push(`${row.id} (${wrap}): ${JSON.stringify(text)}`);
  }
  assert.deepEqual(leaks, [], "the password is left in these rows");
  assert.deepEqual([...KNOWN_MISS.keys()].filter((id) => !missed.has(id)), [], "KNOWN_MISS names rows whose password is cut: drop them from it");
});
