// A fake npm registry on loopback for the first-use installs (harness-install.ts): packages built here as tarballs, served
// with their packuments, and the lock of an install as AgentRun ships one (npm's own, made against this registry before
// any test request). No test reaches npm's real registry.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { scratch } from "./support.mjs";

/** A gzipped npm tarball of `files` (path → text, or `{ link }` to a file put in whole) under `dir`, and its integrity. */
export function npmTarball(dir, name, files) {
  const root = join(dir, name.replaceAll("/", "+"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "package", path)), { recursive: true });
    if (typeof text === "string") writeFileSync(join(root, "package", path), text, { mode: path.includes("bin/") ? 0o755 : 0o644 });
    else symlinkSync(text.link, join(root, "package", path));
  }
  const file = `${root}.tgz`;
  // -h puts a linked file in whole; gzip -1 for a large one.
  execFileSync("sh", ["-c", 'tar -chf - -C "$1" package | gzip -1 > "$2"', "sh", root, file]);
  return { file, integrity: `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}` };
}

/**
 * A registry on loopback, on a port below the ephemeral range that it binds (so it was free), serving `packages`
 * (`{ [name]: { versions: { [version]: { manifest, file, integrity } }, latest?, hidden?: [version] } }`), and the lock
 * of an install of `root` (dependencies, as AgentRun's package.json names them) made by npm against it before any test's
 * request. `hits` lists every path asked after the lock; `hold(name)` holds that package's tarballs until `release()`;
 * `answer({ missing, publish })`: 404 for everything, or a hidden version published (the registry's latest) once the
 * lock is made.
 */
export async function fakeNpmRegistry(t, packages, root) {
  const hits = [];
  const held = new Map();
  const mode = { missing: false, publish: undefined };
  let ready = false;
  const server = createServer(async (req, res) => {
    hits.push(req.url);
    const path = decodeURIComponent(req.url.split("?")[0]).slice(1);
    const tgz = /^-\/(.+)\/([^/]+)\.tgz$/.exec(path);
    const gone = ready && mode.missing;
    const entry = tgz && packages[tgz[1]]?.versions[tgz[2]];
    if (!gone && entry && existsSync(entry.file)) {
      if (held.has(tgz[1])) await held.get(tgz[1]).promise;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(entry.file));
    }
    const pkg = !gone && !tgz ? packages[path] : undefined;
    if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    const shown = Object.entries(pkg.versions).filter(([version]) => !(pkg.hidden ?? []).includes(version) || (ready && mode.publish === `${path}@${version}`));
    const versions = Object.fromEntries(shown.map(([version, { manifest, integrity }]) => [version, { ...manifest, dist: { tarball: `${url}/-/${path}/${version}.tgz`, integrity } }]));
    const published = ready && mode.publish?.startsWith(`${path}@`) ? mode.publish.slice(path.length + 1) : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: path, "dist-tags": { latest: published ?? pkg.latest ?? shown[0][0] }, versions }));
  });
  let port;
  for (let tries = 0; ; tries++) {
    port = 20000 + Math.floor(Math.random() * 12000);
    const bound = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) break;
    assert.ok(tries < 50, "a free port below 32768 for the fake registry");
  }
  const url = `http://127.0.0.1:${port}`;
  t.after(() => {
    for (const { resolve } of held.values()) resolve();
    return new Promise((resolve) => server.close(resolve));
  });
  const dir = await scratch(t);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "agentrun-harness", private: true, dependencies: root }, null, 2)}\n`);
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));
  await new Promise((resolve, reject) => execFile("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${url}/`, `--cache=${join(dir, "cache")}`], { cwd: dir, env: npmEnv }, (error, stdout, stderr) => (error ? reject(new Error(`the lock: ${stderr}`)) : resolve())));
  hits.length = 0;
  ready = true;
  return {
    url,
    hits,
    lock: join(dir, "package-lock.json"),
    tarballs: (name) => hits.filter((hit) => decodeURIComponent(hit).startsWith(`/-/${name}/`)),
    hold: (name) => void held.set(name, Promise.withResolvers()),
    release: (name) => held.get(name)?.resolve(),
    answer: (changes) => void Object.assign(mode, { missing: false, publish: undefined }, changes),
  };
}

/** npm's settings for test `t`'s server, in both spellings (npm reads either, the uppercase one winning): `registry`, a
 *  cache of the test's own, no retries. Put back after the test. */
export async function npmOn(t, registry, more = {}) {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^npm_config_/i.test(name)));
  t.after(() => {
    for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) delete process.env[name];
  const settings = { registry: `${registry.url}/`, cache: join(await scratch(t), "npm-cache"), fetch_retries: "0", update_notifier: "false", ...more };
  for (const [name, value] of Object.entries(settings)) Object.assign(process.env, { [`npm_config_${name}`]: value, [`NPM_CONFIG_${name.toUpperCase()}`]: value });
}

/** `check()`'s first truthy answer, within `ms`; else the assertion `what` fails. */
export async function until(what, check, ms = 120_000) {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, what);
  }
}

/** This test's descendant processes. */
export async function descendants() {
  const out = [];
  const queue = [process.pid];
  while (queue.length) {
    const pid = queue.shift();
    for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(() => "")).split(" ").filter(Boolean)) {
        out.push(Number(child));
        queue.push(Number(child));
      }
    }
  }
  return out;
}
