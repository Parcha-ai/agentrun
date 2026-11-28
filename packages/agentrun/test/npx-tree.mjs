// The npx walk's "one pi" row (npx-walk.sh): what `npx @parcha/agentrun` installed, read from its tree in the npm
// cache. Each @earendil-works package the launcher pins (pi-ai) must be installed once, at the version it pins: a second
// copy, or the one at another version, means npm resolved a pi the server is not tested with for something in the tree
// (release-preflight's launcherPins checks the launcher's manifest; this checks what npm made of it). A launcher that
// pins none, as each one published before the pin, is not checked: the row says how many copies it got.
//   node npx-tree.mjs <npm cache>   the evidence on stdout; exit 0 PASS, 1 FAIL, 3 not checked
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../../../scripts/is-main.mjs";

const LAUNCHER = "@parcha/agentrun";
const SCOPE = "@earendil-works/";

/** Each copy of `name` in a lockfile's packages, wherever npm nested it: [{ path, version }]. */
export function copies(lock, name) {
  return Object.entries(lock?.packages ?? {})
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => ({ path, version: entry?.version }));
}

/** The npx tree under <cache>/_npx that holds the launcher. */
export function findTree(cache) {
  const npx = join(cache, "_npx");
  const trees = existsSync(npx) ? readdirSync(npx).map((hash) => join(npx, hash)) : [];
  const tree = trees.find((dir) => existsSync(join(dir, "node_modules", LAUNCHER, "package.json")));
  if (!tree) throw new Error(`no npx tree holds ${LAUNCHER} under ${npx}`);
  return tree;
}

const listed = (found) => found.map((c) => `${c.version} at ${c.path}`).join(", ");

/** The row from the launcher's manifest and the tree's lockfile: { result: PASS | FAIL | "not checked", evidence }. */
export function onePi(launcher, lock) {
  const others = ["openai", "@google/genai"].map((name) => `${name} ${copies(lock, name).length}`).join(", ");
  const pins = Object.entries(launcher.dependencies ?? {}).filter(([name]) => name.startsWith(SCOPE));
  if (!pins.length) {
    const pi = copies(lock, `${SCOPE}pi-ai`);
    const top = pi.find((c) => c.path === `node_modules/${SCOPE}pi-ai`);
    return {
      result: "not checked",
      evidence: `launcher ${launcher.version} pins no @earendil-works package (published before the pin): pi-ai ${pi.length}${top ? ` (${top.version} at the top)` : ""}, ${others}`,
    };
  }
  const bad = [];
  const good = [];
  for (const [name, pinned] of pins) {
    const found = copies(lock, name);
    if (found.length === 1 && found[0].version === pinned) good.push(`${name} ${pinned} once`);
    else bad.push(`${name}: ${found.length} ${found.length === 1 ? "copy" : "copies"}${found.length ? ` (${listed(found)})` : ""}, launcher ${launcher.version} pins ${pinned}`);
  }
  if (bad.length) return { result: "FAIL", evidence: bad.join("; ") };
  return { result: "PASS", evidence: `${good.join(", ")}, as launcher ${launcher.version} pins it; ${others}` };
}

if (isMain(import.meta)) {
  try {
    const tree = findTree(process.argv[2]);
    const json = (path) => JSON.parse(readFileSync(path, "utf8"));
    const { result, evidence } = onePi(json(join(tree, "node_modules", LAUNCHER, "package.json")), json(join(tree, "node_modules", ".package-lock.json")));
    console.log(evidence);
    process.exitCode = result === "PASS" ? 0 : result === "FAIL" ? 1 : 3;
  } catch (error) {
    console.log(error.message);
    process.exitCode = 1;
  }
}
