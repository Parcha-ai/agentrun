// The image ships no coding-agent CLI whose licence has not been reviewed: docker/image-check.sh refuses a tree that holds
// the Claude Agent SDK (or a platform package of it), the Claude CLI or the Codex CLI, at the top or nested, and the
// Dockerfile removes them after the build and runs the check on the final image's tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../docker/image-check.sh", import.meta.url));
const DOCKERFILE = new URL("../docker/Dockerfile", import.meta.url);

const check = (root) => spawnSync("sh", [CHECK, root], { encoding: "utf8" });
const tree = async (t, files, links = {}) => {
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
  return root;
};

// The packages an image legitimately carries, next to the names the check refuses.
const kept = ["node_modules/@anthropic-ai/sdk/package.json", "node_modules/@openai/other/package.json", "node_modules/@parcha/agentrun-serve/package.json", "node_modules/.bin/agentrun-serve"];

test("a tree with none of the CLIs passes the image check", async (t) => {
  const result = check(await tree(t, kept));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no Claude Agent SDK or Claude CLI/);
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

// The Codex CLI (Apache-2.0) is not held back: it ships with its adapter, from the lock.
test("the image check passes a tree that holds the Codex CLI", async (t) => {
  const root = await tree(t, [...kept, "node_modules/@openai/codex/package.json", "node_modules/@openai/codex-linux-x64/package.json"], { "node_modules/.bin/codex": "../@openai/codex/bin/codex.js" });
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
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
