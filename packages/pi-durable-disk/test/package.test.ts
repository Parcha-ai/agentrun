// The published shape: the build is plain JavaScript that finds its own CLI and wrapper, package.json points
// only into what is shipped, and `npm pack` carries no test, fixture, secret or machine path. No Archil, no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown> & {
  exports: Record<string, string | Record<string, string>>;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};
// Inside the package so the built copy resolves pi-durable and chord from the workspace's node_modules; `.tmp/` is ignored by git.
const BUILD_ROOT = join(ROOT, ".tmp", `package-test-${process.pid}`);
after(() => rmSync(BUILD_ROOT, { recursive: true, force: true }));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

test("package.json is publishable and points only into what it ships", () => {
  assert.equal(pkg.name, "@parcha/pi-durable-disk");
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  assert.equal(pkg.private, undefined, "a private package cannot be published");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.deepEqual(pkg.exports["."], { types: "./dist/index.d.ts", default: "./dist/index.js" });
  // Every entry points into the build (or at the wrapper and package.json), and a code entry names its declarations.
  for (const [key, target] of Object.entries(pkg.exports)) {
    const files = typeof target === "string" ? [target] : Object.values(target);
    for (const f of files) assert.match(f, /^\.\/(dist\/.+\.(js|d\.ts)|bin\/archil-scoped|package\.json)$/, `exports["${key}"] -> ${f}`);
    if (typeof target === "object") assert.match(target.types ?? "", /^\.\/dist\/.+\.d\.ts$/, `exports["${key}"] has types`);
  }
  assert.equal(pkg.scripts.prepack, "npm run build", "pack and publish build first");
  assert.equal((pkg as { sideEffects?: unknown }).sideEffects, false, "a bundler may drop the modules an app does not use");
  assert.ok("./lease" in pkg.exports, "the narrow lease entry");
  assert.equal(pkg.bin["pi-durable-disk"], "./dist/cli.js");
  for (const file of ["bin/archil-scoped", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]) {
    assert.ok(pkg.files.includes(file), `${file} is shipped`);
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
  }
  assert.ok(pkg.files.includes("dist"));
  assert.ok(!pkg.files.some((f) => /^(src|test|examples)\b/.test(f)), "no source or test is shipped");
  assert.equal(statSync(join(ROOT, "bin/archil-scoped")).mode & 0o100, 0o100, "the wrapper is executable");
  assert.ok(existsSync(join(ROOT, "scripts/rewrite-dts.mjs")));
});

test("the build is JavaScript with no .ts import left, and a built copy finds its own CLI and wrapper", async () => {
  const dist = join(BUILD_ROOT, "dist");
  mkdirSync(join(BUILD_ROOT, "bin"), { recursive: true });
  cpSync(join(ROOT, "bin/archil-scoped"), join(BUILD_ROOT, "bin/archil-scoped"));
  writeFileSync(join(BUILD_ROOT, "package.json"), JSON.stringify({ type: "module" }));
  const tsc = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.build.json"), "--outDir", dist], { cwd: ROOT, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  const rewrite = spawnSync(process.execPath, [join(ROOT, "scripts/rewrite-dts.mjs"), dist], { encoding: "utf8" });
  assert.equal(rewrite.status, 0, rewrite.stderr);

  const emitted = [...walk(dist)].map((f) => relative(dist, f));
  for (const file of ["index.js", "index.d.ts", "cli.js", "hosts/local-host.js", "claim.js", "watchdog.js"]) assert.ok(emitted.includes(file), `${file} is emitted`);
  assert.ok(emitted.every((f) => /\.(js|d\.ts)$/.test(f)), `only .js and .d.ts: ${emitted.filter((f) => !/\.(js|d\.ts)$/.test(f))}`);
  const relativeTs = /(?:from|import\(|import)\s*["']\.{1,2}\/[^"']*\.ts["']/;
  for (const file of emitted) assert.ok(!relativeTs.test(readFileSync(join(dist, file), "utf8")), `${file} still imports a .ts file`);
  assert.equal(readFileSync(join(dist, "cli.js"), "utf8").split("\n")[0], "#!/usr/bin/env node", "the bin keeps its shebang");

  // The built local driver starts the built CLI, and the built claim names the shipped wrapper.
  const { ARCHIL_SCOPED } = (await import(pathToFileURL(join(dist, "claim.js")).href)) as typeof import("../src/claim.ts");
  const { localHost } = (await import(pathToFileURL(join(dist, "hosts/local-host.js")).href)) as typeof import("../src/hosts/local-host.ts");
  assert.equal(ARCHIL_SCOPED, join(BUILD_ROOT, "bin/archil-scoped"));
  assert.ok(existsSync(ARCHIL_SCOPED));
  const calls: string[][] = [];
  const host = localHost({ user: "1000", group: "1000", mountRoot: join(BUILD_ROOT, "mnt"), exec: async (argv) => (calls.push(argv), { code: 0, timedOut: false, stdout: "", stderr: "" }) });
  await host.start({ disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" }, "tok");
  const argv = calls.find((a) => a.includes("--"))!;
  const cli = argv[argv.indexOf("--") + 2];
  assert.equal(cli, join(dist, "cli.js"), "the unit runs the built CLI, not a .ts file that does not exist");
  assert.ok(existsSync(cli));
});

test("npm pack carries the build, the wrapper, the README and the licence, and nothing machine-specific", { skip: !existsSync(join(ROOT, "dist/index.js")) && "run `npm run build` first" }, () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [{ files }] = JSON.parse(r.stdout) as [{ files: { path: string }[] }];
  const paths = files.map((f) => f.path);
  const allowed = [/^dist\/.+\.(js|d\.ts)$/, /^bin\/archil-scoped$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/, /^NOTICE$/, /^package\.json$/];
  assert.deepEqual(paths.filter((p) => !allowed.some((re) => re.test(p))), [], "every packed file is on the allowlist");
  for (const must of ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "bin/archil-scoped", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "package.json"]) assert.ok(paths.includes(must), `${must} is packed`);
  const targets = Object.values(pkg.exports).flatMap((t) => (typeof t === "string" ? [t] : Object.values(t))).concat(Object.values(pkg.bin), String(pkg.types));
  for (const t of targets) assert.ok(paths.includes(t.replace(/^\.\//, "")), `${t} is named by package.json and packed`);
  assert.deepEqual(paths.filter((p) => /(^|\/)\.env/.test(p)), [], "no .env file");
  // A home directory of any user, a Mac user directory, a private key.
  const machineSpecific = /\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z]|BEGIN [A-Z ]*PRIVATE KEY/;
  for (const p of paths) assert.ok(!machineSpecific.test(readFileSync(join(ROOT, p), "utf8")), `${p} names a machine path, a key or a secret`);
});
