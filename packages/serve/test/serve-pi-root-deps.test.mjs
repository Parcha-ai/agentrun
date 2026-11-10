// An installed server (npm pack, the release smoke's "stranger") has every package serve's code loads, not only this
// repository: where serve imports @parcha/agentrun-pi's ROOT (learned-workflow.ts's createPiHostRunner, which runs a
// learned workflow's model nodes), that root loads optional peers of agentrun-pi (@earendil-works/pi-coding-agent and what
// its host runner needs). Each one the root's import graph reaches is serve's own dependency or a dependency of one, so a
// learned_workflow call on an installed server never fails with "Cannot find package '@earendil-works/pi-coding-agent'".
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serveDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serve = JSON.parse(readFileSync(join(serveDir, "package.json"), "utf8"));
/** Package `name`'s manifest as node finds it from serve (the nearest node_modules up), or undefined. */
function manifestOf(name) {
  for (let dir = serveDir; ; dir = dirname(dir)) {
    const path = join(dir, "node_modules", name, "package.json");
    if (existsSync(path)) return { dir: dirname(path), manifest: JSON.parse(readFileSync(path, "utf8")) };
    if (dirname(dir) === dir) return undefined;
  }
}
const { dir: piDir, manifest: pi } = manifestOf("@parcha/agentrun-pi");

/** Every .js file under `dir`. */
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith(".js") ? [path] : [];
});
/** The specifiers a module imports, static and dynamic, type-only imports aside (none survive in .js). */
const specifiersOf = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
/** A bare specifier's package name. */
const packageOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** The packages agentrun-pi's root reaches at load: its dist from index.js, through its relative imports. */
function rootReaches() {
  const seen = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) packages.add(packageOf(spec));
    }
  };
  visit(join(piDir, "dist", "index.js"));
  return packages;
}

test("serve's dist imports agentrun-pi's root where a learned workflow runs its model nodes", () => {
  const importers = jsFiles(join(serveDir, "dist")).filter((file) => specifiersOf(readFileSync(file, "utf8")).includes("@parcha/agentrun-pi")).map((file) => file.slice(join(serveDir, "dist").length + 1)).sort();
  assert.ok(importers.includes("learned-workflow.js"), JSON.stringify(importers));
});

test("every optional peer of agentrun-pi its root loads is serve's dependency, or a dependency of one: an installed server has it", () => {
  const optional = Object.entries(pi.peerDependenciesMeta ?? {}).filter(([, meta]) => meta?.optional).map(([name]) => name);
  const reached = [...rootReaches()].filter((name) => optional.includes(name));
  assert.ok(reached.includes("@earendil-works/pi-coding-agent"), `the root loads pi-coding-agent: ${JSON.stringify(reached)}`);
  const own = new Set([...Object.keys(serve.dependencies ?? {}), ...Object.entries(serve.peerDependencies ?? {}).filter(([name]) => !serve.peerDependenciesMeta?.[name]?.optional).map(([name]) => name)]);
  // What serve's own dependencies install with them (one level: pi-coding-agent brings pi-agent-core and pi-tui).
  const brought = new Set([...own].flatMap((name) => Object.keys(manifestOf(name)?.manifest.dependencies ?? {})));
  const missing = reached.filter((name) => !own.has(name) && !brought.has(name));
  assert.deepEqual(missing, [], "each is serve's dependency or comes with one");
  assert.equal(serve.dependencies["@earendil-works/pi-coding-agent"], pi.devDependencies["@earendil-works/pi-coding-agent"], "pinned as agentrun-pi pins it");
});
