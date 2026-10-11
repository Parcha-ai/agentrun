// The package's shape: every entry in `exports` imports on its own, and importing any entry the package ships loads
// none of its dependencies or peers (each is loaded on first use, so a host pays for a PDF engine or an image processor
// only when it reads a PDF or fits an image). A part not built yet throws a typed error, never a half answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NotBuiltError, notBuilt } from "@parcha/pi-vision";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const specifiers = Object.keys(pkg.exports).map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));

test("every entry imports and exports something", async () => {
  for (const specifier of specifiers) assert.ok(Object.keys(await import(specifier)).length > 0, specifier);
});

test("importing every runtime entry loads no dependency and no peer", () => {
  const runtime = specifiers.filter((s) => !s.endsWith("/testing"));
  const script = `
    import { registerHooks } from "node:module";
    const seen = new Set();
    registerHooks({ resolve(specifier, context, next) { if (!/^(node:|\\.|\\/|file:)/.test(specifier)) seen.add(specifier); return next(specifier, context); } });
    for (const s of ${JSON.stringify(runtime)}) await import(s);
    console.log(JSON.stringify([...seen]));`;
  const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
  assert.deepEqual(seen.filter((s) => !runtime.includes(s)), [], "bare specifiers resolved at import time, beyond the package's own entries");
  assert.deepEqual(seen.sort(), [...runtime].sort());
});

test("a part not built throws a typed error that names it", () => {
  assert.throws(() => notBuilt("the planner"), (error) => error instanceof NotBuiltError && error.code === "not_built" && error.part === "the planner" && /the planner is not built/.test(error.message));
});
