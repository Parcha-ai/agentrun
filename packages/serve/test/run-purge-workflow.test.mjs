// A learned workflow whose text a purged run wrote is refused by every read (purged-workflow.ts): never served or
// executed. A run of the agent merged two workflows ("answer" and "solo") and their promotion records name its merge;
// another run revised "answer" after it; "solo" stays on main as the purged run left it (a purge takes the run's
// corrections and reasons out of the history, learn/purge.ts, and leaves its workflows' text to this refusal). After the
// purge:
//   - the learned file read of solo's workflow.json is 410 purged, the run's tombstone, as every route of the run is;
//   - the champion read by digest (GET .../promotions) reads no commit for either;
//   - the revisions of "answer" leave the purged run's out, and the other run's merge diff serves the file against
//     nothing (its text as an added file), never the purged text it replaced;
//   - the agent's next run is not served solo (its seed leaves it out): the agent takes it, as with no champion.
// And the same once the purged merge is older than the log's newest 200 changes.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { learningCommit } from "../dist/learn/commit.js";
import { learningStoreOf } from "../dist/learn/store-of.js";
import { launchBody } from "../dist/run-launch.js";
import { ended, git, repoOf, started } from "./learn-support.mjs";
import { answerFlow, serve, startRun } from "./support.mjs";

/** `write` over agent `agentId`'s learning store on this server (learn/store-of.ts), as a run's merge writes it: its
 *  commit. */
async function learned(data, agentId, write) {
  const done = await write(learningStoreOf(data, agentId));
  assert.equal(done.ok, true, JSON.stringify(done));
  return done.commit;
}

/** `text`, an added file, as git's unified diff writes it, hunks only. */
const added = (text) => {
  const lines = text.split("\n");
  const end = text.endsWith("\n") ? "" : "\\ No newline at end of file\n";
  if (text.endsWith("\n")) lines.pop();
  return `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n${lines.map((one) => `+${one}\n`).join("")}${end}`;
};

const digestOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const readmeOf = (name) => ({ path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: Answers a question; use when asked\n---\n` });
/** answerFlow on another input (`topic`), so no run here fits it: only "solo" can serve a run first. */
const topicFlow = (instructions) => {
  const flow = answerFlow(instructions);
  return { ...flow, schemas: { ...flow.schemas, In: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } } } };
};

test("every read of a purged run's workflow refuses it: the file read is 410, the champion read reads no commit, a later merge's diff serves the file against nothing, and the agent's next run is not served it; also once its merge is older than the log's 200 changes", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-FLOW-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  const gone = (await startRun(api, "keeper", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, gone);
  const other = await started(api, "keeper", "What is three?");
  await ended(api, other);

  const answerPath = "workflows/answer/workflow.json";
  const soloPath = "workflows/solo/workflow.json";
  const v1 = JSON.stringify(topicFlow(`Answer by topic, ${mark}.`));
  const v2 = JSON.stringify(topicFlow("Answer by topic, in whole numbers."));
  const solo = JSON.stringify(answerFlow(`Answer the question alone, ${mark}.`));
  const merge = await learned(data, "keeper", (learning) => learningCommit(learning, { runId: gone, round: 7, reason: "It learned two workflows.", files: [{ path: answerPath, text: v1 }, readmeOf("answer"), { path: soloPath, text: solo }, readmeOf("solo")] }));
  const next = await learned(data, "keeper", (learning) => learningCommit(learning, { runId: other, round: 2, reason: "It answers in whole numbers.", files: [{ path: answerPath, text: v2 }] }));
  // The other run's second look-back kept its merge (as its end keeps it): GET /runs/{id}/learning/diff reads it.
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 5_000 });
  try {
    db.prepare("INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, created_at) VALUES (?, 2, 'keeper', '{}', ?, ?)").run(other, JSON.stringify({ state: "merged", merged: next }), Date.now());
  } finally {
    db.close();
  }
  const record = (workflow, digest) => ({ workflow, digest, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", commit: merge });
  await store.settings.put("learning.promotions.keeper", { v: 1, items: [record("answer", digestOf(v1)), record("solo", digestOf(solo))] });

  /** A run of the agent on an input solo takes: the learned workflow it was served first (its digest), or null. */
  const nextRun = async (question) => {
    const run = await api("POST", "/agents/keeper/runs", { input: { content: question, question } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await ended(api, run.body.run_id);
    return (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null;
  };
  /** Each read of the two workflows, as a person or the agent's next run reads them. */
  const reads = async (question) => {
    const file = await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(soloPath)}`);
    const promotions = (await api("GET", "/agents/keeper/learning/promotions")).body;
    const championOf = (workflow) => promotions.serving.find((line) => line.workflow === workflow)?.champion?.commit ?? null;
    const revisions = await api("GET", "/agents/keeper/learning/workflows/answer/revisions");
    const diff = (await api("GET", `/runs/${other}/learning/diff`)).body;
    return {
      file: file.status === 200 ? { status: 200, holds: JSON.stringify(file.body).includes(mark) } : { status: file.status, code: file.body?.error?.code, run: file.body?.error?.details?.run_id },
      champion: { answer: championOf("answer"), solo: championOf("solo") },
      revisions: revisions.status === 200 ? revisions.body.revisions.map(({ commit }) => commit) : revisions.status,
      diff: { holds: JSON.stringify(diff).includes(mark), answer: diff.files.find(({ path }) => path === answerPath) },
      runner: await nextRun(question),
    };
  };

  const before = await reads("What is six times seven?");
  assert.deepEqual(before.file, { status: 200, holds: true }, "before the purge, the file read serves solo");
  assert.deepEqual(before.champion, { answer: merge, solo: merge }, "each champion is read at the purged run's merge");
  assert.deepEqual(before.revisions, [merge, next]);
  assert.equal(before.diff.holds, true, "the other run's diff shows the text it replaced");
  assert.equal(before.runner, digestOf(solo), "the agent's next run is served solo first");

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  // The purge rewrote the history (learn/purge.ts): the other run's merge is the commit carrying its Run-Id now.
  const nextNow = git(repoOf(data, "keeper"), ["log", "-1", "--format=%H", `--grep=^Run-Id: ${other}$`, "main"]);
  assert.notEqual(nextNow, next, "the purge rewrote the other run's merge");
  const refused = {
    file: { status: 410, code: "purged", run: gone },
    champion: { answer: null, solo: null },
    revisions: [nextNow],
    diff: { holds: false, answer: { path: answerPath, status: "added", patch: added(v2) } },
    runner: null,
  };
  const purged = await reads("What is seven times six?");

  // 200 changes after it: the purged merge is older than the log's window, and every read still refuses it.
  for (let i = 0; i < 200; i++) {
    await learned(data, "keeper", (learning) => learningCommit(learning, { runId: `filler-${i}`, reason: `Filler ${i}.`, files: [{ path: "workflows/filler/workflow.json", text: JSON.stringify(topicFlow(`Filler ${i}.`)) }, ...(i ? [] : [readmeOf("filler")])] }));
  }
  const snapshot = JSON.parse(await readFile(join(repoOf(data, "keeper"), ".agentrun", "snapshot.json"), "utf8"));
  assert.deepEqual([snapshot.log.length, snapshot.log_more, snapshot.log.some(({ commit }) => commit === merge || commit === next || commit === nextNow)], [200, true, false], "the purged merge and the next are out of the log's window");
  assert.equal(git(repoOf(data, "keeper"), ["show", `main:${soloPath}`]), solo, "main still holds solo as the purged run left it");
  const old = await reads("What is two times twenty-one?");
  // One assertion over both, so each read that serves the text shows: after the purge, and older than the window (where
  // no revision of answer is left in the log: 404).
  assert.deepEqual({ purged, old }, { purged: refused, old: { ...refused, revisions: 404 } }, "every read refuses the purged run's workflow");
});

