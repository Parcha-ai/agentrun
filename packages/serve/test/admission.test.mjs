// Runs admitted by memory: each run reserves what a run of its harness takes, out of the host's memory less the
// server's own. A harness whose one run never fits is unavailable, said in capabilities and at start, and its runs are
// refused at once; one that fits but not now is 429 rate_limited, as over the cap on the count. The host's memory is
// the container's limit (process.constrainedMemory), stood in for here: the server runs in this process.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as harness from "../dist/harness.js";
import * as host from "../dist/host.js";
import { agent, follow, scratch, serve } from "./support.mjs";

const MiB = 2 ** 20;
// Read as names, not bindings: a build without them fails each test on its own, not the file at its import.
const { RUN_MIB } = harness;
const { defaultMaxRuns, neverFits, runsMemoryMib, runsThatFit, SERVER_MIB } = host;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** This process's container limit read as `mib` until the test ends. */
function withMemory(t, mib) {
  const was = process.constrainedMemory;
  process.constrainedMemory = () => mib * MiB;
  t.after(() => void (process.constrainedMemory = was));
}

test("the memory math: what runs may hold is the host's memory less the server's own, and each harness fits by its own size", () => {
  assert.deepEqual(RUN_MIB, { pi: 128, "claude-agent": 288, codex: 192 }, "the measured table (harness.ts)");
  assert.equal(SERVER_MIB, 128);
  const fit = (mib) => ["pi", "codex", "claude-agent"].map((id) => runsThatFit(id, mib * MiB));
  assert.equal(runsMemoryMib(512 * MiB), 384);
  assert.deepEqual(fit(384), [2, 1, 0], "384 MB: no claude-agent run");
  assert.deepEqual(fit(512), [3, 2, 1], "a 512 MB instance: one claude-agent run");
  assert.deepEqual(fit(1024), [7, 4, 3]);
  assert.deepEqual(fit(2048), [15, 10, 6]);
  assert.deepEqual(fit(8192), [63, 42, 28]);
  assert.deepEqual(fit(200), [1, 0, 0], "pi, the default, always has one place");
  for (const mib of [200, 512, 1024, 8192]) assert.equal(defaultMaxRuns(mib * MiB), runsThatFit("pi", mib * MiB), "the default cap on the count is pi's");
  assert.equal(neverFits("pi", 200 * MiB), undefined);
  assert.equal(neverFits("claude-agent", 512 * MiB), undefined);
  assert.equal(neverFits("claude-agent", 384 * MiB), "This server has 384 MB of memory and keeps 128 MB for itself; a claude-agent run needs about 288 MB more, so it can't start here. pi and codex runs fit.");
  assert.equal(neverFits("codex", 300 * MiB), "This server has 300 MB of memory and keeps 128 MB for itself; a codex run needs about 192 MB more, so it can't start here. pi runs fit.");
});

test("a 384 MB server: claude-agent is unavailable with why, in capabilities and its start log, its start refused at once with that reason; pi runs", async (t) => {
  withMemory(t, 384);
  const lines = [];
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, log: (line) => lines.push(line) });
  const caps = (await api("GET", "/capabilities")).body;
  const offer = Object.fromEntries(caps.harnesses.map((h) => [h.id, h]));
  assert.equal(offer["claude-agent"].available, false, JSON.stringify(offer["claude-agent"]));
  const why = offer["claude-agent"].reason;
  assert.match(why, /^This server has 384 MB of memory .*a claude-agent run needs about \d+ MB more, so it can't start here\. pi and codex runs fit\.$/);
  assert.deepEqual([offer["claude-agent"].max_concurrent_runs, offer["claude-agent"].run_memory_mib], [0, RUN_MIB?.["claude-agent"]]);
  assert.deepEqual([offer.pi.available, offer.pi.max_concurrent_runs, offer.pi.run_memory_mib], [true, 2, RUN_MIB.pi]);
  assert.deepEqual([offer.codex.available, offer.codex.max_concurrent_runs], [true, 1]);
  assert.equal(caps.limits.max_concurrent_runs, 2, "the count is pi's, the smallest run");
  const said = lines.filter((line) => line.includes("event=memory"));
  assert.equal(said.length, 1, `said once at start:\n${lines.join("\n")}`);
  assert.match(said[0], /memory_mb=384 for_runs_mb=256 per_run_mb=pi:128,claude-agent:288,codex:192 claude-agent="This server has 384 MB/);
  // Saved with a warning, as any harness this host does not run; its run is refused at once, never a 429 to try again.
  const made = await api("POST", "/agents", agent("big", { harness: "claude-agent", instructions: "Answer the question." }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings.map((w) => [w.field, w.message]), [["definition.harness", why]]);
  const refused = await api("POST", "/agents/big/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message, refused.body.error.details.harness], [409, "agent_not_runnable", why, "claude-agent"], JSON.stringify(refused.body));
  assert.equal(refused.headers.get("retry-after"), null);
  assert.equal((await api("POST", "/agents", agent("small"))).status, 201);
  const run = await api("POST", "/agents/small/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
});

test("a 512 MB server holds one claude-agent run: a second, and a pi run with too little left, are 429 rate_limited with retry-after; once it ends, the next starts", { timeout: 120_000 }, async (t) => {
  withMemory(t, 512);
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent("big", { harness: "claude-agent", instructions: `Wait for ${go} before the answer.` }))).status, 201);
  const first = await api("POST", "/agents/big/runs", { input: { content: "hi" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["working"]);
  const refused = await api("POST", "/agents/big/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.retryable], [429, "rate_limited", true], JSON.stringify(refused.body));
  assert.match(refused.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(refused.body.error.message, "This server's memory is held by the runs it has going: a claude-agent run needs about 288 MB, and 96 MB of the 384 MB it has for runs is free; start this one when another ends.");
  assert.deepEqual(refused.body.error.details, { max_concurrent_runs: 3, harness: "claude-agent", needs_mb: 288, free_mb: 96 });
  // Under the cap on the count (3), a pi run is refused by the memory left, not by the count.
  assert.equal((await api("POST", "/agents", agent("small"))).status, 201);
  const small = await api("POST", "/agents/small/runs", { input: { content: "hi" } });
  assert.deepEqual([small.status, small.body.error?.details?.harness, small.body.error?.details?.free_mb], [429, "pi", 96], JSON.stringify(small.body));
  assert.equal((await api("GET", "/runs")).body.runs.length, 1, "nothing more started");
  // The faux harness's wait holds for the life of the run's process: the run is cancelled, and its process gives the
  // memory back as it exits.
  assert.equal((await api("POST", `/runs/${first.body.run_id}/cancel`)).status, 202);
  await follow(api, first.body.run_id, ["cancelled"]);
  assert.equal((await api("POST", "/agents", agent("chat", { harness: "claude-agent", instructions: "Answer the question." }))).status, 201);
  const next = await api("POST", "/agents/chat/runs", { input: { content: "hi" } });
  assert.equal(next.status, 202, `the first run gave its memory back: ${JSON.stringify(next.body)}`);
  await follow(api, next.body.run_id, ["completed"]);
});

test("--max-runs still bounds the count beside the memory: on 1 GB with a cap of 1, a pi run that fits by memory is 429 by the count", async (t) => {
  withMemory(t, 1024);
  const { api, data } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("GET", "/capabilities")).body.limits.max_concurrent_runs, 1);
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const first = await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${join(data, "go")} exists.` } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const refused = await api("POST", "/agents/busy/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.details.max_concurrent_runs], [429, 1], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /at most 1 runs at once/);
  await writeFile(join(data, "go"), "");
  await follow(api, first.body.run_id, ["completed"]);
});
