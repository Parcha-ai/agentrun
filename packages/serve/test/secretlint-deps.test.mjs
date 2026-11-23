// What serve installs of secretlint, the key scan an import runs (secret-cut.ts). Since v14 the rules are part of
// @secretlint/core (`@secretlint/core/builtin`), and npm marks every rule and preset package deprecated: an install that
// pulls one prints "npm warn deprecated", the first thing a new user's `npx @parcha/agentrun` shows. So serve depends on
// none, and the profiler it switches off is the one core loads (core pins it exactly), or the switch reaches no scan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serveDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serve = JSON.parse(readFileSync(join(serveDir, "package.json"), "utf8"));

test("serve depends on no secretlint rule or preset package: the rules are core's, and npm warns on each package", () => {
  const packages = Object.keys(serve.dependencies ?? {}).filter((name) => name.startsWith("@secretlint/secretlint-rule-"));
  assert.deepEqual(packages, []);
});

test("serve pins @secretlint/profiler at the version @secretlint/core loads, so switching it off reaches every scan", () => {
  const core = JSON.parse(readFileSync(createRequire(join(serveDir, "package.json")).resolve("@secretlint/core/package.json"), "utf8"));
  assert.equal(core.version, serve.dependencies["@secretlint/core"], "the installed core is the pinned one");
  assert.equal(serve.dependencies["@secretlint/profiler"], core.dependencies["@secretlint/profiler"]);
});

test("the scan finds a key of a known format and leaves plain text alone", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  // A fake GitHub token: the format's prefix and length, made up.
  const fake = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
  assert.ok((await secretsIn(`token ${fake} in a log`)).includes(fake));
  assert.deepEqual(await secretsIn("nothing secret in this line"), []);
});