// The champion a start delivers is read at its promotion record's commit, older than the start's seed; the start keeps
// the run that wrote it, so a record dropped since (as the kept records' cap drops one) never lets it through, nor a
// purge through DELETE /runs/{id}, which rewrites the history the start read it from (learn/purge.ts).
for (const via of ["the store's purge", "DELETE /runs/{id}, the history rewritten"]) test(`an SDK start sent again never answers a workflow a purged run wrote (${via}): its receipt is 410 purged, its champion record gone or not, and a new start pins none`, async (t) => {
  const { api, data, store } = await serve(t, { runner: false });
  const id = "sdk-purged";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const flowOf = (deadline) => ({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: deadline } });
  const [v1, v2] = [JSON.stringify(flowOf(5)), JSON.stringify(flowOf(9))];
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  const first = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const { revisionId } = await store.runs.get(first.body.run_id);
  /** A run of the agent, ended (so a purge may take it). */
  const endedRun = async (runId) => {
    await store.runs.create({ id: runId, agentId: id, revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
    await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
  };
  const writer = "sdk-writer";
  await endedRun(writer);
  await endedRun("sdk-other");
  const merge = await learned(data, id, (learning) => learningCommit(learning, { runId: writer, reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text: v1 }, { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" }] }));
  const next = await learned(data, id, (learning) => learningCommit(learning, { runId: "sdk-other", reason: "It waits longer.", files: [{ path: "workflows/status/workflow.json", text: v2 }] }));
  const record = (digest, decided, commit) => ({ workflow: "status", digest, at: new Date().toISOString(), decided, reason: `checked: ${decided}`, commit });
  await store.settings.put(`learning.promotions.${id}`, { v: 1, items: [record(digestOf(v1), "promote", merge), record(digestOf(v2), "hold", next)] });
  const start = async (key) => {
    const res = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": key });
    return res.status === 201 ? { status: 201, workflows: res.body.learning.workflows.map(({ workflow }) => digestOf(workflow)) } : { status: res.status, code: res.body?.error?.code, run: res.body?.error?.details?.run_id };
  };
  assert.deepEqual(await start("pinned"), { status: 201, workflows: [digestOf(v1)] }, "before the purge, a start pins the champion, read at its record's commit");
  if (via.startsWith("DELETE")) {
    assert.equal((await api("DELETE", `/runs/${writer}`)).status, 204);
    assert.equal(git(repoOf(data, id), ["log", "--format=%H", "main"]).split("\n").includes(merge), false, "the purge rewrote the commit the start read");
  } else await store.runs.purge(writer, { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  const again = await start("pinned");
  await store.settings.put(`learning.promotions.${id}`, { v: 1, items: [record(digestOf(v2), "hold", next)] });
  const refused = { status: 410, code: "purged", run: writer };
  assert.deepEqual({ again, dropped: await start("pinned"), fresh: await start("fresh") }, { again: refused, dropped: refused, fresh: { status: 201, workflows: [] } }, "the receipt sent again and a new start refuse the purged run's workflow");
});
