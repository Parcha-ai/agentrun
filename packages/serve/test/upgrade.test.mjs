// A data directory from 0.1.0-beta.26 or earlier holds agent homes (`<data>/<agent>/agent.sqlite`), which this version's
// store does not read. The server refuses to start on one, naming the homes, rather than serve it as if it were empty.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
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

// The four versions before this one are the ones a server upgrades in place (store-listing-upgrade.test.mjs,
// store-relay-upgrade.test.mjs, store-purge-upgrade.test.mjs, learn-per-disk.test.mjs); five before is refused.
test("the bin on a store an earlier release set up says what to do, once, with no stack, and exits 1", { timeout: 20_000 }, async (t) => {
  const { err, code } = await startOnStoreAt(t, SCHEMA_VERSION - 5);
  assert.equal(code, 1, err);
  assert.match(err, new RegExp(`^agentrun-serve: the store at .*store\\.sqlite is schema version ${SCHEMA_VERSION - 5}, and this release \\(version ${SCHEMA_VERSION}\\) can't open a store an earlier release set up\\.$`, "m"));
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

/** The bin started as `npx @parcha/agentrun@0.4.22` starts it (the launcher names itself in AGENTRUN_NPX_PACKAGE, and
 *  opens the browser unless --no-open), on `data`: its stderr and exit code. */
const startByLauncher = async (t, data, home = dirname(data)) => {
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--open", "--data", data, "--faux", FAUX], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home, AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.4.22", AGENTRUN_SERVE_PORT: "", npm_config_yes: "" } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = child.exitCode ?? (await new Promise((resolve) => child.once("exit", resolve)));
  return { err, code };
};

// A new folder is not a new AgentRun: `npx @parcha/agentrun` keeps its data in ~/.agentrun wherever it is run, so an
// earlier version's ~/.agentrun stops this one. The refusal gives the command the person ran on a new, empty folder, and
// the other way, the old folder moved aside whole; it never says to delete it.
test("started by npx @parcha/agentrun on an earlier version's data, the refusal names the command on a new folder, and moving the old one aside", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: .* holds an earlier version's data \(old\/agent\.sqlite\)/m);
  const lines = err.split("\n");
  const aside = lines.findIndex((line) => line.startsWith(`To keep all of it where the earlier version still opens it and start this version in ${data}: mv ${data} ${data}-earlier, then npx @parcha/agentrun@0.4.22. `));
  const fresh = lines.indexOf(`Or start this version on a new, empty folder: npx @parcha/agentrun@0.4.22 --data ${data}-new`);
  assert.ok(aside > 0 && fresh > aside, `the old folder moved aside first, then a new folder:\n${err}`);
  assert.doesNotMatch(err, /\bdelete\b|\brm\b/i, "it never says to delete the old folder");
  assert.equal(err.match(/add your agents/gi).length, 1, err);
  assert.ok(!existsSync(`${data}-new`) && !existsSync(`${data}-earlier`), "the refusal only names the folders");
  assert.equal(err.match(/agentrun-serve:/g).length, 1, err);
});

test("the new folder it names is one not there yet, and an earlier installer's command in the old folder is said to move with it", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  await oldHome(data, "old");
  await mkdir(`${data}-new`, { recursive: true });
  await mkdir(`${data}-earlier`, { recursive: true });
  await mkdir(join(data, "bin"), { recursive: true });
  await writeFile(join(data, "bin", "agentrun"), "#!/bin/sh\n");
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.ok(err.includes(`npx @parcha/agentrun@0.4.22 --data ${data}-new-2`), err);
  assert.ok(err.includes(`mv ${data} ${data}-earlier-2`), err);
  assert.match(err, /bin\/agentrun \(the earlier installer's command\) moves with it/);
});

test("started by the launcher on a store an earlier release set up, the refusal names the launcher's command, not docker's", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), ".agentrun");
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  await store.close();
  const raw = new DatabaseSync(join(data, "store.sqlite"));
  raw.exec(`UPDATE store_meta SET schema_version = ${SCHEMA_VERSION - 5}`);
  raw.close();
  const { err, code } = await startByLauncher(t, data);
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: the store at .*store\.sqlite is schema version/m);
  assert.ok(err.split("\n").includes(`Or start this version on a new, empty folder: npx @parcha/agentrun@0.4.22 --data ${data}-new`), err);
  assert.doesNotMatch(err, /docker run|On Render/);
});

test("started on a --data of the person's own, the old folder moved aside starts again on that --data, not ~/.agentrun", { timeout: 20_000 }, async (t) => {
  const root = await scratch(t);
  const data = join(root, "work", "agents");
  await oldHome(data, "old");
  const { err, code } = await startByLauncher(t, data, join(root, "home"));
  assert.equal(code, 1, err);
  assert.ok(err.includes(`start this version in ${data}: mv ${data} ${data}-earlier, then npx @parcha/agentrun@0.4.22 --data ${data}. `), err);
  assert.ok(err.includes(`without it, they open ${join(root, "home", ".agentrun")})`), err);
});
