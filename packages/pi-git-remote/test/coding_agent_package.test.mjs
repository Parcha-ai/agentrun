import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGitRemoteExtension } from "../dist/coding-agent.js";
import * as coding from "../dist/coding-agent.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the manifest is a pi package with the coding-agent entry as a subpath and as pi's extension, and pi is an optional peer at *", () => {
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi, { extensions: ["./dist/coding-agent.js"] });
  assert.deepEqual(manifest.exports["./coding-agent"], { types: "./dist/coding-agent.d.ts", default: "./dist/coding-agent.js" });
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true);
  assert.ok(!Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith("@earendil-works/")), "pi's packages are the host's, never bundled");
});

test("the built entry imports nothing from pi, and the core entry does not know the adapter", async () => {
  const imports = (text) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const file of ["coding-agent.js", "coding-agent.d.ts", "session.js", "glob.js"]) {
    const specifiers = imports(await readFile(fileURLToPath(new URL(`../dist/${file}`, import.meta.url)), "utf8"));
    const outside = file === "coding-agent.d.ts" ? specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("node:") && s !== "@earendil-works/pi-coding-agent") : specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
    assert.deepEqual(outside, [], file);
  }
  assert.ok(!(await readFile(fileURLToPath(new URL("../dist/index.js", import.meta.url)), "utf8")).includes("coding-agent"));
});

test("the extension is a default export and a factory; it registers flags and four hooks and no tool, command or provider", () => {
  const seen = { flags: [], hooks: [], other: [] };
  const pi = new Proxy({}, {
    get: (_, name) => {
      if (name === "registerFlag") return (flag) => seen.flags.push(flag);
      if (name === "on") return (event) => { seen.hooks.push(event); return () => undefined; };
      return () => { seen.other.push(String(name)); };
    },
  });
  coding.default(pi);
  assert.deepEqual(seen.flags.sort(), ["git-allow", "git-branch", "git-checkout-dir", "git-ref", "git-remote"]);
  assert.deepEqual(seen.hooks.sort(), ["before_agent_start", "resources_discover", "session_shutdown", "session_start"]);
  assert.deepEqual(seen.other, []);
  assert.equal(typeof createGitRemoteExtension(), "function");
});
