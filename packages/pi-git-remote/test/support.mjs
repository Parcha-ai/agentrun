import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { local, openRepo } from "../dist/index.js";

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A fresh directory for one test, removed when the file's tests end. */
export async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-git-remote-"));
  await chmod(dir, 0o755);
  roots.push(dir);
  return dir;
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** A secret-shaped value made at test time; no test file holds one. */
export const makeSecret = () => `s${randomBytes(20).toString("hex")}`;

export const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Plain git with no system or global config and none of the package's hardening: for setup and for controls. */
export function rawGit(args, { cwd, gitDir, input } = {}) {
  return new Promise((resolve, reject) => {
    const home = cwd ?? tmpdir();
    const env = {
      PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "setup", GIT_AUTHOR_EMAIL: "setup@example.invalid", GIT_COMMITTER_NAME: "setup", GIT_COMMITTER_EMAIL: "setup@example.invalid",
      ...(gitDir ? { GIT_DIR: gitDir } : {}),
    };
    const child = spawn("git", args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(err)}`))));
    child.stdin.end(input ?? "");
  });
}

export async function bareRepo(dir) {
  await rawGit(["init", "-q", "--bare", "--template=", "-b", "main", dir]);
  return dir;
}

/** A bare remote whose main holds `files`, written by a seeding host through the package. */
export async function seededRemote(root, files = { "README.md": "seed\n" }) {
  const dir = await bareRepo(path.join(root, "remote.git"));
  const remote = local(dir);
  const seeder = await openRepo({ dir: path.join(root, "seeder"), remote });
  const { sha } = await seeder.commitTo("main", { files, message: "seed" });
  await seeder.push(sha, "main");
  return { dir, remote, seeder, main: sha };
}

export const refsOf = async (gitDir) =>
  Object.fromEntries((await rawGit(["for-each-ref", "--format=%(refname) %(objectname)"], { gitDir })).toString().split("\n").filter(Boolean).map((l) => l.split(" ")));

/** Every hook git runs in a repository a host writes to, and every hook a receiving repository runs. */
export const HOST_HOOKS = [
  "applypatch-msg", "commit-msg", "fsmonitor-watchman", "post-applypatch", "post-checkout", "post-commit", "post-index-change", "post-merge",
  "post-rewrite", "pre-applypatch", "pre-auto-gc", "pre-commit", "pre-merge-commit", "pre-push", "pre-rebase", "prepare-commit-msg",
  "reference-transaction",
];
export const REMOTE_HOOKS = ["pre-receive", "update", "post-receive", "post-update", "reference-transaction", "proc-receive", "push-to-checkout"];

export async function plantHooks(hooksDir, names, markers, prefix) {
  await mkdir(hooksDir, { recursive: true });
  for (const name of names) {
    const file = path.join(hooksDir, name);
    await writeFile(file, `#!/bin/sh\ntouch '${markers}/${prefix}-${name}'\n`);
    await chmod(file, 0o755);
  }
}

/** Every regular file under `dir` whose bytes contain `needle`. */
export async function filesContaining(dir, needle) {
  const hits = [];
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (await readFile(full)).includes(needle)) hits.push(full);
    }
  };
  await walk(dir);
  return hits;
}

/**
 * A git that records each call (argv, environment, a hash of what it inherited on fd 3) to `log`, then runs the real
 * git. Its https fetch and push never touch a network: they run the credential helper the way git does and record a
 * hash of what it printed. With `leak`, an https push fails and prints the credential on stderr, as a broken git might.
 * With `live`, they run the real git over the network instead, and `inject` is added to the environment of the real git
 * only (after the record is taken), such as the CA file for a test server's certificate.
 */
export async function recordingGit(root, { leak = false, live = false, inject = {} } = {}) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "git-calls.jsonl");
  const script = path.join(bin, "recording-git.cjs");
  await writeFile(script, `"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
let fd3 = null;
try { fs.fstatSync(3); fd3 = fs.readFileSync("/dev/fd/3"); } catch {}
let i = 0;
while (argv[i] === "-c") i += 2;
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const record = { argv, env: process.env, verb: argv[i], fd3: fd3 === null ? null : hash(fd3) };
const network = (argv[i] === "fetch" || argv[i] === "push") && argv.slice(i).some((a) => a.startsWith("https://"));
const helpers = [];
if (network) {
  for (let j = 0; j < i; j += 2) {
    const eq = argv[j + 1].indexOf("=");
    if (argv[j + 1].slice(0, eq) !== "credential.helper") continue;
    const value = argv[j + 1].slice(eq + 1);
    if (value === "") helpers.length = 0; else helpers.push(value);
  }
  record.helpers = helpers.length;
}
if (network && !${live}) {
  if (helpers.length) {
    const out = spawnSync("/bin/sh", ["-c", helpers[helpers.length - 1].slice(1) + " get"], { stdio: ["ignore", "pipe", "inherit", ...(fd3 === null ? [] : [3])] });
    record.helperOut = hash(out.stdout);
    ${leak ? 'if (argv[i] === "push") { fs.appendFileSync(' + JSON.stringify(log) + ', JSON.stringify(record) + "\\n"); process.stderr.write("fatal: could not push with " + out.stdout.toString()); process.exit(128); }' : ""}
  }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
const result = spawnSync(${JSON.stringify(REAL_GIT)}, argv, { env: { ...process.env, ...${JSON.stringify(inject)} }, stdio: ["inherit", "inherit", "inherit", ...(fd3 === null ? [] : [3])] });
process.exit(result.status ?? 1);
`);
  const git = path.join(bin, "git");
  await writeFile(git, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  await chmod(git, 0o755);
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { git, log, calls };
}
