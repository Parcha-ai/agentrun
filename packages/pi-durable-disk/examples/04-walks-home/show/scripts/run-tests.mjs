// `npm test`: the show's unit tests, run through node:test's own API so that a test file that reported nothing fails the run.
// `node --test` counts what it was told; a file whose process ended before its tests were reported (or that registered none) can leave
// the total short while the run still says "fail 0" (a run once printed 513 where 519 ran). Here every file in test/ must report at
// least one test, and the per-file counts are printed whenever a file is missing, or any test, suite or hook fails.
//   node scripts/run-tests.mjs [test/some.test.ts ...]
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2).map((f) => resolve(show, f));
const files = requested.length > 0 ? requested : readdirSync(join(show, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => join(show, "test", f));

const seen = new Map(files.map((f) => [f, { pass: 0, fail: 0, skip: 0 }]));
let failures = 0; // every test:fail event, suites and hooks included: the exit status never depends on how the totals are counted
// The same deadline as every `node --test` CI runs: a test that never settles fails by name after 4 min, and a file that leaves a
// handle open still ends once its tests are done.
const stream = run({ files, cwd: show, timeout: 240_000, forceExit: true });
stream.on("test:pass", (e) => {
  const c = seen.get(e.file);
  // A test with subtests also reports a suite, and a file that exits cleanly without reporting anything is reported as one passing "test" named by its own path:
  // neither is a test, so the total matches `node --test` and a silent file counts as nothing.
  if (!c || e.details?.type === "suite" || e.name === e.file) return;
  if (e.skip) c.skip++;
  else c.pass++;
});
stream.on("test:fail", (e) => {
  failures++;
  const c = seen.get(e.file);
  if (c && e.details?.type !== "suite") c.fail++;
  const error = e.details?.error;
  const why = [error?.message, error?.cause?.message].filter(Boolean).join(": "); // a failed hook says "failed running after hook"; its own error is the cause
  console.error(`not ok: ${relative(show, e.file ?? "?")} :: ${e.name}\n${String(why).split("\n").slice(0, 12).join("\n")}`);
});
stream.on("test:stderr", (e) => process.stderr.write(e.message));
stream.on("test:stdout", () => {});
await new Promise((done) => stream.on("end", done).on("error", done).resume());

const missing = [...seen].filter(([, c]) => c.pass + c.fail + c.skip === 0).map(([f]) => relative(show, f));
const total = [...seen.values()].reduce((a, c) => ({ pass: a.pass + c.pass, fail: a.fail + c.fail, skip: a.skip + c.skip }), { pass: 0, fail: 0, skip: 0 });
const bad = missing.length > 0 || failures > 0;
if (bad) {
  for (const [f, c] of seen) console.error(`${String(c.pass + c.fail + c.skip).padStart(4)} ${relative(show, f)}${c.fail ? `  (${c.fail} failed)` : ""}`);
  if (missing.length > 0) console.error(`FAIL: ${missing.length} test file(s) reported no tests (crashed or ended early): ${missing.join(", ")}`);
}
console.log(`# files ${seen.size}\n# tests ${total.pass + total.fail + total.skip}\n# pass ${total.pass}\n# fail ${total.fail}\n# skipped ${total.skip}${missing.length ? `\n# missing ${missing.length}` : ""}`);
process.exit(bad ? 1 : 0);
