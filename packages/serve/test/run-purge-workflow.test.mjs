// A purged run's learned workflows (DELETE /v2/runs/{id}, agent-delete.ts purgeRun; Store.learning purgeRun): every item
// version the run wrote is deleted, so each workflow it wrote reads as the version before its own (none: it is gone),
// and a later run's version stays; the promotion records of a version it alone wrote go with it, so the champion before
// serves again; its saves stay as the host's with no text, and no read (the view, the files, the log, a workflow's
// revisions, a run's diff, the promotions read, the cost read, a compile ask, the workflow a run is served) holds any of
// its text. There is no purge gate: nothing of a purged run is left to refuse.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { learningCommit } from "../dist/learn/commit.js";
import { learningOf } from "../dist/learn/rows.js";
import { launchBody } from "../dist/run-launch.js";
import { ended, learningAt, learningText, putLearning, started } from "./learn-support.mjs";
import { putPromotions } from "./learned-workflow-seed-support.mjs";
import { storeOn } from "./store-helpers.mjs";
import { agent, answerFlow, serve, startRun } from "./support.mjs";

/** `write` over agent `agentId`'s learning in the server's store, as a run's merge writes it: its save's id. */
async function learned(store, agentId, write) {
  const done = await write(learningOf(store, agentId));
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
const readmeOf = (name, description = "Answers a question; use when asked") => ({ path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: ${description}\n---\n` });
/** answerFlow on another input (`topic`), so no run here fits it: only "solo" can serve a run first. */
const topicFlow = (instructions) => {
  const flow = answerFlow(instructions);
  return { ...flow, schemas: { ...flow.schemas, In: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } } } };
};

/** Workflow `answer` as a run writes it: its README.md and its workflow.json, each saying `said`, by path. */
const answerAt = (said) => ({ "workflows/answer/README.md": readmeOf("answer", `Answers a question, ${said}; use when asked`).text, "workflows/answer/workflow.json": JSON.stringify(answerFlow(`Answer the question, ${said}.`)) });
const filesOf = (said) => Object.entries(answerAt(said)).map(([path, text]) => ({ path, text }));
/** Workflow `name`'s files in agent `agentId`'s learning now, by path, and the newest save's id. */
const onMain = async (store, agentId, name = "answer") => {
  const { view, text } = await learningAt(store, agentId);
  const paths = [`workflows/${name}/README.md`, `workflows/${name}/workflow.json`];
  return { files: Object.fromEntries(paths.flatMap((path) => (text(path) === undefined ? [] : [[path, text(path)]]))), main: view?.main ?? null };
};
/** Agent `agentId`'s learning rows, read whole (learningText), with its newest save's id: what a DELETE again must leave. */
const heldOf = async (store, agentId) => ({ main: (await store.learning.newest(agentId))?.save.id ?? null, text: await learningText(store, agentId) });

/** Runs `runIds` of agent `agentId` (made, learning, when `make`), each ended, so a DELETE purges it: no runner. */
async function endedRuns(api, store, agentId, runIds, make = true) {
  if (make) assert.equal((await api("POST", "/agents", agent(agentId, { learning: true }))).status, 201);
  const revisionId = (await store.agents.get(agentId)).currentRevision;
  for (const runId of runIds) {
    await store.runs.create({ id: runId, agentId, revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
    await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
  }
}

/** A promotion record of `workflow` at `digest`, decided `decided`, read at save `commit`. */
const recordOf = (workflow, digest, decided, commit, extra = {}) => ({ workflow, digest, at: new Date().toISOString(), decided, reason: `checked: ${decided === "promote" ? "promoted" : decided}`, ...(commit ? { commit } : {}), ...extra });

/** Agent `agentId`'s champion of `answer` as the promotions read names it (its save, or null), and the digest a run that
 *  fits `answer` is served first (null: the agent takes it). */
const servedNow = async (api, store, agentId, question) => {
  const promotions = (await api("GET", `/agents/${agentId}/learning/promotions`)).body;
  const run = await api("POST", `/agents/${agentId}/runs`, { input: { content: question, question } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await ended(api, run.body.run_id);
  return { champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null, served: (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null };
};

test("a purge takes the purged run's workflow out of the learning: both its files read 404, the view drops it, the champion read reads no save, a later merge's diff serves each of its files against nothing, and the agent's next run is not served it; a repeat DELETE takes no later run's workflow", { timeout: 300_000 }, async (t) => {
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
  const merge = await learned(store, "keeper", (learning) => learningCommit(learning, { runId: gone, round: 7, reason: "It learned two workflows.", files: [{ path: answerPath, text: v1 }, said("answer"), { path: soloPath, text: solo }, said("solo")] }));
  const next = await learned(store, "keeper", (learning) => learningCommit(learning, { runId: other, round: 2, reason: "It answers in whole numbers.", files: [{ path: answerPath, text: v2 }, answerSaid] }));
  // The other run's second look-back kept its merge (as its end keeps it): GET /runs/{id}/learning/diff reads it.
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 5_000 });
  try {
    db.prepare("INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, created_at) VALUES (?, 2, 'keeper', '{}', ?, ?)").run(other, JSON.stringify({ state: "merged", merged: next }), Date.now());
  } finally {
    db.close();
  }
  await putPromotions(store, "keeper", [recordOf("answer", digestOf(v1), "promote", merge), recordOf("solo", digestOf(solo), "promote", merge)]);

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
  assert.equal(before.diff.holds, true, "the other run's diff shows the text it replaced");
  assert.equal(before.runner, digestOf(solo), "the agent's next run is served solo first");

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  const missing = { status: 404, code: "not_found" };
  assert.deepEqual(await reads("What is seven times six?"), {
    file: missing,
    readme: missing,
    view: { answer: true, solo: false, holds: false },
    champion: { answer: null, solo: null },
    revisions: [next],
    diff: { holds: false, answer: { path: answerPath, status: "added", patch: added(v2) }, readme: { path: answerReadme, status: "added", patch: added(answerSaid.text) } },
    runner: null,
  }, "every read leaves the purged run's workflow out");
  assert.ok(!(await learningText(store, "keeper")).includes(mark), "no learning row holds its text");
  assert.deepEqual((await onMain(store, "keeper", "solo")).files, {}, "the learning no longer holds solo");

  // A later run learns solo again: a repeat DELETE finds nothing of the purged run's and takes none of it.
  await endedRuns(api, store, "keeper", ["later"], false);
  const again = JSON.stringify(answerFlow("Answer it alone."));
  await learned(store, "keeper", (learning) => learningCommit(learning, { runId: "later", reason: "It learned solo again.", files: [{ path: soloPath, text: again }, readmeOf("solo")] }));
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual((await onMain(store, "keeper", "solo")).files, { [soloReadme]: readmeOf("solo").text, [soloPath]: again }, "a repeat DELETE leaves the later run's solo");

  // The revisions read, oldest first, as its route says: the purged run's revision, then the other run's.
  assert.deepEqual(before.revisions, [merge, next], "before the purge, answer's revisions are the purged run's and the other run's, oldest first");
});

// A purge takes out only what the purged run's versions put there. Run `first` wrote `answer` v1, promoted; run `gone`
// revised it to v2 (both its files), and the promotion check held v2, so v1 kept serving. The purge of `gone` leaves v1
// as `first` wrote it: the view lists it with v1's description, a run that fits it is served v1, the promotions read
// still names v1's save as champion, and the compile ask the next run builds (runner/learning-end.ts compileAskOf) holds
// none of `gone`'s text. A repeat DELETE changes nothing.
test("a purge leaves the version another run wrote before the purged run's held revision: the learning holds it as that run wrote it, the view lists it, a run that fits it is served it, its champion is still read, no compile ask holds the purged text; a repeat DELETE changes nothing", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-HELD-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "holder", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "holder", "What is three?");
  await ended(api, gone);
  const q = await started(api, "holder", "What is four?");
  await ended(api, q);
  const replayed = await started(api, "holder", "What is five?");
  await ended(api, replayed);

  const path = "workflows/answer/workflow.json";
  const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
  const champion = await learned(store, "holder", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
  const revised = await learned(store, "holder", (learning) => learningCommit(learning, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
  // Run `replayed` merged a round on top of `gone`'s that left answer alone, and stopped before its end: its replayed
  // ask reads the learning as that merge read it, its parent, where answer was `gone`'s v2.
  await learned(store, "holder", (learning) => learningCommit(learning, { runId: replayed, round: 3, reason: "It learned other.", files: [{ path: "workflows/other/workflow.json", text: JSON.stringify(topicFlow("Answer by topic.")) }, readmeOf("other")] }));
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, alone: 4, agreed: 2 };
  await putPromotions(store, "holder", [recordOf("answer", digestOf(v1[path]), "promote", champion), recordOf("answer", digestOf(v2[path]), "hold", revised, { check })]);

  const { compileAskOf } = await import("../dist/runner/learning-end.js");
  /** The compile ask run Q builds at its end, the one `replayed` builds again for its round, and the champion the
   *  promotions read names for `answer`. */
  const asked = async () => {
    const askOf = (runId, round) => compileAskOf({ store, data }, { runId, agentId: "holder", outcome: "completed", refuse: [], input: { content: "What is four?", question: "What is four?" }, seedWorkflows: 1, ...(round ? { round } : {}) });
    const ask = await askOf(q);
    const replay = await askOf(replayed, 3);
    const promotions = (await api("GET", "/agents/holder/learning/promotions")).body;
    return { revise: ask?.mode === "revise" ? ask.workflow : null, holds: JSON.stringify(ask ?? null).includes(mark), replay: JSON.stringify(replay ?? null).includes(mark), champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null };
  };
  /** What a person and the agent's next run read of `answer`: the view's line, the file read, and the digest served. */
  const reads = async (question) => {
    const view = (await api("GET", "/agents/holder/learning")).body.workflows.find(({ name }) => name === "answer");
    const file = await api("GET", `/agents/holder/learning/files/${encodeURIComponent(path)}`);
    const run = await api("POST", "/agents/holder/runs", { input: { content: question, question } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await ended(api, run.body.run_id);
    return { description: view?.description ?? null, file: file.status === 200 ? JSON.stringify(file.body) : file.status, served: (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null };
  };
  assert.deepEqual(await asked(), { revise: "answer", holds: true, replay: true, champion }, "before the purge, Q's ask and the replayed one revise answer from the purged run's text");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual((await onMain(store, "holder")).files, v1, "the learning holds answer v1, both files as `first` wrote them");
  const purged = await asked();
  assert.equal(purged.holds, false, "after the purge, Q's ask holds none of the purged run's text");
  assert.equal(purged.replay, false, "after the purge, the replayed ask, read at its merge's parent, holds none of the purged run's text");
  assert.equal(purged.champion, champion, "the promotions read still names v1's save as champion");
  assert.ok(!(await learningText(store, "holder")).includes(mark), "no learning row holds the purged text");
  assert.deepEqual(await reads("What is six times seven?"), { description: "Answers a question, in whole numbers; use when asked", file: v1[path], served: digestOf(v1[path]) }, "the view lists answer with v1's description, the file read serves v1, and a run that fits it is served v1");

  // A repeat DELETE changes no learning row, and v1 still serves.
  const before = await heldOf(store, "holder");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual(await heldOf(store, "holder"), before, "a repeat DELETE changes nothing");
  assert.equal((await reads("What is seven times six?")).served, digestOf(v1[path]), "v1 still serves after the repeat DELETE");
});

// A purged run that revised a workflow and put its earlier bytes back in a later round: both its versions go, so the
// version `first` wrote is the one left: the file reads 200, a run that fits it is served v1, and a repeat DELETE changes
// nothing.
test("a purge of a run that put a workflow's earlier bytes back leaves the earlier run's version: v1 reads and serves", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-UNDONE-${randomBytes(6).toString("hex")}`;
  const { api, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "undone", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "undone", "What is three?");
  await ended(api, gone);
  const path = "workflows/answer/workflow.json";
  const v1 = answerAt("in whole numbers");
  const champion = await learned(store, "undone", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
  await learned(store, "undone", (learning) => learningCommit(learning, { runId: gone, round: 1, reason: "It revised answer.", files: filesOf(mark) }));
  await learned(store, "undone", (learning) => learningCommit(learning, { runId: gone, round: 2, reason: "It put answer back.", files: filesOf("in whole numbers") }));
  await putPromotions(store, "undone", [recordOf("answer", digestOf(v1[path]), "promote", champion)]);
  const reads = async (question) => {
    const file = await api("GET", `/agents/undone/learning/files/${encodeURIComponent(path)}`);
    const now = await servedNow(api, store, "undone", question);
    return { file: file.status === 200 ? JSON.stringify(file.body) : `${file.status} ${file.body?.error?.code}`, served: now.served, champion: now.champion };
  };
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual((await onMain(store, "undone")).files, v1, "the learning holds answer v1, as `first` wrote it");
  assert.ok(!(await learningText(store, "undone")).includes(mark), "no learning row holds the purged text");
  assert.deepEqual(await reads("What is six times seven?"), { file: v1[path], served: digestOf(v1[path]), champion }, "after the purge, the file read serves v1 and a run that fits it is served v1");
  const before = await heldOf(store, "undone");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual(await heldOf(store, "undone"), before, "a repeat DELETE changes nothing");
});

// The purged run's revision was the champion: `first` wrote `answer` v1, promoted; `gone` revised it to v2, promoted
// after it. The purge deletes v2's version and its promotion records (no other run wrote v2), so v1's promote is the
// newest left: the promotions read names v1's save, a run that fits it is served v1, and no byte of `gone`'s text
// reaches a read, a run or a compile ask. A revision another run promotes after the purge wins over v1.
test("a purge of the champion's run leaves the version before it, and the earlier champion serves again: none of the purged text is served, and a later promotion still wins", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-CHAMPION-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "crowned", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "crowned", "What is three?");
  await ended(api, gone);
  const q = await started(api, "crowned", "What is four?");
  await ended(api, q);
  const later = await started(api, "crowned", "What is five?");
  await ended(api, later);

  const path = "workflows/answer/workflow.json";
  const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
  const kept = await learned(store, "crowned", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
  const crowned = await learned(store, "crowned", (learning) => learningCommit(learning, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
  // Each promotion's check, on its own number of inputs, so the cost read names whose it reads.
  const checked = (n) => ({ compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n, alone: n, agreed: n - 1 });
  await putPromotions(store, "crowned", [recordOf("answer", digestOf(v1[path]), "promote", kept, { check: checked(10) }), recordOf("answer", digestOf(v2[path]), "promote", crowned, { check: checked(20) })]);
  const { compileAskOf } = await import("../dist/runner/learning-end.js");
  const reads = async (question) => {
    const view = (await api("GET", "/agents/crowned/learning")).body;
    const files = await Promise.all(Object.keys(v1).map((one) => api("GET", `/agents/crowned/learning/files/${encodeURIComponent(one)}`)));
    const ask = await compileAskOf({ store, data }, { runId: q, agentId: "crowned", outcome: "completed", refuse: [], input: { content: question, question }, seedWorkflows: 1 });
    const now = await servedNow(api, store, "crowned", question);
    return { holds: [view, files.map(({ body }) => body), ask ?? null].some((one) => JSON.stringify(one).includes(mark)), ...now };
  };
  assert.deepEqual(await reads("What is six times seven?"), { holds: true, champion: crowned, served: digestOf(v2[path]) }, "before the purge, v2 is the champion and serves");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual((await onMain(store, "crowned")).files, v1, "the learning holds answer v1, both files as `first` wrote them");
  assert.deepEqual(await reads("What is seven times six?"), { holds: false, champion: kept, served: digestOf(v1[path]) }, "no read, run or compile ask holds v2; the champion read names v1's save, and a run that fits it is served v1");
  // The cost read names the champion left: the serving check is v1's, and v1 serves. The run served v2 before the purge
  // still carries v2's spend, so v2 stays in the bill as a stopped revision at its K (the reset ledger keeps its
  // workflow, digest and K, no text), as a reset's revisions do.
  const cost = (await api("GET", "/agents/crowned/learning/cost")).body;
  const states = Object.fromEntries(cost.bill.revisions.filter(({ workflow }) => workflow === "answer").map(({ digest, state }) => [digest, state]));
  assert.deepEqual({ replay: cost.summary.replay?.n ?? null, states }, { replay: 10, states: { [digestOf(v1[path])]: "serving", [digestOf(v2[path])]: "stopped" } }, "the cost read's serving check is v1's and v1 serves; the purged v2 is stopped, billed to the run it served");
  assert.ok(!JSON.stringify(cost).includes(mark), "the cost read holds none of the purged text");

  // A revision `later` promotes after the purge is the champion over v1.
  const v3 = answerAt("in tens");
  const promoted = await learned(store, "crowned", (learning) => learningCommit(learning, { runId: later, reason: "It revised answer.", files: filesOf("in tens") }));
  await store.learning.addRecord("crowned", "promotion", { runId: null, workflow: "answer", digest: digestOf(v3[path]), data: recordOf("answer", digestOf(v3[path]), "promote", promoted) });
  assert.deepEqual(await reads("What is six times six?"), { holds: false, champion: promoted, served: digestOf(v3[path]) }, "a revision promoted after the purge is the champion and serves, not v1");
});

// A check that outlives the purge: `gone`'s v2 replays on other runs' inputs, so its purge never stops it, and it decides
// after the purge. No version holds v2's digest then (runner/promotion.ts decideCheck): its decision is a hold that says
// its run was purged, never a promote, and v1 still serves.
test("a check that outlives the purge of its revision's run lands no promote for it: the earlier champion still serves", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-LATE-${randomBytes(6).toString("hex")}`;
  const { api, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "late", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "late", "What is three?");
  await ended(api, gone);
  const path = "workflows/answer/workflow.json";
  const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
  const kept = await learned(store, "late", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
  const revised = await learned(store, "late", (learning) => learningCommit(learning, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
  const { promotionOf, promotionsOf } = await import("../dist/learn/promote.js");
  const { decideCheck } = await import("../dist/runner/promotion.js");
  const { secretsShown } = await import("../dist/learning.js");
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const replay = { commit: revised, runs: ["late-replay-1"], replay_id: "late-replay" };
  await putPromotions(store, "late", [recordOf("answer", digestOf(v1[path]), "promote", kept), { ...recordOf("answer", digestOf(v2[path]), "replaying", null, { check: bar, ...replay }), reason: "checking" }]);
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);

  // v2's check lands now, every input answered alone and agreed.
  const rows = ["a", "b", "c", "d", "e"].map((one) => ({ of: `late-input-${one}`, input: "What is six?", agent: "6", outcome: "answered", answer: "6" }));
  const deps = { store, agentId: "late", log: () => {}, shown: async () => secretsShown([]) };
  await decideCheck(deps, "answer", digestOf(v2[path]), bar, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, () => true, replay);
  const late = promotionOf(await promotionsOf(store.learning, "late"), "answer", digestOf(v2[path]));
  assert.equal(late, undefined, "the late check writes nothing for v2: no version holds it");
  assert.deepEqual(await servedNow(api, store, "late", "What is six times seven?"), { champion: kept, served: digestOf(v1[path]) }, "past the late check's write, the champion read names v1's save, and a run that fits it is served v1");
});

// A purged champion that was held since: `gone`'s v2 was promoted, then held (here by this release's DSL; an audit's hold
// is the same record), so nothing served. The purge deletes v2's records with its version, and v1 serves again.
test("a purge of a champion's run that was held since leaves the earlier champion: it serves", { timeout: 300_000 }, async (t) => {
  const mark = `PURGED-REHELD-${randomBytes(6).toString("hex")}`;
  const { api, store } = await serve(t, { learning: "on" });
  const first = (await startRun(api, "reheld", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
  await ended(api, first);
  const gone = await started(api, "reheld", "What is three?");
  await ended(api, gone);
  const path = "workflows/answer/workflow.json";
  const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
  const kept = await learned(store, "reheld", (learning) => learningCommit(learning, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
  const crowned = await learned(store, "reheld", (learning) => learningCommit(learning, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
  const { DSL_REFUSES } = await import("../dist/runner/promotion.js");
  await putPromotions(store, "reheld", [
    recordOf("answer", digestOf(v1[path]), "promote", kept),
    recordOf("answer", digestOf(v2[path]), "promote", crowned),
    { ...recordOf("answer", digestOf(v2[path]), "hold", crowned), reason: `${DSL_REFUSES}: a node it names is gone` },
  ]);
  assert.deepEqual(await servedNow(api, store, "reheld", "What is six times seven?"), { champion: null, served: null }, "before the purge, v2 is held and nothing serves");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.deepEqual((await onMain(store, "reheld")).files, v1, "the learning holds answer v1");
  assert.deepEqual(await servedNow(api, store, "reheld", "What is seven times six?"), { champion: kept, served: digestOf(v1[path]) }, "after the purge of the held champion's run, the champion read names v1's save, and a run that fits it is served v1");
});

// A run purged at the store (Runs.purge, as its DELETE's last step does) takes its learning rows in the same transaction:
// a workflow it alone wrote is gone, so its files read 404 and a person's approval of it finds nothing.
test("a workflow a purged run wrote leaves with its run's purge at the store: its files read 404, and its approval finds nothing to approve", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false });
  await endedRuns(api, store, "raw", ["raw-writer"]);
  const flow = "workflows/drafted/workflow.json";
  const readme = "workflows/drafted/README.md";
  await learned(store, "raw", (learning) => learningCommit(learning, { runId: "raw-writer", reason: "It drafted one.", files: [{ path: flow, text: JSON.stringify(answerFlow("Draft it.")) }, { path: readme, text: "---\nname: drafted\ndescription: Answers a question; use when asked\nstatus: pending\n---\n" }] }));
  const oid = (await learningAt(store, "raw")).view.workflows.find(({ name }) => name === "drafted")?.files.find(({ path }) => path === readme)?.oid;
  assert.ok(oid, "the drafted workflow is in the learning before the purge");
  await store.runs.purge("raw-writer", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  const file = async (path) => {
    const res = await api("GET", `/agents/raw/learning/files/${encodeURIComponent(path)}`);
    return { status: res.status, code: res.body?.error?.code ?? null };
  };
  const { changeWorkflow } = await import("../dist/learning-routes.js");
  const approved = await changeWorkflow(store, "raw", readme, { action: "approve", ifMatch: `"${oid}"`, refuse: [] }).then(() => ({ status: 200 }), (error) => ({ status: error.status, code: error.code }));
  const missing = { status: 404, code: "not_found" };
  assert.deepEqual({ flow: await file(flow), readme: await file(readme), approved }, { flow: missing, readme: missing, approved: missing }, "the purged writer's files read 404, and its approval finds nothing");
  assert.equal((await learningAt(store, "raw")).text(readme), undefined, "nothing approved it");
});

// A check that outlives its revision's run, with the inputs it did not agree on: the run's purge deletes v2 while its
// check replays other runs' inputs, and the check's hold for v2 writes nothing: no version holds v2 then. The next
// run's compile ask asks no revision of the purged v2.
test("a hold a check decides after its revision's run is purged writes nothing and asks no compile of the purged revision", { timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t, { runner: false });
  await endedRuns(api, store, "rehold", ["rehold-first", "rehold-gone", "rehold-next"]);
  const path = "workflows/answer/workflow.json";
  const [v1, v2] = [answerAt("in whole numbers"), answerAt("in words")];
  const kept = await learned(store, "rehold", (learning) => learningCommit(learning, { runId: "rehold-first", reason: "It learned answer.", files: filesOf("in whole numbers") }));
  const revised = await learned(store, "rehold", (learning) => learningCommit(learning, { runId: "rehold-gone", reason: "It revised answer.", files: filesOf("in words") }));
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const replay = { commit: revised, runs: ["rehold-replay-1"], replay_id: "rehold-replay" };
  await putPromotions(store, "rehold", [recordOf("answer", digestOf(v1[path]), "promote", kept), { ...recordOf("answer", digestOf(v2[path]), "replaying", null, { check: bar, ...replay }), reason: "checking" }]);
  assert.equal((await api("DELETE", "/runs/rehold-gone")).status, 204);
  assert.deepEqual((await onMain(store, "rehold")).files, v1, "the learning holds answer v1");

  // v2's check lands now: every input answered, none as the agent did, so it holds with its disagreements.
  const { promotionOf, promotionsOf } = await import("../dist/learn/promote.js");
  const { decideCheck } = await import("../dist/runner/promotion.js");
  const { secretsShown } = await import("../dist/learning.js");
  const { compileAskOf } = await import("../dist/runner/learning-end.js");
  const rows = ["a", "b", "c", "d", "e"].map((one) => ({ of: `rehold-input-${one}`, input: "What is six?", agent: "6", outcome: "answered", answer: "seven" }));
  const deps = { store, agentId: "rehold", log: () => {}, shown: async () => secretsShown([]) };
  await decideCheck(deps, "answer", digestOf(v2[path]), bar, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, () => true, replay);
  assert.equal(promotionOf(await promotionsOf(store.learning, "rehold"), "answer", digestOf(v2[path])), undefined, "the late check's hold for v2 writes nothing");

  const ask = await compileAskOf({ store, data }, { runId: "rehold-next", agentId: "rehold", outcome: "completed", refuse: [], input: { content: "What is six?", question: "What is six?" }, seedWorkflows: 1 });
  assert.equal(ask?.held?.digest ?? null, null, "the next compile ask holds no revision of the purged v2");
});

// A run live across another run's purge (DELETE /v2/runs/{id}): its seed was read before the purge rewrote it, so a file
// its draft gives back unchanged from the seed is the purged run's bytes. Its merge is refused whole (purged_since_seed),
// nothing written; a run seeded after the purge merges.
test("a run seeded before another run's DELETE has its merge refused: nothing of the purged run's text, or its own, is written; a run seeded after merges", { timeout: 120_000 }, async (t) => {
  const mark = `PURGED-SEEDED-${randomBytes(6).toString("hex")}`;
  const { api, store } = await serve(t, { runner: false });
  await endedRuns(api, store, "seeded", ["seeded-gone", "seeded-live", "seeded-after"]);
  const seed = await learned(store, "seeded", (learning) => learningCommit(learning, { runId: "seeded-gone", reason: "It learned answer.", files: filesOf(mark) }));
  assert.equal((await api("DELETE", "/runs/seeded-gone")).status, 204);
  const [readme] = filesOf(mark);
  const before = await heldOf(store, "seeded");
  const done = await learningCommit(learningOf(store, "seeded"), { runId: "seeded-live", reason: "It revised answer.", seed, mustHold: seed, files: [readme, { path: "workflows/answer/workflow.json", text: JSON.stringify(answerFlow("Answer the question, LIVEWORD.")) }], correction: "Use the LIVEWORD rule." });
  assert.deepEqual([done.ok, done.reason], [false, "purged"], JSON.stringify(done));
  assert.deepEqual(await heldOf(store, "seeded"), before, "nothing written");
  assert.doesNotMatch(before.text, new RegExp(`${mark}|LIVEWORD`));
  const after = (await store.learning.newest("seeded")).save.id;
  await learned(store, "seeded", (learning) => learningCommit(learning, { runId: "seeded-after", reason: "It learned answer.", seed: after, files: filesOf("in whole numbers") }));
});

// The production path's scoping: DELETE /v2/runs/{id} (Runs.purge, its agent read from the run's row) takes the run's
// learning rows from its own agent's learning alone. Another agent's rows that name the same run id stay.
test("a run's DELETE takes its learning from its own agent's alone: another agent's rows naming the same run id stay", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false });
  await endedRuns(api, store, "scope-mine", ["scope-run"]);
  await endedRuns(api, store, "scope-theirs", []);
  await learned(store, "scope-mine", (learning) => learningCommit(learning, { runId: "scope-run", reason: "It learned answer.", files: filesOf("MINEWORD"), correction: "MINEWORD line." }));
  await learned(store, "scope-theirs", (learning) => learningCommit(learning, { runId: "scope-run", reason: "It learned answer.", files: filesOf("THEIRWORD"), correction: "THEIRWORD line." }));
  const digest = digestOf(answerAt("THEIRWORD")["workflows/answer/workflow.json"]);
  await putPromotions(store, "scope-theirs", [recordOf("answer", digest, "promote", null)]);
  const theirs = await heldOf(store, "scope-theirs");
  assert.equal((await api("DELETE", "/runs/scope-run")).status, 204);
  assert.doesNotMatch(await learningText(store, "scope-mine"), /MINEWORD/);
  assert.deepEqual(await heldOf(store, "scope-theirs"), theirs, "the other agent's learning is as it was");
  assert.equal((await store.learning.records("scope-theirs", "promotion")).length, 1);
});

// A grade's write that a run's purge overtook (another process purged it past the route's check): the write refuses it
// in its own transaction, nothing kept.
test("a grade written for a run purged since is refused in its own write: nothing is kept", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false });
  await endedRuns(api, store, "graded", ["graded-gone", "graded-live"]);
  const { putGrade, gradesOf } = await import("../dist/learn/promote.js");
  const { LearningRecordRefused } = await import("../dist/store/index.js");
  const grade = (run) => ({ run, correct: false, expected: { answer: "GRADEWORD" }, source: "feedback", at: new Date().toISOString(), path: "agent", feedback: null });
  await store.runs.purge("graded-gone", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  await assert.rejects(putGrade(store.learning, "graded", grade("graded-gone")), LearningRecordRefused);
  await putGrade(store.learning, "graded", grade("graded-live"));
  assert.deepEqual((await gradesOf(store.learning, "graded")).map((one) => one.run), ["graded-live"]);
});

// Over runs that end cheaply (no runner): (c) a workflow the purged run wrote new leaves the learning whole; (d) a later
// run's revision on top of the purged run's stays as it is; (f) two purged runs in a row on one workflow leave the
// version before both, in either order of purge, its writer the run that wrote it.
test("a purge leaves only what no purged run wrote: a new workflow leaves the learning, a later run's revision stays, and two purged runs in a row leave the version before both in either order", { timeout: 300_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const wrote = (agentId, runId, said) => learned(store, agentId, (learning) => learningCommit(learning, { runId, reason: `It wrote ${said}.`, files: filesOf(said) }));
  const purge = async (runId) => assert.equal((await api("DELETE", `/runs/${runId}`)).status, 204);
  /** The run the view names as `answer`'s writer. */
  const writer = async (agentId) => (await learningAt(store, agentId)).view?.workflows.find(({ name }) => name === "answer")?.run ?? null;

  // (c) Written new by the purged run: the whole workflow leaves.
  await endedRuns(api, store, "fresh", ["fresh-gone"]);
  await wrote("fresh", "fresh-gone", "new");
  await purge("fresh-gone");
  assert.deepEqual((await onMain(store, "fresh")).files, {}, "a workflow the purged run wrote new leaves the learning");

  // (d) A later run revised the purged run's version: it stays.
  await endedRuns(api, store, "later", ["later-first", "later-gone", "later-last"]);
  for (const [runId, said] of [["later-first", "v1"], ["later-gone", "v2"], ["later-last", "v3"]]) await wrote("later", runId, said);
  const kept = await onMain(store, "later");
  await purge("later-gone");
  assert.deepEqual((await onMain(store, "later")).files, kept.files, "a later run's v3 stays untouched (the purge's own save is the newest now)");
  assert.deepEqual(kept.files, answerAt("v3"));
  assert.doesNotMatch(await learningText(store, "later"), /question, v2\./, "no learning row holds the purged run's v2");

  // (f) Two purged runs in a row, the newest first: v2 back, then v1.
  await endedRuns(api, store, "twice", ["twice-first", "twice-gone1", "twice-gone2"]);
  for (const [runId, said] of [["twice-first", "v1"], ["twice-gone1", "v2"], ["twice-gone2", "v3"]]) await wrote("twice", runId, said);
  await purge("twice-gone2");
  assert.deepEqual((await onMain(store, "twice")).files, answerAt("v2"), "the purge of gone2 leaves gone1's v2");
  assert.equal(await writer("twice"), "twice-gone1", "v2's writer is gone1");
  await purge("twice-gone1");
  assert.deepEqual((await onMain(store, "twice")).files, answerAt("v1"), "then the purge of gone1 leaves first's v1");
  assert.equal(await writer("twice"), "twice-first");

  // (f) The other order: gone1 first changes nothing seen (gone2 wrote the newest), then gone2 leaves first's v1.
  await endedRuns(api, store, "back", ["back-first", "back-gone1", "back-gone2"]);
  for (const [runId, said] of [["back-first", "v1"], ["back-gone1", "v2"], ["back-gone2", "v3"]]) await wrote("back", runId, said);
  const v3 = await onMain(store, "back");
  await purge("back-gone1");
  assert.deepEqual((await onMain(store, "back")).files, v3.files, "the purge of gone1 leaves gone2's v3");
  await purge("back-gone2");
  assert.deepEqual((await onMain(store, "back")).files, answerAt("v1"), "the purge of gone2 leaves first's v1, never gone1's purged v2");
  assert.equal(await writer("back"), "back-first");
});

// The champion a start delivers is read at its promotion record's save; the receipt names the runs that wrote what it
// delivered, so a start sent again after one of them is purged is refused, and a new start pins none of its text.
test("an SDK start sent again never answers a workflow a purged run wrote: its receipt is 410 purged, and a new start pins none", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = "sdk-purged";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const flowOf = (deadline) => ({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: deadline } });
  const [v1, v2] = [JSON.stringify(flowOf(5)), JSON.stringify(flowOf(9))];
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  const first = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const writer = "sdk-writer";
  await endedRuns(api, store, id, [writer, "sdk-other"], false);
  const merge = await learned(store, id, (learning) => learningCommit(learning, { runId: writer, reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text: v1 }, { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" }] }));
  const next = await learned(store, id, (learning) => learningCommit(learning, { runId: "sdk-other", reason: "It waits longer.", files: [{ path: "workflows/status/workflow.json", text: v2 }, { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" }] }));
  await putPromotions(store, id, [recordOf("status", digestOf(v1), "promote", merge), recordOf("status", digestOf(v2), "hold", next)]);
  const start = async (key) => {
    const res = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": key });
    return res.status === 201 ? { status: 201, workflows: res.body.learning.workflows.map(({ workflow }) => digestOf(workflow)) } : { status: res.status, code: res.body?.error?.code, run: res.body?.error?.details?.run_id };
  };
  assert.deepEqual(await start("pinned"), { status: 201, workflows: [digestOf(v1)] }, "before the purge, a start pins the champion, read at its record's save");
  await store.runs.purge(writer, { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  const refused = { status: 410, code: "purged", run: writer };
  assert.deepEqual({ again: await start("pinned"), fresh: await start("fresh") }, { again: refused, fresh: { status: 201, workflows: [] } }, "the receipt sent again refuses the purged run's workflow, and a new start pins none");
  const { promotionsOf } = await import("../dist/learn/promote.js");
  assert.deepEqual((await promotionsOf(store.learning, id)).map(({ digest, decided }) => [digest, decided]), [[digestOf(v2), "hold"]], "v1's promote went with its run");
});

// A start reads a champion's text at its record's save, then the run that wrote it: two reads. A purge of that run between
// them rewrites the save in place, so the start would deliver the purged text with a receipt naming no run of it.
test("an SDK start whose champion's writer is purged between its text read and its writer read delivers none of the purged run's text", async (t) => {
  const { api, store, data } = await serve(t, { runner: false });
  const id = "sdk-racing";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const flowOf = (deadline) => ({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: deadline } });
  const [v1, v2] = [JSON.stringify(flowOf(5)), JSON.stringify(flowOf(9))];
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" })).status, 201);
  const writer = "sdk-racing-writer";
  await endedRuns(api, store, id, [writer, "sdk-racing-other"], false);
  const readme = { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" };
  const merge = await learned(store, id, (learning) => learningCommit(learning, { runId: writer, reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text: v1 }, readme] }));
  const next = await learned(store, id, (learning) => learningCommit(learning, { runId: "sdk-racing-other", reason: "It waits longer.", files: [{ path: "workflows/status/workflow.json", text: v2 }, readme] }));
  await putPromotions(store, id, [recordOf("status", digestOf(v1), "promote", merge), recordOf("status", digestOf(v2), "hold", next)]);
  // The purge lands right after the selection's first read at the champion's save: its text read, its writer not yet.
  // SdkRuns over this store, whose itemsAt purges the writer at that read (the start's selection, as the route calls it).
  const { SdkRuns } = await import("../dist/sdk/runs.js");
  const { sdkWorkflowManifest } = await import("../dist/sdk/workflows.js");
  let purged = false;
  const learning = Object.create(store.learning, { itemsAt: { value: async (agentId, save) => {
    const at = await store.learning.itemsAt(agentId, save);
    if (!purged && agentId === id && save === merge) {
      purged = true;
      await store.runs.purge(writer, { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
    }
    return at;
  } } });
  const sdk = new SdkRuns(Object.create(store, { learning: { value: learning } }), data, "sdk-secret");
  const selected = await sdk.selectedWorkflows(id, next, sdkWorkflowManifest([tool], undefined));
  assert.ok(purged, "the purge ran inside the selection's reads");
  const delivered = selected.workflows.map((flow) => [digestOf(typeof flow.workflow === "string" ? flow.workflow : JSON.stringify(flow.workflow)), selected.writers.get(flow) ?? null]);
  assert.deepEqual(delivered.filter(([digest]) => digest === digestOf(v1)), [], `the purged run's v1 is not delivered, as no run's or any: ${JSON.stringify(delivered)}`);
});

// A start reads its selection again only when a purge moved under it (only a purge rewrites what it read, in place): a
// normal save during each of its reads (another run's merge) never refuses it.
test("an SDK start whose selection sees a normal save land during every read is not refused: only a purge reads it again", async (t) => {
  const { api, store, data } = await serve(t, { runner: false });
  const id = "sdk-busy";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const v1 = JSON.stringify({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: 5 } });
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" })).status, 201);
  await endedRuns(api, store, id, ["busy-writer"], false);
  const readme = { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" };
  const merge = await learned(store, id, (learning) => learningCommit(learning, { runId: "busy-writer", reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text: v1 }, readme] }));
  await putPromotions(store, id, [recordOf("status", digestOf(v1), "promote", merge)]);
  const { SdkRuns } = await import("../dist/sdk/runs.js");
  const { sdkWorkflowManifest } = await import("../dist/sdk/workflows.js");
  let saves = 0;
  const learning = Object.create(store.learning, { itemsAt: { value: async (agentId, save) => {
    const at = await store.learning.itemsAt(agentId, save);
    // Another run's correction lands: a normal save, the newest moves.
    await learned(store, id, (rows) => learningCommit(rows, { runId: `busy-${++saves}`, reason: "A note.", files: [], correction: `Note ${saves}.` }));
    return at;
  } } });
  const sdk = new SdkRuns(Object.create(store, { learning: { value: learning } }), data, "sdk-secret");
  const selected = await sdk.selectedWorkflows(id, merge, sdkWorkflowManifest([tool], undefined));
  assert.ok(saves > 0, "a save landed during the selection");
  assert.deepEqual(selected.workflows.map((flow) => digestOf(typeof flow.workflow === "string" ? flow.workflow : JSON.stringify(flow.workflow))), [digestOf(v1)], "the start is given the champion");
});

// Row-level cases over the store alone (Store.learning purgeRun), as the learning store's contract states them.
/** A store with agent `agentId`, learning. */
async function rowsOn(t, agentId = "agent-one") {
  const { store } = await storeOn(t);
  await store.agents.create({ id: agentId, name: agentId }, { id: `rev-${agentId}`, kind: "agentic", body: { instructions: "Go.", learning: true } });
  return store;
}
/** Workflow `name` as run `word` writes it: its README.md and its workflow.json, each saying `word`. */
const flow = (name, word) => ({ [`workflows/${name}/README.md`]: readmeOf(name, `Answers as ${word} says; use when asked`).text, [`workflows/${name}/workflow.json`]: JSON.stringify(answerFlow(`Answer as ${word} says.`)) });
const wordRun = (word) => `run_${word.toLowerCase()}`;

test("rows: a purge takes out every version of what the purged run wrote: a workflow it alone wrote is gone, one a later run revised is that run's, its line goes, the other runs' things stay, and no row holds its text", async (t) => {
  const store = await rowsOn(t);
  await putLearning(store, "agent-one", { ...flow("w", "ALPHA"), "corrections.md": "- ALPHA line from the owner" }, { runId: wordRun("ALPHA") });
  await putLearning(store, "agent-one", { ...flow("y", "BRAVO"), ...flow("x", "BRAVO"), "corrections.md": "- ALPHA line from the owner\n- BRAVO line from the owner" }, { runId: wordRun("BRAVO") });
  await putLearning(store, "agent-one", flow("x", "CHARLIE"), { runId: wordRun("CHARLIE") });
  await store.learning.purgeRun("agent-one", wordRun("BRAVO"));
  assert.doesNotMatch(await learningText(store, "agent-one"), /BRAVO/);
  const { view, text } = await learningAt(store, "agent-one");
  assert.deepEqual(view.workflows.map(({ name, run }) => [name, run]), [["w", wordRun("ALPHA")], ["x", wordRun("CHARLIE")]]);
  for (const [path, body] of Object.entries(flow("x", "CHARLIE"))) assert.equal(text(path), body, path);
  assert.equal(text("corrections.md"), "- ALPHA line from the owner\n");
  const { saves } = await store.learning.saves("agent-one", { limit: 100 });
  assert.deepEqual(saves.map(({ by }) => by.run), [wordRun("CHARLIE"), wordRun("ALPHA")], "the log leaves the purged run's save out");
});

test("rows: a purge gives back the version before the purged run's revision: A's x again, B's alone-written y gone; a purge again changes nothing", async (t) => {
  const store = await rowsOn(t);
  await putLearning(store, "agent-one", flow("x", "ALPHA"), { runId: wordRun("ALPHA") });
  await putLearning(store, "agent-one", { ...flow("x", "BRAVO"), ...flow("y", "BRAVO") }, { runId: wordRun("BRAVO") });
  await store.learning.purgeRun("agent-one", wordRun("BRAVO"));
  const { view, text } = await learningAt(store, "agent-one");
  assert.deepEqual(view.workflows.map(({ name, run }) => [name, run]), [["x", wordRun("ALPHA")]]);
  for (const [path, body] of Object.entries(flow("x", "ALPHA"))) assert.equal(text(path), body, path);
  const before = await heldOf(store, "agent-one");
  await store.learning.purgeRun("agent-one", wordRun("BRAVO"));
  assert.deepEqual(await heldOf(store, "agent-one"), before, "a purge again changes nothing");
});

test("rows: a run whose merge wrote back an older run's bytes keeps them through two purges: A v1, B v2, C v1, purge B then A: C's v1 stays, its writer C", async (t) => {
  const store = await rowsOn(t);
  for (const [word, said] of [["ALPHA", "ALPHA"], ["BRAVO", "BRAVO"], ["CHARLIE", "ALPHA"]]) await putLearning(store, "agent-one", flow("x", said), { runId: wordRun(word) });
  await store.learning.purgeRun("agent-one", wordRun("BRAVO"));
  await store.learning.purgeRun("agent-one", wordRun("ALPHA"));
  const { view, text } = await learningAt(store, "agent-one");
  for (const [path, body] of Object.entries(flow("x", "ALPHA"))) assert.equal(text(path), body, path);
  assert.deepEqual(view.workflows.map(({ name, run }) => [name, run]), [["x", wordRun("CHARLIE")]]);
});

test("rows: a purge takes the purged run's README.md out of a later run's version that rewrote only workflow.json: no row holds the purged run's text", async (t) => {
  const store = await rowsOn(t);
  await putLearning(store, "agent-one", flow("x", "BRAVO"), { runId: wordRun("BRAVO") });
  const charlie = flow("x", "CHARLIE")["workflows/x/workflow.json"];
  await putLearning(store, "agent-one", { "workflows/x/workflow.json": charlie }, { runId: wordRun("CHARLIE") });
  await store.learning.purgeRun("agent-one", wordRun("BRAVO"));
  assert.doesNotMatch(await learningText(store, "agent-one"), /BRAVO/, "the purged run's README.md is in no version");
  assert.equal((await learningAt(store, "agent-one")).text("workflows/x/workflow.json"), charlie, "the later run's workflow.json stays");
});

test("rows: a purge takes out only the purged run's line: the same words another run added stay, and a line its owner moved goes all the same", async (t) => {
  const store = await rowsOn(t);
  await putLearning(store, "agent-one", { "corrections.md": "- ALPHA line from the owner" }, { runId: wordRun("ALPHA") });
  await putLearning(store, "agent-one", { "corrections.md": "- ALPHA line from the owner\n- the same words twice" }, { runId: "run_gone" });
  await putLearning(store, "agent-one", { "corrections.md": "- ALPHA line from the owner\n- the same words twice\n- the same words twice\n- KEPT line from the owner" }, { runId: "run_kept" });
  // The owner moves the purged run's line below the kept run's own.
  await putLearning(store, "agent-one", { "corrections.md": "- ALPHA line from the owner\n- the same words twice\n- KEPT line from the owner\n- the same words twice" }, { person: "edited" });
  await store.learning.purgeRun("agent-one", "run_gone");
  const lines = (await learningAt(store, "agent-one")).text("corrections.md").split("\n").filter(Boolean);
  assert.equal(lines.filter((line) => line === "- the same words twice").length, 1, `the kept run's copy stays: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("- ALPHA line from the owner") && lines.includes("- KEPT line from the owner"), JSON.stringify(lines));
});

// An SDK start keeps the workflows it delivered (and its check's draft) in its inbox row. A DELETE of the run that wrote
// them empties every such inbox; and a start whose writer is purged after its selection read it, before its inbox is
// written, is refused, its inbox removed: no inbox keeps a purged run's workflow text.
test("a DELETE of a run empties every SDK run's inbox of the workflow text it wrote, and a start whose writer is purged before its inbox is written keeps none", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = "sdk-inbox";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const flowOf = (deadline, label) => ({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label, via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: deadline } });
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" })).status, 201);
  const readme = { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status.\n---\n" };
  /** Run `writer` ended, its workflow `status` (labelled `label`) merged and promoted. */
  const promoted = async (writer, label) => {
    await endedRuns(api, store, id, [writer], false);
    const text = JSON.stringify(flowOf(5, label));
    const merge = await learned(store, id, (learning) => learningCommit(learning, { runId: writer, reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text }, readme] }));
    await putPromotions(store, id, [recordOf("status", digestOf(text), "promote", merge)]);
  };
  const inboxes = async () => JSON.stringify((await store.settings.all({ prefix: "sdk-run:" })).map((row) => row.value));
  await promoted("inbox-writer", "INBOXWORD");
  const pinned = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "pinned" });
  assert.equal(pinned.status, 201, JSON.stringify(pinned.body));
  assert.match(JSON.stringify(pinned.body.learning.workflows), /INBOXWORD/, "the start is given the writer's workflow");
  assert.match(await inboxes(), /INBOXWORD/);
  assert.equal((await api("DELETE", "/runs/inbox-writer")).status, 204);
  assert.doesNotMatch(await inboxes(), /INBOXWORD/, "no SDK run's inbox keeps the purged run's workflow text");
  // The purge commits after the selection read the writer, before the inbox is written.
  await promoted("race-writer", "RACEWORD");
  // The server's SdkRuns (this process's module) purges the writer, store alone (no inbox scrub), right after its
  // selection returns.
  const { SdkRuns } = await import("../dist/sdk/runs.js");
  const selectedWorkflows = SdkRuns.prototype.selectedWorkflows;
  let raced = false;
  SdkRuns.prototype.selectedWorkflows = async function (agentId, ...rest) {
    const selected = await selectedWorkflows.call(this, agentId, ...rest);
    if (!raced && agentId === id && JSON.stringify(selected.workflows).includes("RACEWORD")) {
      raced = true;
      await store.runs.purge("race-writer", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
    }
    return selected;
  };
  t.after(() => { SdkRuns.prototype.selectedWorkflows = selectedWorkflows; });
  const late = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "late" });
  assert.ok(raced, "the purge ran between the selection and the inbox's write");
  assert.notEqual(late.status, 201, `the start is refused: ${JSON.stringify(late.body)}`);
  assert.doesNotMatch(await inboxes(), /RACEWORD/, "the refused start's inbox is removed");
});

