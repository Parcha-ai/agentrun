// A data directory from 0.1.0-beta.26 or earlier holds agent homes (`<data>/<agent>/agent.sqlite`), which this version's
// store does not read. The server refuses to start on one, naming the homes, rather than serve it as if it were empty.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
import { OLDEST_UPGRADED, openSqliteStore } from "../dist/store/sqlite/store.js";
import { client, FAUX, scratch, serve, startServe } from "./support.mjs";

/** The error startServe refused with, or null after closing the server it should not have started. */
const refusal = (options) => startServe(options).then(async (server) => (await server.close(), null), (error) => error);

const oldHome = async (data, id) => {
  await mkdir(join(data, id, "runs"), { recursive: true });
  await writeFile(join(data, id, "agent.sqlite"), "SQLite format 3\0");
};

test("a data directory with beta.26 agent homes is refused at start, each home named, nothing created", async (t) => {
  const data = join(await scratch(t), "agents");
  await oldHome(data, "old");
  await oldHome(data, "triage");
  const error = await refusal({ data, port: 0, faux: FAUX });
  assert.ok(error, "refused");
  assert.match(error.message, /holds an earlier version's data/);
  assert.ok(error.message.includes(join("old", "agent.sqlite")) && error.message.includes(join("triage", "agent.sqlite")), error.message);
  assert.match(error.message, /Keep this directory with the earlier version, or start this version on a new, empty directory/);
  assert.deepEqual((await readdir(data)).sort(), ["old", "triage"], "nothing is made beside the old homes: no store, no token");
});

test("a volume already started on this version starts again on its own data, and is refused once an old home is in it", async (t) => {
  const { api, data, close } = await serve(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "kept", name: "kept", instructions: "Answer." } })).status, 201);
  await close();
  assert.ok(existsSync(join(data, "store.sqlite")));
  const again = await startServe({ data, port: 0, faux: FAUX });
  let closing;
  const closeAgain = () => (closing ??= again.close());
  t.after(closeAgain);
  assert.deepEqual((await client(again.baseUrl, again.token)("GET", "/agents")).body.agents.map((a) => a.agent_id), ["kept"], "this version's volume is not refused");
  await closeAgain();
  await oldHome(data, "old");
  assert.match((await refusal({ data, port: 0, faux: FAUX }))?.message ?? "started", /holds an earlier version's data \(old\/agent\.sqlite\)/);
});

