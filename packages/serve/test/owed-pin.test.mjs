// `owed` (kernel/cap port.ts) is a refusal bypass by design: a paid step marked owed is booked and held without the cap's
// rule. So it is set in exactly four places in browser-cost.ts and two in compute-cost.ts, all for money its provider is
// already owed outside any call: the charge under no call (a release, its top-up), the reserve held from a reopen, a
// delayed release, a person's carried time; a computer's booked time, and a made computer's first stretch. Everywhere else it is only passed on as given (`...(x.owed ? { owed: true as const } : {})`)
// or read. A new setter anywhere in the repo's sources fails here, until it is reviewed and named in this pin.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const PACKAGES = new URL("../../", import.meta.url).pathname;
/** Every TypeScript source file under each package's src. */
function sources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try {
      walk(join(PACKAGES, pkg.name, "src"));
    } catch {
      // A package with no src.
    }
  }
  return files;
}

/** The four sites, each by the words of the step it marks. */
const SITES = [
  ["the charge under no call", /name: "this browser session's time"/],
  ["the reserve held from a reopen", /held from the reopen/],
  ["a delayed release", /this browser session's delayed release/],
  ["a person's carried time", /a person's time in the browser/],
];
/** And a computer's time (compute-cost.ts, #3338), money its provider is owed once the computer is made: the time it
 *  ran, booked each stretch and at its settle, and the first stretch of a computer already made. A computer not yet made
 *  is never held owed: the hold before its create is the cap's to refuse. */
const COMPUTE_SITES = [
  ["a computer's booked time", /name: `\$\{one\.provider\}'s computer time \(\$\{tag\}\)`/],
  ["a made computer's first stretch", /holdOf\(provider, stretchUsd\(priced\), basisOf\(provider, priced\), \{ owed: true \}\)/],
];

test("owed is set in exactly four places in browser-cost.ts and two in compute-cost.ts, for money already owed outside a call; elsewhere only passed on", () => {
  const setters = [];
  const passes = [];
  for (const file of sources()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const where = `${relative(PACKAGES, file)}:${i + 1}`;
      for (const match of line.matchAll(/owed:\s*true(\s+as const)?/g)) {
        if (match[1]) passes.push({ where, passedOn: /\.owed \? \{ owed: true as const \} : \{\}/.test(line) });
        else setters.push({ where, line });
      }
    });
  }
  const browser = setters.filter(({ where }) => where.startsWith("serve/src/browser-cost.ts:"));
  const compute = setters.filter(({ where }) => where.startsWith("serve/src/compute-cost.ts:"));
  assert.equal(browser.length + compute.length, setters.length, `owed is set only in browser-cost.ts and compute-cost.ts: ${JSON.stringify(setters.map(({ where }) => where))}`);
  assert.equal(browser.length, SITES.length, `exactly four setters in browser-cost.ts: ${JSON.stringify(browser.map(({ where }) => where))}`);
  for (const [what, words] of SITES) assert.equal(browser.filter(({ line }) => words.test(line)).length, 1, `one setter for ${what}`);
  assert.equal(compute.length, COMPUTE_SITES.length, `exactly two setters in compute-cost.ts: ${JSON.stringify(compute.map(({ where }) => where))}`);
  for (const [what, words] of COMPUTE_SITES) assert.equal(compute.filter(({ line }) => words.test(line)).length, 1, `one setter for ${what}`);
  assert.deepEqual(passes.filter(({ passedOn }) => !passedOn), [], "every other `owed: true as const` only passes on the owed it was given");
});

// `hold` (kernel/cap run-cap.ts) gives a step back on a lost claim: money reserved, never booked as cut. So only the
// browser's holds set it, in browser-cost.ts: its ledger holds (holdOf: a session's reserve, a reopen's, a delayed
// release, a person's time) and a browser call's hold. Every other `hold: true` only passes on the one it was given; the
// recorder's credential `hold` (pi-browser, which reaches no ledger) and computer-bench's `hold` (a serve run's create
// body, asking for a held computer) are other words for other things. Words in a string (a held computer's "a run
// started with hold: true", computer-held.ts) set nothing: strings are read as empty.
const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
// And a computer's stretch ahead (compute-cost.ts holdOf, #3338): money reserved for time it may run, given back at each
// stretch's booking and at its settle, never booked.
test("hold is set in exactly two places in browser-cost.ts and one in compute-cost.ts, on hold-only steps; elsewhere only passed on", () => {
  const setters = [];
  const passes = [];
  for (const file of sources()) {
    const where = relative(PACKAGES, file);
    if (where === "pi-browser/src/recorder/credential.ts" || where.startsWith("computer-bench/")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const match of line.replace(STRINGS, '""').matchAll(/\bhold:\s*true(\s+as const)?/g)) {
        if (match[1]) passes.push({ where: `${where}:${i + 1}`, passedOn: /\.hold \? \{ hold: true as const \} : \{\}/.test(line) });
        else setters.push({ where: `${where}:${i + 1}`, line });
      }
    });
  }
  const browser = setters.filter(({ where }) => where.startsWith("serve/src/browser-cost.ts:"));
  const compute = setters.filter(({ where }) => where.startsWith("serve/src/compute-cost.ts:"));
  assert.equal(browser.length + compute.length, setters.length, `hold is set only in browser-cost.ts and compute-cost.ts: ${JSON.stringify(setters.map(({ where }) => where))}`);
  assert.equal(browser.length, 2, `exactly two setters in browser-cost.ts: ${JSON.stringify(browser.map(({ where }) => where))}`);
  assert.equal(browser.filter(({ line }) => /booking\.admit\(\{ id, name, holdUsd: usd/.test(line)).length, 1, "one in holdOf, the ledger's holds");
  assert.equal(browser.filter(({ line }) => /name: "this browser call"/.test(line)).length, 1, "one on a browser call's hold");
  assert.equal(compute.length, 1, `exactly one setter in compute-cost.ts: ${JSON.stringify(compute.map(({ where }) => where))}`);
  assert.equal(compute.filter(({ line }) => /tool: COMPUTE_TOOL, hold: true,/.test(line)).length, 1, "one in its holdOf, a computer's stretch ahead");
  assert.deepEqual(passes.filter(({ passedOn }) => !passedOn), [], "every other `hold: true as const` only passes on the hold it was given");
});
