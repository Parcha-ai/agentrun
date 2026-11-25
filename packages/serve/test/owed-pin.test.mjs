// `owed` (kernel/cap port.ts) is a refusal bypass by design: a paid step marked owed is booked and held without the cap's
// rule. So it is set only in the OWED tables of browser-cost.ts (five steps) and compute-cost.ts (two), each step by its
// name and each name used once, all for money its provider is already owed outside any call. Everywhere else it is only
// passed on as given (`...(x.owed ? { owed: true as const } : {})`) or read. A new setter anywhere in the repo's sources
// fails here, until it is reviewed and named in this pin.
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

/** The owed steps, by the name each file gives them in its own OWED table (`name: { owed: true },`), the one place it
 *  sets owed. browser-cost.ts: the charge under no call (a release, its top-up), the reserve held from a reopen, that
 *  reserve held again at one stretch, a delayed release, a person's carried time. compute-cost.ts (#3338), money its
 *  provider is owed once the computer is made: the time it ran, booked each stretch and at its settle, and the first
 *  stretch of a computer already made. A computer not yet made is never held owed: the hold before its create is the
 *  cap's to refuse. */
const OWED_STEPS = {
  "serve/src/browser-cost.ts": ["charge", "reopenReserve", "reserveAgain", "delayedRelease", "personTime"],
  "serve/src/compute-cost.ts": ["bookedTime", "madeFirstStretch"],
};
/** A source line with its comments' lines left out (a comment may name OWED and sets nothing). */
const code = (line) => !/^\s*(\/\/|\*|\/\*)/.test(line);

test("owed is set only in the OWED tables of browser-cost.ts and compute-cost.ts, each named step used once, for money already owed outside a call; elsewhere only passed on", () => {
  const setters = [];
  const passes = [];
  const texts = new Map();
  for (const file of sources()) {
    const where = relative(PACKAGES, file);
    const lines = readFileSync(file, "utf8").split("\n");
    texts.set(where, lines.filter(code));
    lines.forEach((line, i) => {
      if (!code(line)) return;
      for (const match of line.matchAll(/owed:\s*true(\s+as const)?/g)) {
        if (match[1]) passes.push({ where: `${where}:${i + 1}`, passedOn: /\.owed \? \{ owed: true as const \} : \{\}/.test(line) });
        else setters.push({ file: where, where: `${where}:${i + 1}`, line });
      }
    });
  }
  // Every setter is an entry of its file's OWED table, by its name.
  const strays = setters.filter(({ file, line }) => !(file in OWED_STEPS) || !/^\s*\w+: \{ owed: true \},?\s*$/.test(line));
  assert.deepEqual(strays.map(({ where }) => where), [], "owed is set only as an entry of an OWED table, in browser-cost.ts or compute-cost.ts");
  for (const [file, names] of Object.entries(OWED_STEPS)) {
    const named = setters.filter((setter) => setter.file === file).map(({ line }) => /^\s*(\w+):/.exec(line)[1]);
    assert.deepEqual(named, names, `${file}'s OWED table names exactly these owed steps`);
    for (const name of names) {
      const uses = texts.get(file).filter((line) => new RegExp(`\\bOWED\\.${name}\\b`).test(line));
      assert.equal(uses.length, 1, `${file}: OWED.${name} marks one step: ${JSON.stringify(uses)}`);
    }
  }
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
