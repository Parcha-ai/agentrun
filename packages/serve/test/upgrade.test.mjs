// A data directory from 0.1.0-beta.26 or earlier holds agent homes (`<data>/<agent>/agent.sqlite`), which this version's
// store does not read. The server refuses to start on one, naming the homes, rather than serve it as if it were empty.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/server.js";
import { FAUX, client, follow, scratch, serve, startRun } from "./support.mjs";

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
  assert.match(error.message, /0\.1\.0-beta\.26 or earlier/);
  assert.ok(error.message.includes(join(data, "old", "agent.sqlite")) && error.message.includes(join(data, "triage", "agent.sqlite")), error.message);
  assert.match(error.message, /upgrad/i);
  assert.deepEqual((await readdir(data)).sort(), ["old", "triage"], "nothing is made beside the old homes: no store, no token");
});

test("a volume already started on this version is refused too while an old home is in it", async (t) => {
  const { data, close } = await serve(t);
  await close();
  assert.ok(existsSync(join(data, "store.sqlite")));
  await oldHome(data, "old");
  assert.match((await refusal({ data, port: 0, faux: FAUX }))?.message ?? "started", /agent homes from AgentRun Server 0\.1\.0-beta\.26 or earlier/);
});

test("a healthy volume of this version starts again on its own data, its agents and runs there", async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(first.baseUrl, first.token);
  const runId = (await startRun(api, "kept", "What is six times seven?")).run_id;
  await follow(api, runId, ["completed"]);
  await first.close();
  const { api: again } = await serve(t, { data });
  assert.deepEqual((await again("GET", "/agents")).body.agents.map((a) => a.agent_id), ["kept"]);
  assert.equal((await again("GET", `/runs/${runId}`)).body.status, "completed");
});

test("an old home under any name is refused: an agent named runs, a symlinked home, and a symlinked agent.sqlite", async (t) => {
  const root = await scratch(t);
  const named = join(root, "named");
  await oldHome(named, "runs");
  assert.match((await refusal({ data: named, port: 0, faux: FAUX }))?.message ?? "started", new RegExp(join(named, "runs", "agent.sqlite").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const linked = join(root, "linked");
  await oldHome(join(root, "elsewhere"), "kept");
  await mkdir(linked, { recursive: true });
  await symlink(join(root, "elsewhere", "kept"), join(linked, "kept"));
  assert.match((await refusal({ data: linked, port: 0, faux: FAUX }))?.message ?? "started", /0\.1\.0-beta\.26 or earlier/, "a symlinked home is refused too");
  const file = join(root, "file");
  await mkdir(join(file, "kept"), { recursive: true });
  await symlink(join(root, "elsewhere", "kept", "agent.sqlite"), join(file, "kept", "agent.sqlite"));
  assert.match((await refusal({ data: file, port: 0, faux: FAUX }))?.message ?? "started", /0\.1\.0-beta\.26 or earlier/, "a symlinked agent.sqlite is refused too");
});

test("this version's own runs/ and a directory with no agent.sqlite start as before", async (t) => {
  const data = join(await scratch(t), "agents");
  await mkdir(join(data, "runs", "01a1-example"), { recursive: true });
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
  assert.match(err, /^agentrun-serve: this data directory holds agent homes/m);
});
