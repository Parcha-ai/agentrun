// What the image's build sees: the repository's .dockerignore over a context with a file of every kind, copied by
// BuildKit as the Dockerfile's `COPY . .` copies it. A secret (.env, .env.*, .npmrc) stays out wherever it is, and so do
// installed dependencies and build output. Skipped where Docker's buildx is missing. And what the image is built from.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const buildx = spawnSync("docker", ["buildx", "version"], { stdio: "ignore" }).status === 0;

test("the image's build context holds the workspace and the console's sources, and never a .env, an .npmrc, node_modules or dist", { skip: !buildx && "docker buildx is not installed", timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const context = join(dir, "context");
  const kept = ["package.json", "package-lock.json", "tsconfig.base.json", "packages/serve/src/server.ts", "packages/serve/docker/Dockerfile", "scripts/build-pi-demo.mjs", "examples/typed-research.ts", "examples/typed-research-fixtures.ts", "apps/console/package.json", "apps/console/package-lock.json", "apps/console/index.html", "apps/console/src/main.tsx"];
  const dropped = [
    ".env", ".env.local", ".env.production", ".npmrc",
    "packages/serve/.env", "packages/serve/.env.test", "packages/serve/.npmrc", "packages/serve/src/.env",
    "scripts/.env", "examples/.env", "apps/console/.env",
    "node_modules/zod/index.js", "packages/serve/node_modules/x/index.js", "packages/serve/dist/cli.js", "packages/serve/tsconfig.tsbuildinfo",
    "apps/console/node_modules/vite/index.js", "apps/console/dist/index.html", "apps/viewer/index.html",
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

test("both stages build on one digest-pinned node:22 trixie base, and the runtime has git 2.40 or newer", async () => {
  const dockerfile = await readFile(join(ROOT, "packages/serve/docker/Dockerfile"), "utf8");
  const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(([, image]) => image);
  assert.equal(bases.length, 2, "a build stage and a runtime stage");
  assert.match(bases[0], /^node:22\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64}$/, "pinned by digest");
  assert.equal(bases[1], bases[0], "one base for both stages");
  // pi-git-remote needs git 2.40; trixie's is 2.47, bookworm's 2.39.
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const install = /apt-get install [^\n]*/.exec(runtime)?.[0] ?? "";
  assert.match(install, /--no-install-recommends/, "without recommends");
  for (const pkg of ["tini", "git"]) assert.match(install, new RegExp(`\\s${pkg}(\\s|$)`), `the runtime installs ${pkg}`);
  // The RUN that reads git's version, continuation lines included, fails the build below 2.40.
  const guard = [...runtime.matchAll(/^RUN (?:[^\n]*\\\n)*[^\n]*/gm)].map(([run]) => run).find((run) => run.includes("git --version")) ?? "";
  assert.match(guard, /dpkg --compare-versions "\$v" ge 2\.40\b/, "the build compares the git it installed with 2.40");
  assert.match(guard, /\|\| \{[^}]*\bexit 1; \}/, "an older git fails the build");
});

test("the build stage builds the console before the server, so the server's dist carries it, and keeps none of its sources", async () => {
  const dockerfile = await readFile(join(ROOT, "packages/serve/docker/Dockerfile"), "utf8");
  const build = dockerfile.slice(0, dockerfile.lastIndexOf("\nFROM "));
  const at = (text) => build.indexOf(text);
  const built = at("(cd apps/console && npm ci --ignore-scripts && npm run build)");
  assert.ok(built > at("npm ci --ignore-scripts") && built < at(" && npm run build &&"), "the console builds after the workspace's install and before its build");
  assert.ok(at("test -f packages/serve/dist/console/index.html") > at(" && npm run build &&"), "the build fails without the console in the server's dist");
  assert.ok(at("rm -rf apps") > at("test -f packages/serve/dist/console/index.html"), "the console's sources and dependencies leave the image");
});
