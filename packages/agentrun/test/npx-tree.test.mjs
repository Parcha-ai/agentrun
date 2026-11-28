import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { copies, findTree, onePi } from "./npx-tree.mjs";

const script = fileURLToPath(new URL("./npx-tree.mjs", import.meta.url));

/** A lockfile's packages from [path, version] pairs, as npm writes node_modules/.package-lock.json. */
const lockOf = (pairs) => ({ packages: Object.fromEntries(pairs.map(([path, version]) => [path, { version }])) });

const PINNED = { version: "0.4.37", dependencies: { "@earendil-works/pi-ai": "1.5.2", "@parcha/agentrun-serve": "0.1.0-beta.69" } };
const UNPINNED = { version: "0.4.35", dependencies: { "@parcha/agentrun-serve": "0.1.0-beta.67" } };
const ONE = lockOf([
  ["node_modules/@parcha/agentrun", "0.4.37"],
  ["node_modules/@earendil-works/pi-ai", "1.5.2"],
  ["node_modules/@earendil-works/pi-agent-core", "1.5.2"],
  ["node_modules/openai", "7.19.0"],
  ["node_modules/@google/genai", "1.30.0"],
]);
// What npx installed before the pin: the newest pi-ai at the top, the tested one nested under a pi package.
const FIVE = lockOf([
  ["node_modules/@parcha/agentrun", "0.4.35"],
  ["node_modules/@earendil-works/pi-ai", "1.7.0"],
  ["node_modules/openai", "7.20.0"],
  ["node_modules/@earendil-works/pi-agent-core/node_modules/@earendil-works/pi-ai", "1.5.2"],
  ["node_modules/@earendil-works/pi-agent-core/node_modules/openai", "7.19.0"],
  ["node_modules/@parcha/agentrun-import/node_modules/@earendil-works/pi-ai", "1.5.2"],
  ["node_modules/not-openai", "1.0.0"],
  ["node_modules/@x/openai", "1.0.0"],
]);

test("copies counts a package wherever npm nested it, and no package whose name only ends the same", () => {
  assert.deepEqual(copies(FIVE, "openai"), [
    { path: "node_modules/openai", version: "7.20.0" },
    { path: "node_modules/@earendil-works/pi-agent-core/node_modules/openai", version: "7.19.0" },
  ]);
  assert.equal(copies(FIVE, "@earendil-works/pi-ai").length, 3);
  assert.deepEqual(copies(ONE, "@google/genai"), [{ path: "node_modules/@google/genai", version: "1.30.0" }]);
  assert.deepEqual(copies({}, "openai"), []);
});

test("one pi: each package the launcher pins, installed once at the pinned version, passes", () => {
  const { result, evidence } = onePi(PINNED, ONE);
  assert.equal(result, "PASS");
  assert.match(evidence, /@earendil-works\/pi-ai 1\.5\.2 once, as launcher 0\.4\.37 pins it/);
  assert.match(evidence, /openai 1, @google\/genai 1/);
});

test("one pi: a second copy, or the one copy at another version, fails and names each copy", () => {
  const nested = lockOf([
    ["node_modules/@earendil-works/pi-ai", "1.5.2"],
    ["node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/pi-ai", "1.6.0"],
  ]);
  const two = onePi(PINNED, nested);
  assert.equal(two.result, "FAIL");
  assert.match(two.evidence, /@earendil-works\/pi-ai: 2 copies \(1\.5\.2 at node_modules\/@earendil-works\/pi-ai, 1\.6\.0 at node_modules\/@earendil-works\/pi-durable\/node_modules\/@earendil-works\/pi-ai\), launcher 0\.4\.37 pins 1\.5\.2/);

  const moved = onePi(PINNED, lockOf([["node_modules/@earendil-works/pi-ai", "1.7.0"]]));
  assert.equal(moved.result, "FAIL");
  assert.match(moved.evidence, /1 copy \(1\.7\.0 at node_modules\/@earendil-works\/pi-ai\), launcher 0\.4\.37 pins 1\.5\.2/);

  const none = onePi(PINNED, lockOf([["node_modules/@parcha/agentrun", "0.4.37"]]));
  assert.equal(none.result, "FAIL");
  assert.match(none.evidence, /@earendil-works\/pi-ai: 0 copies/);
});

test("one pi: a launcher that pins no pi package is not checked, and the row says how many copies it got", () => {
  const { result, evidence } = onePi(UNPINNED, FIVE);
  assert.equal(result, "not checked");
  assert.match(evidence, /launcher 0\.4\.35 pins no @earendil-works package/);
  assert.match(evidence, /pi-ai 3 \(1\.7\.0 at the top\), openai 2, @google\/genai 0/);
});

/** An npm cache with one npx tree in it, as `npx @parcha/agentrun` leaves it. */
function cacheWith(launcher, lock) {
  const cache = mkdtempSync(join(tmpdir(), "npx-tree-"));
  const tree = join(cache, "_npx", "4db893df5725da01");
  mkdirSync(join(tree, "node_modules", "@parcha", "agentrun"), { recursive: true });
  writeFileSync(join(tree, "node_modules", "@parcha", "agentrun", "package.json"), JSON.stringify(launcher));
  writeFileSync(join(tree, "node_modules", ".package-lock.json"), JSON.stringify(lock));
  return { cache, tree };
}

test("findTree finds the npx tree that holds the launcher, and refuses a cache with none", () => {
  const { cache, tree } = cacheWith(PINNED, ONE);
  mkdirSync(join(cache, "_npx", "0000000000000000", "node_modules"), { recursive: true });
  assert.equal(findTree(cache), tree);
  assert.throws(() => findTree(mkdtempSync(join(tmpdir(), "npx-tree-empty-"))), /no npx tree holds @parcha\/agentrun under .*_npx/);
});

test("the command: exit 0 and the evidence on a pass, 1 on a fail, 3 when not checked", () => {
  const run = (cache) => spawnSync(process.execPath, [script, cache], { encoding: "utf8" });
  const pass = run(cacheWith(PINNED, ONE).cache);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /^@earendil-works\/pi-ai 1\.5\.2 once/);
  const fail = run(cacheWith(PINNED, FIVE).cache);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /pi-ai: 3 copies/);
  const unchecked = run(cacheWith(UNPINNED, FIVE).cache);
  assert.equal(unchecked.status, 3);
  assert.match(unchecked.stdout, /pins no @earendil-works package/);
  const empty = run(mkdtempSync(join(tmpdir(), "npx-tree-empty-")));
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /no npx tree holds @parcha\/agentrun/);
});
