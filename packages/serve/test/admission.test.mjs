// What a host's memory admits: each harness's run size, out of the host's memory less the server's own, sets how many
// runs of it fit, which capabilities report. A harness whose one run never fits is unavailable, said in capabilities and
// at start, and its runs are refused at once (409, never a 429 to try again). A run that fits is never refused for a
// place: the runner holds at most the run cap (--max-runs, by default as many pi runs as fit) and only the runs whose
// sizes its memory holds together (memory-claim.ts), and a run past either waits queued until one ends. The host's memory is the container's limit (process.constrainedMemory), stood in for here: the
// server runs in this process.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as harness from "../dist/harness.js";
import * as table from "../dist/harness-table.js";
import * as host from "../dist/host.js";
import { agent, follow, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const MiB = 2 ** 20;
// Read as names, not bindings: a build without them fails each test on its own, not the file at its import.
const { builtinHarness } = table;
/** Each harness's run size, as its table entry states it (an adapter's from its facts). */
const RUN_MIB = Object.fromEntries((harness.HARNESSES ?? []).map((id) => [id, builtinHarness?.(id)?.runMib]));
const { defaultMaxRuns, neverFits, runsMemoryMib, runsThatFit, SERVER_MIB } = host;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** Polls `check` until it holds, or fails naming `what` after `ms`. */
async function until(check, what, ms = 30_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 10))) assert.ok(Date.now() < end, `not within ${ms} ms: ${what}`);
}

/** This process's container limit read as `mib` until the test ends. */
function withMemory(t, mib) {
  const was = process.constrainedMemory;
  process.constrainedMemory = () => mib * MiB;
  t.after(() => void (process.constrainedMemory = was));
}

