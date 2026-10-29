// The image ships no coding-agent CLI whose licence has not been reviewed, and the Codex CLI it does ship is the pinned
// build: docker/image-check.sh refuses a tree that holds the Claude Agent SDK (or a platform package of it) or the Claude
// CLI, at the top or nested, and a tree whose Codex CLI is missing or is not the build @parcha/agentrun-codex is pinned to.
// The Dockerfile removes the Claude packages after the build and runs the check on the final image's tree.
//
// A tree's Codex is the adapter's built dist and the pinned binary of this machine's platform (a link to the installed
// one). Without that binary the Codex cases skip; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) they fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codexTarget, findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";

const CHECK = fileURLToPath(new URL("../docker/image-check.sh", import.meta.url));
const DOCKERFILE = new URL("../docker/Dockerfile", import.meta.url);
const CODEX_PACKAGE = fileURLToPath(new URL("../../run-adapters-codex/", import.meta.url));

const installed = findCodex();
const verified = verifyCodexBinary(installed);
const skip = verified instanceof Error && env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? verified.message : false;
const target = codexTarget();

// The check runs from the tree's own directory and drops CODEX_BIN itself, so only the tree's Codex can answer (a test
// below sets it to prove that).
const check = (root, extra = {}) => spawnSync("sh", [CHECK, root], { cwd: dirname(root), env: { ...env, ...extra }, encoding: "utf8" });

/** Lays the adapter (its package.json and built dist), the launcher and this platform's package into `root`, the way npm
 *  does. `binary` is what sits at the platform package's binary path: the installed pinned one (a link), a script, or
 *  nothing. */
async function codexInto(root, { binary = "pinned", platformVersion } = {}) {
  const adapter = join(root, "node_modules/@parcha/agentrun-codex");
  await mkdir(adapter, { recursive: true });
  await cp(join(CODEX_PACKAGE, "package.json"), join(adapter, "package.json"));
  await cp(join(CODEX_PACKAGE, "dist"), join(adapter, "dist"), { recursive: true });
  const launcher = join(root, "node_modules/@openai/codex");
  await mkdir(launcher, { recursive: true });
  await writeFile(join(launcher, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.164.0" }));
  if (!target) return;
  const platform = join(root, `node_modules/@openai/codex-${target.pkg}`);
  await mkdir(platform, { recursive: true });
  await writeFile(join(platform, "package.json"), JSON.stringify({ name: "@openai/codex", version: platformVersion ?? `0.164.0-${target.pkg}` }));
  const bin = join(platform, "vendor", target.target, "bin", "codex");
  if (binary === "none") return;
  await mkdir(dirname(bin), { recursive: true });
  if (binary === "pinned") await symlink(installed.path, bin);
  else {
    await writeFile(bin, binary);
    await chmod(bin, 0o755);
  }
}

const tree = async (t, files, links = {}, codex = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-image-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "opt");
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "{}");
  }
  for (const [link, target] of Object.entries(links)) {
    await mkdir(dirname(join(root, link)), { recursive: true });
    await symlink(target, join(root, link));
  }
  if (codex && installed) await codexInto(root, codex);
  return root;
};

// The packages an image legitimately carries, next to the names the check refuses.
const kept = ["node_modules/@anthropic-ai/sdk/package.json", "node_modules/@openai/other/package.json", "node_modules/@parcha/agentrun-serve/package.json", "node_modules/.bin/agentrun-serve"];

test("a tree with none of the held-back CLIs and the pinned Codex passes the image check", { skip }, async (t) => {
  const result = check(await tree(t, kept));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no Claude Agent SDK or Claude CLI/);
  assert.match(result.stdout, /Codex 0\.164\.0 .* is the pinned build/);
});

