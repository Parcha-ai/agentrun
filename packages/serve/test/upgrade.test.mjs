// A data directory from 0.1.0-beta.26 or earlier holds agent homes (`<data>/<agent>/agent.sqlite`), which this version's
// store does not read. The server refuses to start on one, naming the homes, rather than serve it as if it were empty.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/server.js";
import { FAUX, scratch, serve } from "./support.mjs";

const oldHome = async (data, id) => {
  await mkdir(join(data, id, "runs"), { recursive: true });
  await writeFile(join(data, id, "agent.sqlite"), "SQLite format 3\0");
};

test("a data directory with beta.26 agent homes is refused at start, each home named, nothing created", async (t) => {
  const data = join(await scratch(t), "agents");
  await oldHome(data, "old");
  await oldHome(data, "triage");
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), (error) => {
    assert.match(error.message, /0\.1\.0-beta\.26 or earlier/);
    assert.ok(error.message.includes(join(data, "old", "agent.sqlite")) && error.message.includes(join(data, "triage", "agent.sqlite")), error.message);
    assert.match(error.message, /upgrad/i);
    return true;
  });
  assert.equal(existsSync(join(data, "store.sqlite")), false, "no store is made beside the old homes");
});

test("a volume already started on this version is refused too while an old home is in it", async (t) => {
  const { data, close } = await serve(t);
  await close();
  assert.ok(existsSync(join(data, "store.sqlite")));
  await oldHome(data, "old");
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), /agent homes from AgentRun Server 0\.1\.0-beta\.26 or earlier/);
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
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "ignore", "pipe"] });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = child.exitCode ?? (await new Promise((resolve) => child.once("exit", resolve)));
  assert.equal(code, 1, err);
  assert.match(err, /^agentrun-serve: this data directory holds agent homes/m);
});
