// A purged run's learned workflows leave every tree its purge rewrites (learn/purge.ts: each workflow file whose bytes
// the run's merge changed last), and every read still refuses one whose workflow.json a purged run wrote
// (purged-workflow.ts). A run of the agent merged two workflows ("answer" and "solo", each README.md with its
// description) and their promotion records name its merge; another run revised both of answer's files after it. After
// the purge:
//   - main no longer holds solo: both its files read 404 and the learning view lists it no more;
//   - the champion read by digest (GET .../promotions) reads no commit for either;
//   - the revisions of "answer" leave the purged run's out, and the other run's merge diff serves each file of the
//     purged run's workflows against nothing (its text as an added file), never the purged text it replaced;
//   - the agent's next run is not served solo: the agent takes it, as with no champion.
// And the same once the purged merge is older than the log's newest 200 changes; a repeat DELETE takes no workflow
// another run wrote since. A held revision the purged run wrote is never the next run's compile ask.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
/** The commit of main carrying run `runId`'s Run-Id trailer: a merge's own after a purge rewrote the history. */
const mergeOf = (data, agentId, runId) => git(repoOf(data, agentId), ["log", "-1", "--format=%H", `--grep=^Run-Id: ${runId}$`, "main"]);

/** `text`, an added file, as git's unified diff writes it, hunks only. */
const added = (text) => {
  const lines = text.split("\n");
  const end = text.endsWith("\n") ? "" : "\\ No newline at end of file\n";
  if (text.endsWith("\n")) lines.pop();
  return `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n${lines.map((one) => `+${one}\n`).join("")}${end}`;
};

const digestOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const readmeOf = (name, description = "Answers a question; use when asked") => ({ path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: ${description}\n---\n` });
/** answerFlow on another input (`topic`), so no run here fits it: only "solo" can serve a run first. */
const topicFlow = (instructions) => {
  const flow = answerFlow(instructions);
  return { ...flow, schemas: { ...flow.schemas, In: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } } } };
};

test("a purge takes the purged run's workflow off main: both its files read 404, the view drops it, the champion read reads no commit, a later merge's diff serves each of its files against nothing, and the agent's next run is not served it; also once its merge is older than the log's 200 changes, and a repeat DELETE takes no later run's workflow", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-FLOW-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  const gone = (await startRun(api, "keeper", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, gone);
  const other = await started(api, "keeper", "What is three?");
  await ended(api, other);

  const answerPath = "workflows/answer/workflow.json";
  const soloPath = "workflows/solo/workflow.json";
  const answerReadme = "workflows/answer/README.md";
  const soloReadme = "workflows/solo/README.md";
  const v1 = JSON.stringify(topicFlow(`Answer by topic, ${mark}.`));
  const v2 = JSON.stringify(topicFlow("Answer by topic, in whole numbers."));
  const solo = JSON.stringify(answerFlow(`Answer the question alone, ${mark}.`));
  // Each README.md the purged run wrote says the mark in its description; the other run's of answer replaces it, so its
  // merge diff shows the purged run's README lines it replaced.
  const said = (name) => readmeOf(name, `Answers a question, ${mark}; use when asked`);
  const answerSaid = readmeOf("answer", "Answers by topic in whole numbers; use when asked");
  const merge = await learned(data, "keeper", (learning) => learningCommit(learning, { runId: gone, round: 7, reason: "It learned two workflows.", files: [{ path: answerPath, text: v1 }, said("answer"), { path: soloPath, text: solo }, said("solo")] }));
  const next = await learned(data, "keeper", (learning) => learningCommit(learning, { runId: other, round: 2, reason: "It answers in whole numbers.", files: [{ path: answerPath, text: v2 }, answerSaid] }));
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
    const fileOf = async (path) => {
      const file = await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(path)}`);
      return file.status === 200 ? { status: 200, holds: JSON.stringify(file.body).includes(mark) } : { status: file.status, code: file.body?.error?.code };
    };
    const view = (await api("GET", "/agents/keeper/learning")).body;
    const listed = new Set(view.workflows.map(({ name }) => name));
    const promotions = (await api("GET", "/agents/keeper/learning/promotions")).body;
    const championOf = (workflow) => promotions.serving.find((line) => line.workflow === workflow)?.champion?.commit ?? null;
    const revisions = await api("GET", "/agents/keeper/learning/workflows/answer/revisions");
    const diff = (await api("GET", `/runs/${other}/learning/diff`)).body;
    return {
      file: await fileOf(soloPath),
      readme: await fileOf(soloReadme),
      view: { answer: listed.has("answer"), solo: listed.has("solo"), holds: JSON.stringify(view).includes(mark) },
      champion: { answer: championOf("answer"), solo: championOf("solo") },
      revisions: revisions.status === 200 ? revisions.body.revisions.map(({ commit }) => commit) : revisions.status,
      diff: { holds: JSON.stringify(diff).includes(mark), answer: diff.files.find(({ path }) => path === answerPath), readme: diff.files.find(({ path }) => path === answerReadme) },
      runner: await nextRun(question),
    };
  };

  const before = await reads("What is six times seven?");
  assert.deepEqual([before.file, before.readme], [{ status: 200, holds: true }, { status: 200, holds: true }], "before the purge, the file read serves both of solo's files");
  assert.deepEqual(before.view, { answer: true, solo: true, holds: true }, "before the purge, the view lists solo with its description");
  assert.deepEqual(before.champion, { answer: merge, solo: merge }, "each champion is read at the purged run's merge");
  assert.deepEqual(before.revisions, [merge, next]);
  assert.equal(before.diff.holds, true, "the other run's diff shows the text it replaced");
  assert.equal(before.runner, digestOf(solo), "the agent's next run is served solo first");

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  // The purge rewrote the history (learn/purge.ts): the other run's merge is the commit carrying its Run-Id now.
  const nextNow = mergeOf(data, "keeper", other);
  assert.notEqual(nextNow, next, "the purge rewrote the other run's merge");
  const missing = { status: 404, code: "not_found" };
  const refused = {
    file: missing,
    readme: missing,
    view: { answer: true, solo: false, holds: false },
    champion: { answer: null, solo: null },
    revisions: [nextNow],
    diff: { holds: false, answer: { path: answerPath, status: "added", patch: added(v2) }, readme: { path: answerReadme, status: "added", patch: added(answerSaid.text) } },
    runner: null,
  };
  const purged = await reads("What is seven times six?");

  // 200 changes after it: the purged merge is older than the log's window, and every read still refuses it.
  for (let i = 0; i < 200; i++) {
    await learned(data, "keeper", (learning) => learningCommit(learning, { runId: `filler-${i}`, reason: `Filler ${i}.`, files: [{ path: "workflows/filler/workflow.json", text: JSON.stringify(topicFlow(`Filler ${i}.`)) }, ...(i ? [] : [readmeOf("filler")])] }));
  }
  const snapshot = JSON.parse(await readFile(join(repoOf(data, "keeper"), ".agentrun", "snapshot.json"), "utf8"));
  assert.deepEqual([snapshot.log.length, snapshot.log_more, snapshot.log.some(({ commit }) => commit === merge || commit === next || commit === nextNow)], [200, true, false], "the purged merge and the next are out of the log's window");
  const old = await reads("What is two times twenty-one?");
  // One assertion over both, so each read that serves the text shows: after the purge, and older than the window (where
  // no revision of answer is left in the log: 404).
  assert.deepEqual({ purged, old }, { purged: refused, old: { ...refused, revisions: 404 } }, "every read refuses the purged run's workflow");
  const soloOnMain = () => git(repoOf(data, "keeper"), ["ls-tree", "-r", "--name-only", "main", "workflows/solo/"]);
  assert.equal(soloOnMain(), "", "main no longer holds solo: the purge took both its files off");

  // A later run learns solo again: a repeat DELETE finds the purge marked and takes none of it.
  await learned(data, "keeper", (learning) => learningCommit(learning, { runId: "later", reason: "It learned solo again.", files: [{ path: soloPath, text: JSON.stringify(answerFlow("Answer it alone.")) }, readmeOf("solo")] }));
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(soloOnMain(), `${soloReadme}\n${soloPath}`, "a repeat DELETE leaves the later run's solo on main");
});

