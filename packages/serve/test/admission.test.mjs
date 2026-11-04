// Runs admitted by memory: each run reserves what a run of its harness takes, out of the host's memory less the
// server's own. A harness whose one run never fits is unavailable, said in capabilities and at start, and its runs are
// refused at once; one that fits but not now is 429 rate_limited, as over the cap on the count. A run already going (a
// message's wake, a relaunch) takes no place, but counts once its process lives. The host's memory is
// the container's limit (process.constrainedMemory), stood in for here: the server runs in this process.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as harness from "../dist/harness.js";
import * as host from "../dist/host.js";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve } from "./support.mjs";

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

test("a 384 MB server: claude-agent is unavailable with why in capabilities, its start refused at once with that reason; pi runs", async (t) => {
  withMemory(t, 384);
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const caps = (await api("GET", "/capabilities")).body;
  const offer = Object.fromEntries(caps.harnesses.map((h) => [h.id, h]));
  assert.equal(offer["claude-agent"].available, false, JSON.stringify(offer["claude-agent"]));
  const why = offer["claude-agent"].reason;
  assert.match(why, /^This server has 384 MB of memory .*a claude-agent run needs about \d+ MB more, so it can't start here\. pi and codex runs fit\.$/);
  assert.deepEqual([offer["claude-agent"].max_concurrent_runs, offer["claude-agent"].run_memory_mib], [0, RUN_MIB?.["claude-agent"]]);
  assert.deepEqual([offer.pi.available, offer.pi.max_concurrent_runs, offer.pi.run_memory_mib], [true, 2, RUN_MIB.pi]);
  assert.deepEqual([offer.codex.available, offer.codex.max_concurrent_runs], [true, 1]);
  assert.equal(caps.limits.max_concurrent_runs, 2, "the count is pi's, the smallest run");
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

test("two starts at once with a live run holding memory and room for one more: one starts and one is 429", { timeout: 120_000 }, async (t) => {
  withMemory(t, 512);
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(data, "go");
  assert.equal((await api("POST", "/agents", agent("small"))).status, 201);
  const held = await api("POST", "/agents/small/runs", { input: { content: `Answer once ${go} exists.` } });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  await follow(api, held.body.run_id, ["working"]);
  // 384 MB for runs, 128 held by pi: room for one codex run (192), not two.
  assert.equal((await api("POST", "/agents", agent("mid", { harness: "codex", instructions: `Wait for ${go} before the answer.` }))).status, 201);
  const both = await Promise.all([1, 2].map(() => api("POST", "/agents/mid/runs", { input: { content: "hi" } })));
  assert.deepEqual(both.map((res) => res.status).sort(), [202, 429], JSON.stringify(both.map((res) => res.body)));
  assert.deepEqual(both.find((res) => res.status === 429).body.error.details, { max_concurrent_runs: 3, harness: "codex", needs_mb: 192, free_mb: 64 });
  await writeFile(go, "");
  await follow(api, held.body.run_id, ["completed"]);
  await follow(api, both.find((res) => res.status === 202).body.run_id, ["completed"]);
});

test("after a restart on a host whose memory never holds a run's harness: a run that would open again fails with why, and a stopped one's message is refused with why; neither starts", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const never = join(data, "never");
  const one = await startServe({ data, port: 0, faux: FAUX, fauxHarness: FAUX_HARNESS, drainTimeout: "5s" });
  let open = true;
  t.after(() => open && one.close());
  const first = client(one.baseUrl, one.token);
  assert.equal((await first("POST", "/agents", agent("big", { harness: "claude-agent", instructions: `Wait for ${never} before the answer.` }))).status, 201);
  const working = (await first("POST", "/agents/big/runs", { input: { content: "hi" } })).body.run_id;
  const stopped = (await first("POST", "/agents/big/runs", { input: { content: "hi" } })).body.run_id;
  for (const id of [working, stopped]) await follow(first, id, ["working"]);
  assert.equal((await first("POST", `/runs/${stopped}/stop`)).body.stopped, true);
  await follow(first, stopped, ["input_required"]);
  await one.close();
  open = false;
  withMemory(t, 384);
  const { api } = await serve(t, { data, fauxHarness: FAUX_HARNESS });
  const why = neverFits("claude-agent", 384 * MiB);
  await follow(api, working, ["failed"]);
  assert.deepEqual((await api("GET", `/runs/${working}`)).body.error.message, why);
  const refused = await api("POST", `/runs/${stopped}/messages`, { content: "go on" });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.message], [409, "agent_not_runnable", why], JSON.stringify(refused.body));
  assert.deepEqual([(await api("GET", `/runs/${stopped}`)).body.status, (await api("GET", `/runs/${stopped}`)).body.state], ["input_required", "idle"]);
});
