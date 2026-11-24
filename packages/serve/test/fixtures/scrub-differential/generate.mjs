// Writes expected.json: for each corpus row (corpus.mjs), in each wrap, the characters main's scrubber cut, read in
// count mode. Main is the scrubber before the shell lexer: b0058698b0, whose redact, learn and secret-* sources are the
// ones it was built from. To regenerate: check out BASE, build packages/serve (tsc), then
//   node test/fixtures/scrub-differential/generate.mjs <that build's dist directory> <the commit's full sha>
// The sha must be BASE: a different base is a different baseline, and this file says which one the test holds.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { corpus, covered, WRAPS } from "./corpus.mjs";

const BASE = "b0058698b0032901cecb6002e7f338110e628490";
const [dist, sha] = process.argv.slice(2);
if (!dist || sha !== BASE) {
  console.error(`usage: generate.mjs <dist of ${BASE}'s serve build> ${BASE}`);
  process.exit(2);
}
const { scrub } = await import(resolve(dist, "secret-cut.js"));
const rows = {};
for (const row of corpus()) {
  rows[row.id] = {};
  for (const [wrap, write] of Object.entries(WRAPS)) {
    const out = await scrub(write(row.text), { mode: "count" });
    rows[row.id][wrap] = covered(out.cuts);
  }
}
writeFileSync(new URL("./expected.json", import.meta.url), `${JSON.stringify({ base: BASE, generator: "test/fixtures/scrub-differential/generate.mjs", rows }, null, 1)}\n`);
console.log(`expected.json: ${Object.keys(rows).length} rows from ${BASE}`);
