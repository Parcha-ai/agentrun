// A site build runs writeReplay with node:sqlite and pi-durable-agent's browser-safe modules only. replay.mjs's import
// graph must never reach pi-durable, chord or pi-ai, nor the package's root index, which loads them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const replay = new URL("./replay.mjs", import.meta.url).href;
const probe = `
import { registerHooks } from "node:module";
const seen = [];
registerHooks({ resolve(specifier, context, nextResolve) { const resolved = nextResolve(specifier, context); seen.push(resolved.url); return resolved; } });
await import(${JSON.stringify(replay)});
console.log(JSON.stringify(seen));
`;

test("loading replay.mjs resolves pi-durable-agent's ./export and ./timeline, and nothing of pi-durable, chord or pi-ai", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  for (const module of ["/pi-durable-agent/dist/export.js", "/pi-durable-agent/dist/timeline/index.js"]) {
    assert.ok(seen.some((url) => url.endsWith(module)), `${module} is in the graph, so the hook saw the package`);
  }
  const reached = seen.filter((url) => /\/node_modules\/@earendil-works\//.test(url) || url.endsWith("/pi-durable-agent/dist/index.js"));
  assert.deepEqual(reached, [], "no pi-durable, chord, pi-ai or package root");
});