test("an old home under any name is refused: an agent named runs, a symlinked home, and a symlinked agent.sqlite", async (t) => {
  const root = await scratch(t);
  const named = join(root, "named");
  await oldHome(named, "runs");
  assert.match((await refusal({ data: named, port: 0, faux: FAUX }))?.message ?? "started", new RegExp(join("runs", "agent.sqlite").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const linked = join(root, "linked");
  await oldHome(join(root, "elsewhere"), "kept");
  await mkdir(linked, { recursive: true });
  await symlink(join(root, "elsewhere", "kept"), join(linked, "kept"));
  assert.match((await refusal({ data: linked, port: 0, faux: FAUX }))?.message ?? "started", /holds an earlier version's data/, "a symlinked home is refused too");
  const file = join(root, "file");
  await mkdir(join(file, "kept"), { recursive: true });
  await symlink(join(root, "elsewhere", "kept", "agent.sqlite"), join(file, "kept", "agent.sqlite"));
  assert.match((await refusal({ data: file, port: 0, faux: FAUX }))?.message ?? "started", /holds an earlier version's data/, "a symlinked agent.sqlite is refused too");
});

test("this version's own disk/ and a directory with no agent.sqlite start as before", async (t) => {
  const data = join(await scratch(t), "agents");
  await mkdir(join(data, "disk", "agents", "notes-0123456789abcdef", "runs", "01a1-example"), { recursive: true });
  await mkdir(join(data, "notes"), { recursive: true });
  const { api } = await serve(t, { data });
  assert.equal((await api("GET", "/agents")).status, 200);
});

test("the bin prints the refusal and exits 1", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  await oldHome(data, "old");
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: dirname(data) } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = child.exitCode ?? (await new Promise((resolve) => child.once("exit", resolve)));
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: .* holds an earlier version's data \(old\/agent\.sqlite\)/m);
});

/** The bin started on a data directory whose store says `version`: its stderr and exit code. */
const startOnStoreAt = async (t, version) => {
  const data = join(await scratch(t), "agents");
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  await store.close();
  const raw = new DatabaseSync(join(data, "store.sqlite"));
  raw.exec(`UPDATE store_meta SET schema_version = ${version}`);
  raw.close();
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: dirname(data) } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = child.exitCode ?? (await new Promise((resolve) => child.once("exit", resolve)));
  return { err, code };
};

// The versions from OLDEST_UPGRADED up to the one before this one are the ones a server upgrades in place
// (store-listing-upgrade.test.mjs, store-relay-upgrade.test.mjs, store-purge-upgrade.test.mjs, learn-per-disk.test.mjs,
// store-learning-ledger.test.mjs, store-schema-sqlite.test.mjs); the one before OLDEST_UPGRADED is refused.
test("the bin on a store an earlier release set up says what to do, once, with no stack, and exits 1", { timeout: 20_000 }, async (t) => {
  const { err, code } = await startOnStoreAt(t, OLDEST_UPGRADED - 1);
  assert.equal(code, 1, err);
  assert.match(err, new RegExp(`^agentrun-serve: the store at .*store\\.sqlite is schema version ${OLDEST_UPGRADED - 1}, and this release \\(version ${SCHEMA_VERSION}\\) can't open a store an earlier release set up\\.$`, "m"));
  assert.match(err, /--data <new folder>/);
  assert.match(err, /--data \/data\/<new folder> --listen 0\.0\.0\.0 --port 7340 --drain-timeout 6s/);
  assert.match(err, /\(docker run or compose arguments: --data/);
  assert.match(err, /^On Render the Docker Command replaces the image's entrypoint too, so it must be the whole start command shown in "Before you upgrade" in the release notes\.$/m);
  assert.match(err, /^Keep the old folder as it is: the earlier release still opens it\.$/m);
  assert.equal(err.match(/agentrun-serve:/g).length, 1, err);
  assert.doesNotMatch(err, /\n\s+at /);
});

test("the bin on a store a later release set up says to run that release, once, with no stack, and exits 1", { timeout: 20_000 }, async (t) => {
  const { err, code } = await startOnStoreAt(t, SCHEMA_VERSION + 1);
  assert.equal(code, 1, err);
  assert.match(err, new RegExp(`^agentrun-serve: the store at .*store\\.sqlite is schema version ${SCHEMA_VERSION + 1}, set up by a later release than this one \\(this release knows version ${SCHEMA_VERSION}\\)\\. Run that release or a later one\\.$`, "m"));
  assert.equal(err.match(/agentrun-serve:/g).length, 1, err);
  assert.doesNotMatch(err, /\n\s+at /);
});

/** The bin started as `npx @parcha/agentrun@0.4.22` starts it (the launcher names itself in AGENTRUN_NPX_PACKAGE), on
 *  `data`, on any free port and with no browser (a regression that starts the server then opens nothing on 7340): its
 *  stderr and exit code. A refusal's commands keep those flags (startedWith): ` --port 0 --no-open`. */
const startByLauncher = async (t, data, home = dirname(data), env = {}) => {
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--port", "0", "--data", data, "--faux", FAUX], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home, AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.4.22", AGENTRUN_SERVE_PORT: "", AGENTRUN_INSTALLED_COMMAND: "", npm_config_yes: "", ...env } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = child.exitCode ?? (await new Promise((resolve) => child.once("exit", resolve)));
  return { err, code };
};
const LAUNCHER = "npx @parcha/agentrun@0.4.22";
const FLAGS = " --port 0 --no-open";
/** The line of `err` that holds `words`, and the index of that line. */
const lineWith = (err, words) => {
  const lines = err.split("\n");
  const at = lines.findIndex((line) => line.includes(words));
  return { at, line: lines[at] ?? "" };
};

// A new folder is not a new AgentRun: `npx @parcha/agentrun` keeps its data in ~/.agentrun wherever it is run, so an
// earlier version's ~/.agentrun stops this one. The refusal gives the old folder moved aside whole, then the command the
// person ran on a new, empty folder (one not there yet); it never says to delete it.
test("started by npx @parcha/agentrun on an earlier version's data, the refusal names moving the old folder aside, then the command on a new folder", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  await mkdir(`${data}-new`, { recursive: true });
  await mkdir(`${data}-earlier`, { recursive: true });
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: .* holds an earlier version's data \(old\/agent\.sqlite\)/m);
  const aside = lineWith(err, `mv ${data} ${data}-earlier-2, then ${LAUNCHER}${FLAGS}.`);
  const fresh = lineWith(err, `${LAUNCHER} --data ${data}-new-2${FLAGS}`);
  assert.ok(aside.at > 0 && fresh.at > aside.at, `the old folder moved aside first, then a new folder:\n${err}`);
  assert.ok(aside.line.includes(`--data ${data}-earlier-2`), "the earlier version opens the folder moved aside");
  assert.doesNotMatch(err, /\bdelete\b|\brm\b/i, "it never says to delete the old folder");
  assert.equal(err.match(/add your agents/gi).length, 1, err);
  assert.ok(!existsSync(`${data}-new-2`) && !existsSync(`${data}-earlier-2`), "the refusal only names the folders");
  assert.equal(err.match(/agentrun-serve:/g).length, 1, err);
});

// install.sh keeps its Node, its packages and the command (bin/agentrun) in ~/.agentrun, beside the data, and the launcher
// says when that command started it (AGENTRUN_INSTALLED_COMMAND, the command's path). That command, or the service running
// it, has no npx at hand; moving the folder takes the command, and the service starts on the refused folder whatever a
// --data says, so the one way on is the installer run again for this same version, and the earlier version keeps a way
// back to the folder moved aside.
test("started by the installed agentrun in the old folder: the folder moved aside, then the installer for this version, and no npx command", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  await mkdir(join(data, "bin"), { recursive: true });
  await writeFile(join(data, "bin", "agentrun"), "#!/bin/sh\n");
  const { err, code } = await startByLauncher(t, data, dirname(data), { AGENTRUN_INSTALLED_COMMAND: join(data, "bin", "agentrun") });
  assert.equal(code, 1, err);
  const again = lineWith(err, `mv ${data} ${data}-earlier, then run the installer again for this version: curl -fsSL https://agentrun.ai/install | sh -s -- --version 0.4.22.`);
  assert.ok(again.at > 0, err);
  assert.ok(lineWith(err, `The earlier version opens the old data with --data ${data}-earlier.`).at > again.at, err);
  assert.doesNotMatch(err, /\bnpx\b/, err);
});

