// `serveStore` and the bin on an agent store: the API over the store's reader and its run stores, with the reader and
// the workflow views injected (test/fixtures/store-sample.mjs), read-only and on loopback like `serveHome`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serveStore } from "../dist/serve/index.js";
import { AGENTS, buildSampleStore, fakeReader, fakeWorkflow, REVISIONS, RUN, RUNS } from "./fixtures/store-sample.mjs";
import { request, scratch } from "./support.mjs";

const CLI = fileURLToPath(new URL("../dist/serve/cli.js", import.meta.url));
const linux = { skip: process.platform === "linux" ? undefined : "agent homes run on Linux only here", timeout: 60_000 };
const SIDE = ["-wal", "-shm", "-journal"];

/** Every file under `dir` but SQLite's side files, with its size, mtime and a hash of its bytes. */
const files = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile() && !SIDE.some((suffix) => entry.name.endsWith(suffix))).map((entry) => {
  const file = path.join(entry.parentPath, entry.name);
  const info = statSync(file);
  return { path: path.relative(dir, file), size: info.size, mtimeMs: info.mtimeMs, sha: createHash("sha256").update(readFileSync(file)).digest("hex") };
}).sort((a, b) => (a.path < b.path ? -1 : 1));

async function sample(options = {}) {
  const root = await buildSampleStore(await scratch());
  const reader = fakeReader();
  const workflow = fakeWorkflow(options.workflow);
  const served = await serveStore({ dir: root }, { openReader: reader.open, workflow: workflow.views });
  const get = async (target) => {
    const res = await request(served.url, { target });
    return { ...res, json: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(res.body) : undefined };
  };
  return { root, reader, workflow, served, get };
}

test("the picker: /api/store lists each agent with its current revision's kind, its revisions and its runs, read through a reader opened on a copy of the index that is removed", linux, async () => {
  const { root, reader, served, get } = await sample();
  const before = files(root);
  try {
    const store = await get("/api/store");
    assert.equal(store.status, 200);
    assert.deepEqual(store.json.agents.map((agent) => [agent.id, agent.name, agent.currentKind, agent.revisions, agent.runs]), [
      ["company-researcher", "Company researcher", "workflow", 3, 6],
      ["inbox-triage", "Inbox triage", "agentic", 1, 1],
      ["mcc-classifier", "MCC classifier", "workflow", 2, 4],
    ]);
    assert.equal(store.json.agents[0].current, REVISIONS.C.id);
    assert.equal(store.json.agents[0].description, AGENTS[0].description);
    assert.equal(reader.opened.length, 1);
    assert.notEqual(reader.opened[0], root, "the reader is opened on a copy of the index, not the store");
    assert.equal(existsSync(reader.opened[0]), false, "and the copy is removed once read");
    await get("/api/store");
    assert.equal(reader.opened.length, 1, "an index that did not change is not read again");
    const page = await get("/");
    assert.match(page.body, /<html lang="en" data-serve="store">/);
    assert.match(page.body, /<script src="\/graph\.js"><\/script>\n<script src="\/page\.js"><\/script>/, "the graph drawer, when it is there, loads before the page");
    assert.equal((await get("/page.js")).status, 200);
  } finally {
    await served.close();
  }
  assert.deepEqual(files(root), before, "nothing in the store changed but SQLite's side files");
});

test("the bin serves the store page for a directory with a store.sqlite, and an agent home's page for a home", linux, async (t) => {
  const root = await buildSampleStore(await scratch());
  const child = spawn(process.execPath, [CLI, "serve", root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  while (!out.includes("\n")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(out, /^http:\/\/127\.0\.0\.1:\d+\/\n$/);
  assert.match((await request(out.trim(), { target: "/" })).body, /data-serve="store"/);
  const home = await request(out.trim(), { target: "/api/agent" });
  assert.equal(home.status, 404, "a store has no single agent");
  child.kill("SIGINT");
  assert.equal(await new Promise((resolve) => child.once("exit", (code) => resolve(code))), 0);
});
