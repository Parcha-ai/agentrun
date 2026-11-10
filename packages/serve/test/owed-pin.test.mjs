// `owed` (kernel/cap port.ts) is a refusal bypass by design: a paid step marked owed is booked and held without the cap's
// rule. So it is set in exactly four places, all in browser-cost.ts, all for money its provider is already owed outside
// any call: the charge under no call (a release, its top-up), the reserve held from a reopen, a delayed release, and a
// person's carried time. Everywhere else it is only passed on as given (`...(x.owed ? { owed: true as const } : {})`)
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

test("owed is set in exactly four places, in browser-cost.ts, for money already owed outside a call; elsewhere only passed on", () => {
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
  assert.ok(setters.every(({ where }) => where.startsWith("serve/src/browser-cost.ts:")), `owed is set only in browser-cost.ts: ${JSON.stringify(setters.map(({ where }) => where))}`);
  assert.equal(setters.length, SITES.length, `exactly four setters: ${JSON.stringify(setters.map(({ where }) => where))}`);
  for (const [what, words] of SITES) assert.equal(setters.filter(({ line }) => words.test(line)).length, 1, `one setter for ${what}`);
  assert.deepEqual(passes.filter(({ passedOn }) => !passedOn), [], "every other `owed: true as const` only passes on the owed it was given");
});