// A start's receipt carries a workflow's description (its README.md) beside its text (its workflow.json), and the two
// can be two runs' words: one run wrote both, a later one rewrote only the workflow.json. The start names every run
// whose file it delivers, so a purge of the README.md's run refuses the receipt sent again and empties the inbox.
test("an SDK start names every run whose file it delivers: a DELETE of the run that wrote only the README.md answers the receipt sent again 410 purged and empties the inbox", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = "sdk-readme";
  const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
  const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
  const flowOf = (deadline) => ({ v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: deadline } });
  const [v1, v2] = [JSON.stringify(flowOf(5)), JSON.stringify(flowOf(9))];
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "first" })).status, 201);
  await endedRuns(api, store, id, ["readme-writer", "json-writer"], false);
  const readme = { path: "workflows/status/README.md", text: "---\nname: status\ndescription: Read release status, READMEWORD.\n---\n" };
  await learned(store, id, (learning) => learningCommit(learning, { runId: "readme-writer", reason: "It learned status.", files: [{ path: "workflows/status/workflow.json", text: v1 }, readme] }));
  const merge = await learned(store, id, (learning) => learningCommit(learning, { runId: "json-writer", reason: "It waits longer.", files: [{ path: "workflows/status/workflow.json", text: v2 }, readme] }));
  await putPromotions(store, id, [recordOf("status", digestOf(v2), "promote", merge)]);
  const inboxes = async () => JSON.stringify((await store.settings.all({ prefix: "sdk-run:" })).map((row) => row.value));
  const pinned = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "pinned" });
  assert.equal(pinned.status, 201, JSON.stringify(pinned.body));
  assert.deepEqual(pinned.body.learning.workflows.map(({ description, workflow }) => [description, digestOf(workflow)]), [["Read release status, READMEWORD.", digestOf(v2)]], "the start is given json-writer's workflow.json with readme-writer's README.md");
  assert.match(await inboxes(), /READMEWORD/);
  assert.equal((await api("DELETE", "/runs/readme-writer")).status, 204);
  assert.doesNotMatch(await inboxes(), /READMEWORD/, "no SDK run's inbox keeps the purged run's README.md");
  const again = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "pinned" });
  assert.deepEqual({ status: again.status, code: again.body?.error?.code, run: again.body?.error?.details?.run_id }, { status: 410, code: "purged", run: "readme-writer" }, `the receipt sent again refuses the purged run's description: ${JSON.stringify(again.body)}`);
  const fresh = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "fresh" });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.doesNotMatch(JSON.stringify(fresh.body.learning), /READMEWORD/, "a new start is given none of it");
});
