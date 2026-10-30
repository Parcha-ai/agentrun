// A run has one workspace (run-workspace.ts): a run on a harness other than pi keeps it in the directory its harness's box
// is lent (harness/work), where the harness's own tools write, and pi's door tools, the files route, the walk and the
// run's own record all name the same tree. A pi run, and a run opened before the field, keep work/; a run is never moved.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const toolResults = (rows) => rows.filter((r) => r.kind === "tool_result").map((r) => `${r.summary ?? ""} ${r.tool_result_preview ?? ""}`);

async function started(api, id, instructions, harness, tools = ["read", "write"]) {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions, tools }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

async function firstTool(api, runId) {
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first tool's row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const killRun = async (data, runId) => process.kill((await json(join(data, "runs", runId, "run.json"))).holder.pid, "SIGKILL");

test("a harness run's one workspace is harness/work: recorded, written by pi's door tools and by the harness's own, listed and read by serve, and each tool reads the other's", { timeout: 90_000 }, async (t) => {
  const { api, data, baseUrl, token } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "one-tree", `Write, then read native.txt after ${go}.`, "codex");
  const run = join(data, "runs", runId);
  await firstTool(api, runId);
  assert.equal((await json(join(run, "serve.json"))).workspace, "harness/work", "serve.json records it at the first open");
  assert.equal((await json(join(run, "run.json"))).workspace, "harness/work", "and the run's own record agrees");
  // What the harness's own tool writes lands in its machine's root, <io.dir>/work, io.dir being <run>/harness (app.ts).
  await writeFile(join(run, "harness", "work", "native.txt"), "from the harness's own tool");
  await writeFile(go, "");
  await killRun(data, runId);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await readFile(join(run, "harness", "work", "note.txt"), "utf8"), "from the door", "the door's write is in harness/work");
  assert.equal(existsSync(join(run, "work")), false, "there is no second tree at work/");
  assert.match(toolResults(rows).at(-1), /from the harness's own tool/, "the door read what the harness's tool wrote");
  const list = await api("GET", `/runs/${runId}/files`);
  assert.deepEqual(list.body.files.map((f) => f.path), ["native.txt", "note.txt"], "the walk lists both");
  for (const [name, text] of [["note.txt", "from the door"], ["native.txt", "from the harness's own tool"]]) {
    const res = await fetch(`${baseUrl}/runs/${runId}/files/${name}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await res.text(), text, `the files route reads ${name}`);
  }
  // The run's root is still its directory: its store is where it always was.
  assert.ok(existsSync(join(run, "store", "run.sqlite")), "store/ is at the run's root");
  assert.equal(existsSync(join(run, "harness", "store")), false);
});

test("a pi run keeps work/, recorded as work", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const runId = await started(api, "pi-run", "Answer the question.", "pi", []);
  await follow(api, runId, ["completed"]);
  assert.equal((await json(join(data, "runs", runId, "serve.json"))).workspace, "work");
  assert.equal((await json(join(data, "runs", runId, "run.json"))).workspace, "work");
  assert.equal(existsSync(join(data, "runs", runId, "harness", "work")), false);
});

test("a harness run opened before the field keeps work/ when it opens again: its record is read, never replaced, and nothing moves", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serve(t, { data, fauxHarness: FAUX_HARNESS });
  const runId = await started(first.api, "older", "Answer the question.", "claude-agent");
  await follow(first.api, runId, ["completed"]);
  await first.close();
  // As a server before the field left it: no workspace in either record, its files at work/.
  const run = join(data, "runs", runId);
  for (const file of ["serve.json", "run.json"]) {
    const record = await json(join(run, file));
    delete record.workspace;
    await writeFile(join(run, file), JSON.stringify(record));
  }
  await rename(join(run, "harness", "work"), join(run, "work"));
  await writeFile(join(run, "work", "note.txt"), "an older run's file");
  const again = await serve(t, { data, fauxHarness: FAUX_HARNESS });
  assert.deepEqual((await again.api("GET", `/runs/${runId}/files`)).body.files.map((f) => f.path), ["note.txt"], "the walk reads work/");
  assert.equal((await again.api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  await follow(again.api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal((await json(join(run, "serve.json"))).workspace, undefined, "the record is kept as it was");
  assert.equal((await json(join(run, "run.json"))).workspace, "work", "and the run opened on work/, the record's");
  assert.deepEqual((await again.api("GET", `/runs/${runId}/files`)).body.files.map((f) => f.path), ["note.txt"]);
});
