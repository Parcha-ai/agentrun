// An installed server (npm pack, the release smoke's "stranger") has every package serve's workflow code loads, not only
// this repository: the durable workflow task and the host runner a learned workflow runs its model nodes on
// (dist/workflow/, learned-workflow.ts's createPiHostRunner) load @earendil-works/pi-coding-agent and pi-agent-core among
// others. Each one they reach is serve's own dependency or a peer it requires, so a learned_workflow call on an installed
// server never fails with "Cannot find package". And serve loads nothing of @parcha/agentrun-pi.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serveDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serve = JSON.parse(readFileSync(join(serveDir, "package.json"), "utf8"));
const dist = join(serveDir, "dist");

/** Every .js file under `dir`. */
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith(".js") ? [path] : [];
});
/** The specifiers a module imports, static and dynamic, type-only imports aside (none survive in .js). */
const specifiersOf = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
/** A bare specifier's package name. */
const packageOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

test("serve's dist imports nothing of @parcha/agentrun-pi, and serve does not depend on it", () => {
  const importers = jsFiles(dist).filter((file) => specifiersOf(readFileSync(file, "utf8")).some((spec) => packageOf(spec) === "@parcha/agentrun-pi")).map((file) => file.slice(dist.length + 1));
  assert.deepEqual(importers, []);
  assert.equal(serve.dependencies["@parcha/agentrun-pi"], undefined);
});

test("every package serve's workflow code loads is serve's dependency or a peer it requires: an installed server has it", () => {
  const reached = new Set(jsFiles(join(dist, "workflow")).flatMap((file) => specifiersOf(readFileSync(file, "utf8"))).filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:")).map(packageOf));
  assert.ok(reached.has("@earendil-works/pi-coding-agent") && reached.has("@earendil-works/pi-agent-core"), `the host runner loads pi-coding-agent and pi-agent-core: ${JSON.stringify([...reached])}`);
  const own = new Set([...Object.keys(serve.dependencies ?? {}), ...Object.entries(serve.peerDependencies ?? {}).filter(([name]) => !serve.peerDependenciesMeta?.[name]?.optional).map(([name]) => name)]);
  assert.deepEqual([...reached].filter((name) => !own.has(name)), [], "each is serve's dependency or a peer it requires");
  assert.equal(serve.dependencies["@earendil-works/pi-agent-core"], serve.dependencies["@earendil-works/pi-coding-agent"], "pinned with pi-coding-agent: one pi family");
});