// A merge that moved main and stopped before it replaced the folder's snapshot leaves a snapshot behind main, which
// names none of that merge's workflows: the purge reads main's own, so it still takes the run's workflow off.
test("a purge takes the run's workflow off main when the folder's snapshot is behind main: a merge that stopped before its snapshot", { timeout: 300_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "behind", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "behind", "What is three?");
  await ended(api, gone);
  await learned(data, "behind", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(answerFlow()) }, readmeOf("answer")] }));
  const repo = repoOf(data, "behind");
  const snapshotFile = join(repo, ".agentrun", "snapshot.json");
  const behind = await readFile(snapshotFile);
  await learned(data, "behind", (learning) => learningCommit(learning, { runId: gone, reason: "It learned solo.", files: [{ path: "workflows/solo/workflow.json", text: JSON.stringify(answerFlow("Answer it alone.")) }, readmeOf("solo")] }));
  await writeFile(snapshotFile, behind);
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(git(repo, ["ls-tree", "-r", "--name-only", "main", "workflows/"]), "workflows/answer/README.md\nworkflows/answer/workflow.json", "main holds the other run's workflow alone");
});

// The review's trace: run P's merge revises `answer`, its promotion check holds it, then P is purged; run Q ends and
// `answer` fits Q's input. The compile ask Q builds (runner/learning-end.ts compileAskOf) revises a held workflow from
// main's text, so once P's purge takes `answer` off main it never holds P's text. The champion before P is still read
// at its record's commit, moved to the commit the purge rewrote it to.
test("the next run's compile ask never holds a held revision a purged run wrote: the purge took it off main", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-HELD-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "holder", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "holder", "What is three?");
  await ended(api, gone);
  const q = await started(api, "holder", "What is four?");
  await ended(api, q);

  const path = "workflows/answer/workflow.json";
  const v1 = JSON.stringify(answerFlow("Answer the question."));
  const v2 = JSON.stringify(answerFlow(`Answer the question, ${mark}.`));
  const champion = await learned(data, "holder", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: [{ path, text: v1 }, readmeOf("answer")] }));
  const revised = await learned(data, "holder", (learning) => learningCommit(learning, { runId: gone, reason: "It revised answer.", files: [{ path, text: v2 }] }));
  const at = new Date().toISOString();
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, alone: 4, agreed: 2 };
  await store.settings.put("learning.promotions.holder", { v: 1, items: [
    { workflow: "answer", digest: digestOf(v1), at, decided: "promote", reason: "checked: promoted", commit: champion },
    { workflow: "answer", digest: digestOf(v2), at, decided: "hold", reason: "checked: held", commit: revised, check },
  ] });

  const { compileAskOf } = await import("../dist/runner/learning-end.js");
  /** The compile ask run Q builds at its end, and the champion the promotions read names for `answer`. */
  const asked = async () => {
    const ask = await compileAskOf({ store, data, learningStore: (agentId) => learningStoreOf(data, agentId) }, { runId: q, agentId: "holder", outcome: "completed", refuse: [], input: { content: "What is four?", question: "What is four?" }, seedWorkflows: 1 });
    const promotions = (await api("GET", "/agents/holder/learning/promotions")).body;
    return { revise: ask?.mode === "revise" ? ask.workflow : null, holds: JSON.stringify(ask ?? null).includes(mark), champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null };
  };
  assert.deepEqual(await asked(), { revise: "answer", holds: true, champion }, "before the purge, Q's ask revises answer from the purged run's text");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual(await asked(), { revise: null, holds: false, champion: mergeOf(data, "holder", first) }, "after the purge, Q's ask holds none of the purged run's text, and the champion before it is still read");
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
