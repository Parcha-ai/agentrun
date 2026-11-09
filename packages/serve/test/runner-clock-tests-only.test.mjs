// RunnerOptions.clock (the claim deadline's clock) is a seam for tests: it reaches the runner only as an options field a
// test passes. No production caller of startRunner passes it or forwards a bag of options that could carry it, and the
// runner reads it from its options alone, never from the environment or argv. Read from the source of every package, so a
// new caller is checked as it lands. (The conformance suite's runner/conformance/ is the tests' own code.)
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGES = join(ROOT, "packages");
const RUNNER = join(PACKAGES, "serve", "src", "runner", "runner.ts");
const SUITE = join(PACKAGES, "serve", "src", "runner", "conformance");

/** Every .ts file under each package's src. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {}
  }
  return out;
}

/** The argument text of each `startRunner(` call in `text`, up to its matching close paren. */
function callsIn(text) {
  const calls = [];
  for (let at = text.indexOf("startRunner("); at >= 0; at = text.indexOf("startRunner(", at + 1)) {
    if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue;
    let depth = 0;
    let end = at + "startRunner".length;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(at + "startRunner(".length, end));
  }
  return calls;
}

test("no production caller of startRunner passes a clock, or forwards a bag of options that could carry one", () => {
  const production = sources().filter((file) => file !== RUNNER && !file.startsWith(SUITE));
  const callers = production.filter((file) => readFileSync(file, "utf8").includes("startRunner("));
  assert.ok(callers.length > 0, "the runner process's own startRunner call is read");
  for (const file of callers) {
    const where = relative(ROOT, file);
    for (const call of callsIn(readFileSync(file, "utf8"))) {
      assert.doesNotMatch(call, /\bclock\b/, `${where} passes startRunner a clock: ${call}`);
      // A spread of a whole object (`...options`) could forward one; a field set by name, or a spread of an object
      // literal built from named fields, cannot.
      assert.doesNotMatch(call, /\.\.\.\s*[A-Za-z_$][\w$.]*\s*[,}\n]/, `${where} forwards a bag of options to startRunner: ${call}`);
    }
  }
});

test("the runner reads its clock from its options alone: never the environment or argv", () => {
  const text = readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(text, /process\.(env|argv)/, "runner.ts reads neither the environment nor argv");
  assert.match(text, /clock = \{ now: \(\) => Date\.now\(\)/, "its clock defaults to the real one, from the options' destructure");
});