test("the memory math: what runs may hold is the host's memory less the server's own, and each harness fits by its own size", () => {
  assert.deepEqual(RUN_MIB, { pi: 128, "claude-agent": 288, codex: 192, opencode: 704 }, "the measured sizes (harness-table.ts, each adapter's facts)");
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

test("an opencode run reserves its own measured size, 704 MB, not the largest: 1 GB holds one, 2 GB two and 512 MB none, said in words", () => {
  assert.equal(RUN_MIB.opencode, 704, "measured (opencode's facts)");
  assert.equal(host.runMibOf("opencode"), 704);
  assert.deepEqual([512, 1024, 2048, 8192].map((mib) => runsThatFit("opencode", mib * MiB)), [0, 1, 2, 11]);
  assert.equal(neverFits("opencode", 1024 * MiB), undefined);
  assert.equal(neverFits("opencode", 512 * MiB), "This server has 512 MB of memory and keeps 128 MB for itself; an opencode run needs about 704 MB more, so it can't start here. pi, claude-agent and codex runs fit.");
});

test("a 384 MB server: claude-agent is unavailable with why in capabilities, its start refused at once with that reason; pi runs", async (t) => {
  withMemory(t, 384);
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
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
  // The details hold the contract's blocked shape (openapi.ts): nothing unbound, nothing missing, and the harness.
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message, refused.body.error.details], [409, "agent_not_runnable", why, { unbound: [], missing: {}, harness: "claude-agent" }], JSON.stringify(refused.body));
  assert.equal(refused.headers.get("retry-after"), null);
  assert.equal((await api("POST", "/agents", agent("small"))).status, 201);
  const run = await api("POST", "/agents/small/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
});

test("--max-runs bounds the count beside the memory: on 1 GB with a cap of 1, a second pi run that fits by memory is queued, not refused, and runs once the first ends", { timeout: 120_000 }, async (t) => {
  withMemory(t, 1024);
  const { api, data, runnerBeats } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("GET", "/capabilities")).body.limits.max_concurrent_runs, 1);
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const first = await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${join(data, "go")} exists.` } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["working"]);
  const second = await api("POST", "/agents/busy/runs", { input: { content: "hi" } });
  assert.equal(second.status, 202, `queued, never refused for a place: ${JSON.stringify(second.body)}`);
  assert.equal(second.headers.get("retry-after"), null);
  // The runner holds its one place: past three more of its beats (polls, each of which would claim a waiting run had it
  // a place), the second is still queued while the first works.
  const seen = runnerBeats();
  await until(() => runnerBeats() >= seen + 3, "three more runner beats");
  assert.equal((await api("GET", `/runs/${first.body.run_id}`)).body.status, "working");
  assert.equal((await api("GET", `/runs/${second.body.run_id}`)).body.status, "queued");
  await writeFile(join(data, "go"), "");
  await follow(api, first.body.run_id, ["completed"]);
  await follow(api, second.body.run_id, ["completed"]);
});

test("the runner claims by memory too: on 512 MB, whose 384 MB for runs holds one claude-agent run (288 MB), a second waits queued under a run cap of three, and runs once the first ends", { timeout: 120_000 }, async (t) => {
  withMemory(t, 512);
  const { api, data, runnerBeats } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.limits.max_concurrent_runs, 3, "the count alone (pi's, the smallest run) would take three");
  assert.equal(Object.fromEntries(caps.harnesses.map((h) => [h.id, h.max_concurrent_runs]))["claude-agent"], 1);
  const go = join(data, "go");
  assert.equal((await api("POST", "/agents", agent("heavy", { harness: "claude-agent", instructions: `Answer once ${go} exists.` }))).status, 201);
  const first = await api("POST", "/agents/heavy/runs", { input: { content: "hi" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["working"], { deadlineMs: 55_000 });
  const second = await api("POST", "/agents/heavy/runs", { input: { content: "hi" } });
  assert.equal(second.status, 202, `queued, never refused for a place: ${JSON.stringify(second.body)}`);
  assert.equal(second.headers.get("retry-after"), null);
  // Two of the runner's three places are free, but not its memory: past three more of its beats (polls, each of which
  // would claim the waiting run had it the room), the second is still queued while the first works.
  const seen = runnerBeats();
  await until(() => runnerBeats() >= seen + 3, "three more runner beats");
  assert.equal((await api("GET", `/runs/${first.body.run_id}`)).body.status, "working");
  assert.equal((await api("GET", `/runs/${second.body.run_id}`)).body.status, "queued", "held back by memory, not by the count");
  await writeFile(go, "");
  await follow(api, first.body.run_id, ["completed"], { deadlineMs: 55_000 });
  await follow(api, second.body.run_id, ["completed"], { deadlineMs: 55_000 });
});

/** Runs of a claude-agent agent the first start, server and runner, leaves working on a host they fit, stopped mid-turn;
 *  then the next start's server and runner on a host of 384 MB, where no claude-agent run fits. */
async function restartedSmaller(t, count, before = async () => {}) {
  const never = join(await scratch(t), "never");
  const one = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  assert.equal((await one.api("POST", "/agents", agent("big", { harness: "claude-agent", instructions: `Wait for ${never} before the answer.` }))).status, 201);
  const ids = [];
  for (let i = 0; i < count; i++) ids.push((await one.api("POST", "/agents/big/runs", { input: { content: "hi" } })).body.run_id);
  for (const id of ids) await follow(one.api, id, ["working"]);
  await before(one.api, ids);
  await one.stop();
  withMemory(t, 384);
  const { api } = await serve(t, { data: one.data, harnessTable: fauxTable(FAUX_HARNESS) });
  return { api, ids, why: neverFits("claude-agent", 384 * MiB) };
}

test("after a restart on a host whose memory never holds a run's harness: a run that would open again fails with why, and never starts", { timeout: 120_000 }, async (t) => {
  const { api, ids: [working], why } = await restartedSmaller(t, 1);
  const { last } = await follow(api, working, ["failed", "completed"]);
  assert.equal(last.status, "failed", JSON.stringify(last));
  assert.deepEqual((await api("GET", `/runs/${working}`)).body.error.message, why);
});

// SKIP (follow-up #2430): on the runner a person's stop ends the run, not its turn, so the stopped run never reads input_required
test.skip("after a restart on a host whose memory never holds a run's harness: a stopped run's message is refused with why, and it never starts", { timeout: 120_000 }, async (t) => {
  const { api, ids: [stopped], why } = await restartedSmaller(t, 1, async (first, [id]) => {
    assert.equal((await first("POST", `/runs/${id}/stop`)).body.stopped, true);
    await follow(first, id, ["input_required"]);
  });
  const refused = await api("POST", `/runs/${stopped}/messages`, { content: "go on" });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.message, refused.body.error?.details], [409, "agent_not_runnable", why, { unbound: [], missing: {}, harness: "claude-agent" }], JSON.stringify(refused.body));
  assert.deepEqual([(await api("GET", `/runs/${stopped}`)).body.status, (await api("GET", `/runs/${stopped}`)).body.state], ["input_required", "idle"]);
});
