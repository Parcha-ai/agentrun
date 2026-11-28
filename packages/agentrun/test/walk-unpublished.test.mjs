import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSteps, consoleProblem, manifestOf, pointAt, repack, rowWords, unpublished, workspaces } from "./walk-unpublished.mjs";

const ws = (name, version, dependencies = {}) => ({ dir: `/repo/packages/${name.split("/")[1]}`, manifest: { name, version, dependencies } });
const LOCAL = {
  "@parcha/agentrun-serve": ws("@parcha/agentrun-serve", "0.1.0-beta.68", { "@parcha/agentrun-dsl": "0.1.0-beta.68", "@parcha/agentrun-kernel": "0.1.0-beta.68", "hono": "4.0.0" }),
  "@parcha/agentrun-dsl": ws("@parcha/agentrun-dsl", "0.1.0-beta.68", { "@parcha/agentrun-kernel": "0.1.0-beta.68" }),
  "@parcha/agentrun-kernel": ws("@parcha/agentrun-kernel", "0.1.0-beta.68"),
};
const LAUNCHER = { name: "@parcha/agentrun", version: "0.4.36", dependencies: { "@earendil-works/pi-ai": "1.5.2", "@parcha/agentrun-serve": "0.1.0-beta.68" } };
const nothingOnNpm = async () => false;

test("the packages npm lacks: the launcher's server and, through it, each @parcha package it pins that npm lacks too, once each", async () => {
  const need = await unpublished(LAUNCHER, LOCAL, nothingOnNpm);
  assert.deepEqual(need.map((p) => `${p.name}@${p.version}`), ["@parcha/agentrun-serve@0.1.0-beta.68", "@parcha/agentrun-dsl@0.1.0-beta.68", "@parcha/agentrun-kernel@0.1.0-beta.68"]);
  assert.equal(need[0].dir, "/repo/packages/agentrun-serve");
});

test("a package npm has is not packed, and its own dependencies come from npm with it", async () => {
  const asked = [];
  const has = async (name, version) => (asked.push(`${name}@${version}`), name === "@parcha/agentrun-serve");
  assert.deepEqual(await unpublished(LAUNCHER, LOCAL, has), []);
  assert.deepEqual(asked, ["@parcha/agentrun-serve@0.1.0-beta.68"], "only @parcha packages are asked about, and nothing below one npm has");
  const dslPublished = async (name) => name !== "@parcha/agentrun-serve";
  assert.deepEqual((await unpublished(LAUNCHER, LOCAL, dslPublished)).map((p) => p.name), ["@parcha/agentrun-serve"]);
});

test("npm lacking a package this checkout has at another version, or not at all, stops the plan in words", async () => {
  const older = { ...LOCAL, "@parcha/agentrun-serve": ws("@parcha/agentrun-serve", "0.1.0-beta.69") };
  await assert.rejects(unpublished(LAUNCHER, older, nothingOnNpm), /npm has no @parcha\/agentrun-serve@0\.1\.0-beta\.68, and the workspace here is @parcha\/agentrun-serve@0\.1\.0-beta\.69/);
  await assert.rejects(unpublished(LAUNCHER, {}, nothingOnNpm), /npm has no @parcha\/agentrun-serve@0\.1\.0-beta\.68, and no workspace here is @parcha\/agentrun-serve/);
});

test("pointAt moves only the packed packages' dependencies to their tarballs, and leaves the manifest it was given", () => {
  const packed = { "@parcha/agentrun-serve": "file:/tmp/launcher/parcha-agentrun-serve-0.1.0-beta.68.tgz" };
  const pointed = pointAt(LAUNCHER, packed);
  assert.deepEqual(pointed.dependencies, { "@earendil-works/pi-ai": "1.5.2", "@parcha/agentrun-serve": packed["@parcha/agentrun-serve"] });
  assert.equal(LAUNCHER.dependencies["@parcha/agentrun-serve"], "0.1.0-beta.68");
  assert.deepEqual(pointAt({ name: "x", optionalDependencies: { "@parcha/agentrun-serve": "0.1.0-beta.68" } }, packed).optionalDependencies, packed);
});