// What started this server decides, never what the folder holds: a stale bin/agentrun left in a folder by an earlier
// install says nothing about an npx start.
test("started by npx on a folder that still holds an earlier install's bin/agentrun, the folder moved aside starts again with the npx command", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  await mkdir(join(data, "bin"), { recursive: true });
  await writeFile(join(data, "bin", "agentrun"), "#!/bin/sh\n");
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.ok(lineWith(err, `mv ${data} ${data}-earlier, then ${LAUNCHER}${FLAGS}.`).at > 0, err);
  assert.doesNotMatch(err, /installer/, err);
});

// The installed command on a --data of the person's own: moving that folder leaves the installer where it is, so the
// installed command starts again on it. Its login shell has the command's folder on PATH (the installer adds it), never
// the installer's Node, so the line names that command, never npx: by name when it is the agentrun their PATH runs, else
// by path, so a paste never starts another install's copy found earlier on PATH.
test("started by the installed agentrun on a --data of the person's own, the folder moved aside starts again with that command, not npx", { timeout: 20_000 }, async (t) => {
  const root = await scratch(t);
  const data = join(root, "srv", "agents");
  await oldHome(data, "old");
  const command = join(root, "home", ".agentrun", "bin", "agentrun");
  const other = join(root, "opt", "bin", "agentrun");
  for (const one of [command, other]) {
    await mkdir(dirname(one), { recursive: true });
    await writeFile(one, "#!/bin/sh\n", { mode: 0o755 });
  }
  const installed = { AGENTRUN_INSTALLED_COMMAND: command, PATH: dirname(process.execPath) };
  const byPath = await startByLauncher(t, data, join(root, "home"), installed);
  assert.equal(byPath.code, 1, byPath.err);
  assert.ok(lineWith(byPath.err, `mv ${data} ${data}-earlier, then ${command} --data ${data}${FLAGS}.`).at > 0, byPath.err);
  assert.ok(lineWith(byPath.err, `Or start this version on a new, empty folder: ${command} --data ${data}-new${FLAGS}`).at > 0, byPath.err);
  assert.doesNotMatch(byPath.err, /\bnpx\b|installer/, byPath.err);
  const byName = await startByLauncher(t, data, join(root, "home"), { ...installed, PATH: `${dirname(command)}:${dirname(process.execPath)}` });
  assert.ok(lineWith(byName.err, `mv ${data} ${data}-earlier, then agentrun --data ${data}${FLAGS}.`).at > 0, byName.err);
  const behind = await startByLauncher(t, data, join(root, "home"), { ...installed, PATH: `${dirname(other)}:${dirname(command)}:${dirname(process.execPath)}` });
  assert.ok(lineWith(behind.err, `mv ${data} ${data}-earlier, then ${command} --data ${data}${FLAGS}.`).at > 0, `another agentrun earlier on PATH: by path\n${behind.err}`);
});