// Each case: what the tree holds beside the kept packages, and the path the check names (where it prunes).
for (const [what, file, named] of [
  ["the Claude Agent SDK", "node_modules/@anthropic-ai/claude-agent-sdk/package.json", "node_modules/@anthropic-ai/claude-agent-sdk"],
  ["a platform package of the SDK, which holds the Claude CLI", "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json", "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"],
  ["the Claude CLI package", "node_modules/@anthropic-ai/claude-code/package.json", "node_modules/@anthropic-ai/claude-code"],
  ["a copy nested under a workspace package", "packages/run-adapters-claude-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json", "packages/run-adapters-claude-agent/node_modules/@anthropic-ai/claude-agent-sdk"],
]) {
  test(`the image check refuses ${what}, and names it`, async (t) => {
    const root = await tree(t, [...kept, file]);
    const result = check(root);
    assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}`);
    assert.ok(result.stderr.split("\n").includes(join(root, named)), `stderr names ${named}: ${result.stderr}`);
  });
}

test("the image check refuses a bin link left behind, even a dangling one", async (t) => {
  const root = await tree(t, kept, { "node_modules/.bin/claude": "../@anthropic-ai/claude-code/cli.js" });
  const result = check(root);
  assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}`);
  assert.ok(result.stderr.split("\n").includes(join(root, "node_modules/.bin/claude")), `stderr names the link: ${result.stderr}`);
});

// The Codex CLI (Apache-2.0) is not held back: it ships with its adapter, from the lock, and must be the pinned build.
test("the image check passes a tree that holds the Codex CLI and its bin link", { skip }, async (t) => {
  const root = await tree(t, kept, { "node_modules/.bin/codex": "../@openai/codex/bin/codex.js" });
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

// Each case: how the tree's Codex differs from the pinned build, and the typed error (and pin) the check prints.
for (const [what, codex, named] of [
  ["the platform package without its binary", { binary: "none" }, /CodexNotInstalled \(CODEX_NOT_INSTALLED\)/],
  ["a different binary in its place", { binary: "#!/bin/sh\necho codex-cli 0.164.0\n" }, /CodexPinMismatch \(CODEX_PIN_MISMATCH, binary_sha256\)/],
  ["the platform package of another release", { platformVersion: `0.165.0-${target?.pkg}` }, /CodexPinMismatch \(CODEX_PIN_MISMATCH, package_version\)/],
]) {
  test(`the image check refuses a tree whose Codex is ${what}, and names the error`, { skip }, async (t) => {
    const result = check(await tree(t, kept, {}, codex));
    assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, named);
  });
}

test("the image check accepts a tree given as a path relative to its working directory", { skip }, async (t) => {
  const root = await tree(t, kept);
  const result = spawnSync("sh", [CHECK, basename(root)], { cwd: dirname(root), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex 0\.164\.0 .* is the pinned build/);
});

// A CODEX_BIN the build inherits (or an operator sets) that names the pinned binary elsewhere must not stand in for the
// tree's own: the tree's wrong Codex is still refused.
test("the image check refuses a tree's wrong Codex even when CODEX_BIN names the pinned binary elsewhere", { skip }, async (t) => {
  const result = check(await tree(t, kept, {}, { binary: "#!/bin/sh\necho codex-cli 0.164.0\n" }), { CODEX_BIN: installed?.path });
  assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /CodexPinMismatch \(CODEX_PIN_MISMATCH, binary_sha256\)/);
});

test("the image check refuses a tree without the Codex adapter to check its CLI with", async (t) => {
  const result = check(await tree(t, kept, {}, null));
  assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /no @parcha\/agentrun-codex/);
});

test("the Dockerfile removes the CLIs after the build and runs the check on the final image's tree", async () => {
  const dockerfile = await readFile(DOCKERFILE, "utf8");
  const [build, final] = dockerfile.split(/^FROM /m).slice(1);
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-*", "@anthropic-ai/claude-code", ".bin/claude"])
    assert.ok(build.includes(` node_modules/${name} `) || build.includes(` node_modules/${name} \\`), `the build stage removes node_modules/${name}`);
  assert.ok(!/@openai\/codex|\.bin\/codex/.test(build), "the build stage leaves the Codex CLI alone");
  const copy = final.indexOf("COPY --from=build");
  const run = final.indexOf("RUN sh /opt/agentrun/packages/serve/docker/image-check.sh /opt/agentrun");
  assert.ok(copy >= 0 && run > copy, "the final stage runs the image check after it copies the build");
  assert.ok(run < final.indexOf("USER node"), "the check runs before the image drops to the node user");
});