test("the row's words name what npm lacks and every package walked from this checkout", async () => {
  const need = await unpublished(LAUNCHER, LOCAL, nothingOnNpm);
  assert.equal(rowWords(need), "npm has no @parcha/agentrun-serve@0.1.0-beta.68 yet: walked with this checkout's packed @parcha/agentrun-serve, @parcha/agentrun-dsl, @parcha/agentrun-kernel (3 packages), not npm's");
  assert.equal(rowWords(need.slice(0, 1)), "npm has no @parcha/agentrun-serve@0.1.0-beta.68 yet: walked with this checkout's packed @parcha/agentrun-serve, not npm's");
});

test("repack writes a tarball again with the new package.json and every other file as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "walk-unpublished-test-"));
  mkdirSync(join(dir, "package", "bin"), { recursive: true });
  writeFileSync(join(dir, "package", "package.json"), JSON.stringify(LAUNCHER));
  writeFileSync(join(dir, "package", "bin", "agentrun.mjs"), "#!/usr/bin/env node\n");
  const tgz = join(dir, "launcher.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", dir, "package"]);
  assert.deepEqual(manifestOf(tgz), LAUNCHER);
  repack(tgz, pointAt(LAUNCHER, { "@parcha/agentrun-serve": "file:/tmp/launcher/serve.tgz" }));
  assert.equal(manifestOf(tgz).dependencies["@parcha/agentrun-serve"], "file:/tmp/launcher/serve.tgz");
  assert.equal(execFileSync("tar", ["-xzOf", tgz, "package/bin/agentrun.mjs"], { encoding: "utf8" }), "#!/usr/bin/env node\n");
});

test("a fresh checkout builds the console before the server, since the server's build copies it in; then those packages", async () => {
  const need = await unpublished(LAUNCHER, LOCAL, nothingOnNpm);
  assert.deepEqual(buildSteps(need), [
    ["node", ["scripts/build-console.mjs"]],
    ["node", ["scripts/build-workspaces.mjs", "--only", "@parcha/agentrun-serve,@parcha/agentrun-dsl,@parcha/agentrun-kernel"]],
  ]);
  const dslOnly = need.filter((p) => p.name !== "@parcha/agentrun-serve");
  assert.deepEqual(buildSteps(dslOnly), [["node", ["scripts/build-workspaces.mjs", "--only", "@parcha/agentrun-dsl,@parcha/agentrun-kernel"]]], "no server, no console");
  assert.deepEqual(buildSteps([]), []);
});

test("a packed server with no console is refused: the walk's served name must open the console, not a 404", () => {
  const dir = mkdtempSync(join(tmpdir(), "walk-unpublished-console-"));
  const pack = (name, files) => {
    const at = join(dir, name);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(at, "package", file, ".."), { recursive: true });
      writeFileSync(join(at, "package", file), text);
    }
    execFileSync("tar", ["-czf", join(dir, `${name}.tgz`), "-C", at, "package"]);
    return join(dir, `${name}.tgz`);
  };
  const withConsole = pack("served", { "package.json": "{}", "dist/console/index.html": "<html>" });
  const without = pack("bare", { "package.json": "{}", "dist/cli.js": "" });
  assert.equal(consoleProblem(withConsole), undefined);
  assert.match(consoleProblem(without), /bare\.tgz has no dist\/console\/index\.html: the console was not built before the server \(scripts\/build-console\.mjs\)/);
});

test("the workspaces here: each package under packages/ by name, the launcher and the server among them", () => {
  const local = workspaces();
  assert.equal(local["@parcha/agentrun"].manifest.name, "@parcha/agentrun");
  assert.match(local["@parcha/agentrun-serve"].dir, /packages\/serve$/);
});
