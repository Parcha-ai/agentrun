// A run's pinned revision in its own directory: serve writes `revision.json` before the run's process starts, and the
// process reads it there, so it starts with no agent store above its directory. A run from before that file still opens
// through the store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openStoreReader, seedRun } from "@parcha/pi-durable-agent";
import { readWorkflowRun } from "@parcha/pi-durable-agent/workflow";
import { answerFlow, FAUX, flowAgent, follow, scratch, serve, startRun, storeRun } from "./support.mjs";

const PDD_CLI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@parcha/pi-durable-disk")));
const APP = fileURLToPath(new URL("../dist/app.js", import.meta.url));
const SECRETS = new URL("../dist/secrets.js", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The store's row and revision of run `runId`. */
function stored(data, runId) {
  const reader = openStoreReader(data);
  try {
    const run = reader.readRun(runId);
    return { run, revision: reader.readRevision(run.revision) };
  } finally {
    reader.close();
  }
}

/** A copy of run `runId` with no agent store above it: seeded as the store seeds a run, with serve's revision.json and
 *  serve.json, at `<scratch>/box/run` (a name that is not the run's id). */
async function boxed(t, data, runId) {
  const dir = join(await scratch(t), "box", "run");
  await seedRun({ storePath: join(dir, "store", "run.sqlite"), workDir: join(dir, "work") }, { runId, leases: [], profiles: {}, skills: {} });
  for (const file of ["revision.json", "serve.json"]) await copyFile(join(data, "runs", runId, file), join(dir, file));
  assert.equal(existsSync(join(dir, "..", "..", "store.sqlite")), false);
  return dir;
}

/** The run's process on `dir`, started as serve starts it, on the faux model; `exit` settles with its code. */
function runProcess(t, dir) {
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", SECRETS, PDD_CLI, "run", "--dir", dir, "--app", APP, "--serve", "0", "--serve-host", "127.0.0.1", "--drain-timeout", "0s"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, AGENTRUN_SERVE_FAUX: FAUX },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  return { child, exit, stderr: () => stderr };
}

/** The door of the run's process on `dir`, once its run.json names it. */
async function doorOf(dir, proc) {
  for (let i = 0; ; i++) {
    const record = await readFile(join(dir, "run.json"), "utf8").then(JSON.parse, () => null);
    if (record?.status === "running" && typeof record.holder?.serve === "string") return record.holder.serve;
    assert.ok(i < 400 && proc.child.exitCode === null, `the run's process did not serve: ${proc.stderr()}`);
    await sleep(50);
  }
}

test("a new run's directory holds revision.json, and its process runs to completion on it with no agent store above it: agentic and workflow", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  const agentic = await startRun(api, "writer", "Write the report.", { tools: ["write"] });
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const flow = (await api("POST", "/agents/flow/runs", { input: { question: "What is six times seven?" } })).body;
  for (const { run_id } of [agentic, flow]) {
    await follow(api, run_id, ["completed"]);
    const file = join(data, "runs", run_id, "revision.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const { run, revision } = stored(data, run_id);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { run: { id: run.id, agent: run.agent, revision: run.revision }, revision });
  }
  assert.equal((await api("GET", `/runs/${agentic.run_id}`)).body.result.final_answer, "I wrote report.md.");
  assert.deepEqual((await api("GET", `/runs/${flow.run_id}`)).body.result.output, { answer: 42 });

  // The workflow run's process, on its copy: it runs the workflow, writes its status and releases the run on its own.
  const flowDir = await boxed(t, data, flow.run_id);
  const flowProc = runProcess(t, flowDir);
  assert.equal(await flowProc.exit, 0, flowProc.stderr());
  assert.equal(JSON.parse(await readFile(join(flowDir, "run.json"), "utf8")).status, "done");
  const view = await readWorkflowRun({ runId: flow.run_id, storePath: join(flowDir, "store", "run.sqlite"), revision: { body: { workflow: answerFlow() } }, state: "completed" });
  assert.deepEqual(view.output, { answer: 42 });

  // The agentic run's process, on its copy: its first message through its door, as serve sends it; its turn writes the
  // report with the tool only its revision names, and the process drains on SIGTERM.
  const agenticDir = await boxed(t, data, agentic.run_id);
  const agenticProc = runProcess(t, agenticDir);
  const door = await doorOf(agenticDir, agenticProc);
  for (let i = 0; ; i++) {
    const submitted = await fetch(new URL("/submit", door), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: `first-${agentic.run_id}`, content: "Write the report.", whenBusy: "followUp" }) });
    if (submitted.ok) break;
    // 503 OPENING while the run opens, as serve's own submit retries it.
    const answer = await submitted.text();
    assert.ok(submitted.status === 503 && i < 400, `the door took the first message: ${submitted.status} ${answer} ${agenticProc.stderr()}`);
    await sleep(50);
  }
  for (let i = 0; ; i++) {
    const status = await (await fetch(new URL("/status", door))).json();
    if (existsSync(join(agenticDir, "work", "report.md")) && status.busy?.kind === "idle") break;
    assert.ok(i < 400, `the turn did not end: ${JSON.stringify(status)} ${agenticProc.stderr()}`);
    await sleep(50);
  }
  assert.equal(await readFile(join(agenticDir, "work", "report.md"), "utf8"), "# Report\n\nThe answer is 42.\n");
  agenticProc.child.kill("SIGTERM");
  assert.equal(await agenticProc.exit, 0, agenticProc.stderr());
});

test("a revision.json that is not whole, or whose revision was changed, is refused: the process fails and does not read the store in its place", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const flow = (await api("POST", "/agents/flow/runs", { input: { question: "What is six times seven?" } })).body;
  await follow(api, flow.run_id, ["completed"]);
  const pinned = JSON.parse(await readFile(join(data, "runs", flow.run_id, "revision.json"), "utf8"));
  const changed = structuredClone(pinned);
  changed.revision.body.workflow.root.steps[0].instructions = "Answer 41.";
  const otherAgent = { ...pinned, run: { ...pinned.run, agent: "someone-else" } };
  for (const [text, refusal] of [
    ['{"run":', /revision\.json is not its row and pinned revision/],
    [JSON.stringify(changed), /revision\.json holds a revision whose content does not match its id/],
    [JSON.stringify(otherAgent), /revision\.json is not its row and pinned revision/],
  ]) {
    const dir = await boxed(t, data, flow.run_id);
    await writeFile(join(dir, "revision.json"), text);
    const proc = runProcess(t, dir);
    assert.notEqual(await proc.exit, 0);
    assert.match(proc.stderr(), refusal);
    assert.doesNotMatch(proc.stderr(), /store\.sqlite|agent store/);
    await rm(join(dir, ".."), { recursive: true, force: true });
  }
});

test("a run whose directory has no revision.json, as one started before it was written, still opens through the store", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t);
  const { run_id } = await startRun(api, "calc", "Say hello.");
  await follow(api, run_id, ["completed"]);
  await rm(join(data, "runs", run_id, "revision.json"));
  const next = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["Say hello.", "go on"]);
  assert.equal(rows.findLast((r) => r.kind === "final_answer")?.text, "On go on: done.");
  assert.equal(storeRun(data, run_id).state, "completed");
});