// A home folder reached by a link: the launcher says its command by real path, the refused folder is named as given, and
// both are the installer's folder, so the way on is still the installer, never that command, which the move takes away.
test("started by the installed agentrun in the old folder through a symlinked home: still the installer for this version", { timeout: 20_000 }, async (t) => {
  const root = await scratch(t);
  const real = join(root, "disk", "me");
  await mkdir(join(real, ".agentrun", "bin"), { recursive: true });
  await writeFile(join(real, ".agentrun", "bin", "agentrun"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink(real, join(root, "me"));
  const data = join(root, "me", ".agentrun");
  await oldHome(data, "old");
  const { err, code } = await startByLauncher(t, data, join(root, "me"), { AGENTRUN_INSTALLED_COMMAND: realpathSync(join(real, ".agentrun", "bin", "agentrun")) });
  assert.equal(code, 1, err);
  assert.ok(lineWith(err, `mv ${data} ${data}-earlier, then run the installer again for this version: curl -fsSL https://agentrun.ai/install | sh -s -- --version 0.4.22.`).at > 0, err);
  assert.doesNotMatch(err, /\bnpx\b|then \S*agentrun --data/, err);
});

test("with no installed agentrun in the folder, the folder moved aside starts again with the launcher's command, not the installer", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.ok(lineWith(err, `mv ${data} ${data}-earlier, then ${LAUNCHER}${FLAGS}.`).at > 0, err);
  assert.doesNotMatch(err, /installer/, err);
});

test("started by the launcher on a store an earlier release set up, the refusal names the launcher's command, not docker's", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  await store.close();
  const raw = new DatabaseSync(join(data, "store.sqlite"));
  raw.exec(`UPDATE store_meta SET schema_version = ${OLDEST_UPGRADED - 1}`);
  raw.close();
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: the store at .*store\.sqlite is schema version/m);
  assert.ok(lineWith(err, `${LAUNCHER} --data ${data}-new${FLAGS}`).at > 0, err);
  assert.doesNotMatch(err, /docker run|On Render/);
});

test("started on a --data of the person's own, the old folder moved aside starts again on that --data, not ~/.agentrun", { timeout: 20_000 }, async (t) => {
  const root = await scratch(t);
  const data = join(root, "work", "agents");
  await oldHome(data, "old");
  const { err, code } = await startByLauncher(t, data, join(root, "home"));
  assert.equal(code, 1, err);
  assert.ok(lineWith(err, `mv ${data} ${data}-earlier, then ${LAUNCHER} --data ${data}${FLAGS}.`).at > 0, err);
  assert.ok(lineWith(err, `(every later agentrun command then takes the same --data: without it, they open ${join(root, "home", ".agentrun")})`).at > 0, err);
});
