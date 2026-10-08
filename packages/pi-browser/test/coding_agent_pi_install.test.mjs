// What a pi user does: `pi install` the package and use it. The package is packed as it would be published, unpacked, and
// installed into a scratch home with pi's own CLI; a pi process started from that home then loads the extension through
// pi's loader and runs one of its tools. Local-directory installs do not resolve dependencies, so the package's
// `node_modules` is the repository's (the install through the registry needs a network and is run by hand).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
// The package's root is the directory above `dist/` of its main entry (its exports map has no `package.json` subpath and no `require` condition).
const piCli = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))), "dist", "bundle", "cli.js");

test("a packed tarball installs with pi into a scratch home, and a pi process loads its tools from it", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "pi-install-"));
  const [packs, home, agent, work] = ["packs", "home", "home/agent", "work"].map((d) => path.join(root, d));
  for (const dir of [packs, agent, work]) fs.mkdirSync(dir, { recursive: true });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packs], { cwd: pkgDir, encoding: "utf8", env: { ...process.env, npm_config_loglevel: "silent" } }));
  const names = packed[0].files.map((f) => f.path);
  assert.ok(names.includes("dist/coding-agent.js") && names.includes("LICENSE") && names.includes("NOTICE") && names.includes("README.md") && names.includes("CHANGELOG.md"), "the files a pi user needs are in the tarball");
  const outside = names.filter((n) => !n.startsWith("dist/") && !["package.json", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md", "src/vendor/stagehand-facade/UPSTREAM.json"].includes(n));
  assert.deepEqual(outside, [], "the tarball is dist, the licence files, the README, and the vendored facade's UPSTREAM.json: no sources, tests, fixtures or scratch");
  assert.ok(names.includes("src/vendor/stagehand-facade/UPSTREAM.json"), "the vendored facade's provenance travels with it");
  assert.deepEqual(names.filter((n) => n.endsWith(".map")), [], "no source maps: they point at sources the tarball does not carry");
  assert.ok(names.includes("dist/vendor/stagehand-facade/runtime.js"), "the vendored facade is in the tarball");
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", path.join(packs, packed[0].filename), "package/package.json"], { encoding: "utf8" }));
  assert.ok(manifest.keywords.includes("pi-package"), "eligible for the pi gallery");
  assert.deepEqual(manifest.pi, { extensions: ["./dist/coding-agent.js"] });
  assert.ok(!Object.keys(manifest.dependencies ?? {}).some((d) => d.startsWith("@earendil-works/pi-")), "pi's own packages are the host's, never bundled");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");

  const unpacked = path.join(root, "pkg");
  fs.mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", path.join(packs, packed[0].filename), "-C", unpacked, "--strip-components=1"]);
  await symlink(path.resolve(pkgDir, "..", "..", "node_modules"), path.join(unpacked, "node_modules"));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
  const install = spawnSync(process.execPath, [piCli, "install", unpacked], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8")).packages.map((p) => path.resolve(agent, p)), [unpacked]);
  const listed = spawnSync(process.execPath, [piCli, "list"], { env, encoding: "utf8", timeout: 60_000 });
  assert.match(listed.stdout, /pkg/);

  const child = spawnSync(process.execPath, [path.join(here, "coding-agent", "installed-child.mjs"), work, agent], { env: { ...env, TMPDIR: process.env.TMPDIR ?? os.tmpdir() }, encoding: "utf8", timeout: 120_000, cwd: pkgDir });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split("\n").at(-1));
  for (const tool of ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "web_fetch"]) assert.ok(out.tools.includes(tool), `${tool} is loaded from the installed package: ${out.tools.join(",")}`);
  assert.equal(out.results.length, 1);
  assert.deepEqual([out.results[0].tool, out.results[0].isError, JSON.parse(out.results[0].text)], ["browser_release", false, { ok: true, released: false, session_id: null, note: "no open browser session" }]);
  assert.deepEqual(out.errors, [], "pi reports no extension error");
});
