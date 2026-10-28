// What the image's build sees: the repository's .dockerignore over a context with a file of every kind, copied by
// BuildKit as the Dockerfile's `COPY . .` copies it. A secret (.env, .env.*, .npmrc) stays out wherever it is, and so do
// installed dependencies and build output. Skipped where Docker's buildx is missing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const buildx = spawnSync("docker", ["buildx", "version"], { stdio: "ignore" }).status === 0;

test("the image's build context holds the workspace and never a .env, an .npmrc, node_modules or dist", { skip: !buildx && "docker buildx is not installed", timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const context = join(dir, "context");
  const kept = ["package.json", "package-lock.json", "tsconfig.base.json", "packages/serve/src/server.ts", "packages/serve/docker/Dockerfile", "scripts/build-pi-demo.mjs", "examples/typed-research.ts", "examples/typed-research-fixtures.ts", "examples/agentrun-server/showcase.mjs", "examples/agentrun-server/showcase.json"];
  const dropped = [
    ".env", ".env.local", ".env.production", ".npmrc",
    "packages/serve/.env", "packages/serve/.env.test", "packages/serve/.npmrc", "packages/serve/src/.env",
    "scripts/.env", "examples/.env", "examples/agentrun-server/.env",
    "node_modules/zod/index.js", "packages/serve/node_modules/x/index.js", "packages/serve/dist/cli.js", "packages/serve/tsconfig.tsbuildinfo",
    ".git/config", "docs/releasing.md", "examples/starter/index.ts", "render.yaml", "changes/x.md",
  ];
  for (const path of [...kept, ...dropped]) {
    await mkdir(dirname(join(context, path)), { recursive: true });
    await writeFile(join(context, path), path.includes(".env") || path.endsWith(".npmrc") ? "SECRET=planted\n" : "x\n");
  }
  await copyFile(join(ROOT, ".dockerignore"), join(context, ".dockerignore"));
  // The Dockerfile sits outside the context, so the context's own .dockerignore is the one BuildKit reads.
  await writeFile(join(dir, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  const out = join(dir, "out");
  execFileSync("docker", ["buildx", "build", "--quiet", "--file", join(dir, "Dockerfile"), "--output", `type=local,dest=${out}`, context], { stdio: ["ignore", "ignore", "pipe"] });
  for (const path of kept) assert.ok(existsSync(join(out, path)), `${path} is in the context`);
  for (const path of dropped) assert.equal(existsSync(join(out, path)), false, `${path} is not in the context`);
});
