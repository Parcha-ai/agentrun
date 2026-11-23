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
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { learningCommit } from "../dist/learn/commit.js";
import { readSnapshot, rebuiltSnapshotAt, runMergeOf } from "../dist/learn/folder.js";
import { learningStoreOf, useLearningStore } from "../dist/learn/store-of.js";
import { launchBody } from "../dist/run-launch.js";
import { ended, git, repoOf, started } from "./learn-support.mjs";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";
import { agent, answerFlow, serve, startRun } from "./support.mjs";

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

/** Workflow `name`'s files on agent `agentId`'s main, by path, each as git holds it, and main's commit. */
const onMain = async (data, agentId, name = "answer") => {
  const learning = learningStoreOf(data, agentId);
  const main = await learning.head();
  const files = main ? ((await learning.read(main)) ?? []).filter(({ path }) => path.startsWith(`workflows/${name}/`)) : [];
  return { files: Object.fromEntries(files.map(({ path, body }) => [path, Buffer.from(body).toString("utf8").trim()])), main };
};
/** Run `runId`'s merge on agent `agentId`'s main, by its marker: the commit a purge rewrote it to. */
const mergeAt = async (data, agentId, runId) => (await runMergeOf(learningStoreOf(data, agentId), runId))?.merge ?? null;
/** Workflow `answer` as a run writes it: its workflow.json and its README.md, each saying `said`. */
const answerAt = (said) => ({ "workflows/answer/README.md": readmeOf("answer", `Answers a question, ${said}; use when asked`).text.trim(), "workflows/answer/workflow.json": JSON.stringify(answerFlow(`Answer the question, ${said}.`)) });
const filesOf = (said) => Object.entries(answerAt(said)).map(([path, text]) => ({ path, text: path.endsWith(".md") ? `${text}\n` : text }));

/** Agent `agentId`'s champion of `answer` as the promotions read names it (its commit, or null), and the digest a run
 *  that fits `answer` is served first (null: the agent takes it). */
const servedNow = async (api, store, agentId, question) => {
  const promotions = (await api("GET", `/agents/${agentId}/learning/promotions`)).body;
  const run = await api("POST", `/agents/${agentId}/runs`, { input: { content: question, question } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await ended(api, run.body.run_id);
  return { champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null, served: (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null };
};
/** Agent `agentId` (learning on, no runner here) with one ended run, `<agentId>-served`, that its learned workflow
 *  `answer` served first: its id. */
const servedRunOf = async (api, store, agentId) => {
  assert.equal((await api("POST", "/agents", agent(agentId, { learning: true }))).status, 201);
  const revisionId = (await store.agents.get(agentId)).currentRevision;
  const runId = `${agentId}-served`;
  await store.runs.create({ id: runId, agentId, revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
  await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1, metrics: { path: "workflow", workflow: "answer", workflow_digest: "d1" } });
  return runId;
};
/** Records of workflow `other`, held, after `items` up to the trim bound, so the next write trims. */
const filledTo = (items, bound, at) => {
  const out = [...items];
  while (out.length < bound) out.push({ workflow: "other", digest: `other-${out.length}`, at, decided: "hold", reason: "held" });
  return out;
};

/** Each store the cases run on: the local folder, or code.storage over its fake (learn/store-of.ts useLearningStore). */
const STORES = {
  local: () => undefined,
  "code.storage": () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fake = codeStorageFake({ name: "example-org", publicKey });
    return { name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => "0123456789ab" };
  },
};
/** Data directory `data`'s learning on `settings` (none: its local folder) for case `t`. */
function onStore(t, data, settings) {
  if (!settings) return;
  useLearningStore(data, settings);
  t.after(() => useLearningStore(data, undefined));
}

// #3458's cases (jobs/purge-keeps-champion 66c5d2ff18), pointed at this purge (learn/purge.ts, the history rewritten)
// on both stores: the store's reads in place of git's, the champion's commit the one the purge moved it to, and main's
// files (not its id, which a rewrite moves) where a purge leaves a workflow as it was.
for (const [kind, settingsOf] of Object.entries(STORES)) {
  // A purge takes off main only what the purged run's revisions put there. Run `first` wrote `answer` v1, promoted; run
  // `gone` revised it to v2 (both its files), and the promotion check held v2, so v1 kept serving. The purge of `gone`
  // puts v1 back as `first` wrote it, its writer `first` again: the view lists it with v1's description, a run that fits
  // it is served v1, the promotions read still names v1's commit as champion, and the compile ask the next run builds
  // (runner/learning-end.ts compileAskOf) holds none of `gone`'s text. A repeat DELETE changes nothing.
  test(`${kind}: a purge puts back the version another run wrote before the purged run's held revision: main holds it as that run wrote it, the view lists it, a run that fits it is served it, its champion is still read, no compile ask holds the purged text; a repeat DELETE makes no commit`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-HELD-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
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
    const champion = await learned(data, "holder", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const revised = await learned(data, "holder", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    // Run `replayed` merged a round on top of `gone`'s that left answer alone, and stopped before its end: its replayed
    // ask reads main as that merge read it, its parent, where answer is still `gone`'s v2.
    await learned(data, "holder", (ws) => learningCommit(ws, { runId: replayed, round: 3, reason: "It learned other.", files: [{ path: "workflows/other/workflow.json", text: JSON.stringify(topicFlow("Answer by topic.")) }, readmeOf("other")] }));
    const at = new Date().toISOString();
    const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, alone: 4, agreed: 2 };
    await store.settings.put("learning.promotions.holder", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: champion },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "hold", reason: "checked: held", commit: revised, check },
    ] });

    const { compileAskOf } = await import("../dist/runner/learning-end.js");
    /** The compile ask run Q builds at its end, the one `replayed` builds again for its round, and the champion the
     *  promotions read names for `answer`. */
    const asked = async () => {
      const askOf = (runId, round) => compileAskOf({ store, data, learningStore: (agentId) => learningStoreOf(data, agentId) }, { runId, agentId: "holder", outcome: "completed", refuse: [], input: { content: "What is four?", question: "What is four?" }, seedWorkflows: 1, ...(round ? { round } : {}) });
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
    assert.deepEqual((await onMain(data, "holder")).files, v1, "main holds answer v1 again, both files as `first` wrote them");
    const purged = await asked();
    assert.equal(purged.holds, false, "after the purge, Q's ask holds none of the purged run's text");
    assert.equal(purged.replay, false, "after the purge, the replayed ask, read at its merge's parent, holds none of the purged run's text");
    assert.equal(purged.champion, await mergeAt(data, "holder", first), "the promotions read still names v1's commit as champion, the one the purge rewrote it to");
    assert.deepEqual(await reads("What is six times seven?"), { description: "Answers a question, in whole numbers; use when asked", file: v1[path], served: digestOf(v1[path]) }, "the view lists answer with v1's description, the file read serves v1, and a run that fits it is served v1");

    // (e) A repeat DELETE finds answer written by `first`: no commit, and v1 still serves.
    const before = (await onMain(data, "holder"));
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.deepEqual((await onMain(data, "holder")), before, "a repeat DELETE makes no commit and never rolls first's v1 back");
    assert.equal((await reads("What is seven times six?")).served, digestOf(v1[path]), "v1 still serves after the repeat DELETE");
  });

  // #3458 (f5567cd095): a purged run that revised a workflow and put its earlier bytes back in a later round: the
  // put-back finds main's files as `first` wrote them, so no byte changes, and the writer still moves to `first`, on the
  // snapshot as written and as rebuilt from main: the file reads 200, a run that fits it is served v1, and a repeat
  // DELETE makes no commit. The writer read off both snapshots in place of #3458's resnap (no snapshot file to rewrite
  // on code.storage).
  test(`${kind}: a purge of a run that put a workflow's earlier bytes back moves its writer with no byte changed: v1 reads and serves, also once the snapshot is rebuilt`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-UNDONE-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "undone", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "undone", "What is three?");
    await ended(api, gone);
    const path = "workflows/answer/workflow.json";
    const v1 = answerAt("in whole numbers");
    const champion = await learned(data, "undone", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    await learned(data, "undone", (ws) => learningCommit(ws, { runId: gone, round: 1, reason: "It revised answer.", files: filesOf(mark) }));
    await learned(data, "undone", (ws) => learningCommit(ws, { runId: gone, round: 2, reason: "It put answer back.", files: filesOf("in whole numbers") }));
    await store.settings.put("learning.promotions.undone", { v: 1, items: [{ workflow: "answer", digest: digestOf(v1[path]), at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", commit: champion }] });
    const reads = async (question) => {
      const file = await api("GET", `/agents/undone/learning/files/${encodeURIComponent(path)}`);
      const now = await servedNow(api, store, "undone", question);
      return { file: file.status === 200 ? JSON.stringify(file.body) : `${file.status} ${file.body?.error?.code}`, served: now.served };
    };
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.deepEqual((await onMain(data, "undone")).files, v1, "main holds answer v1, as `first` wrote it");
    const want = { file: v1[path], served: digestOf(v1[path]) };
    assert.deepEqual(await reads("What is six times seven?"), want, "after the purge, the file read serves v1 and a run that fits it is served v1");
    const learning = learningStoreOf(data, "undone");
    const runOf = (snapshot) => snapshot?.workflows.find(({ name }) => name === "answer")?.run ?? null;
    assert.deepEqual([runOf(await readSnapshot(learning)), runOf(await rebuiltSnapshotAt(learning, await learning.head()))], [first, first], "the writer is `first` on the snapshot as written and as rebuilt from main");
    assert.deepEqual(await reads("What is seven times six?"), want, "v1 still reads and serves");
    const before = await onMain(data, "undone");
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.deepEqual(await onMain(data, "undone"), before, "a repeat DELETE makes no commit");
  });

  // Greptile P1 (PRRT_kwDOUmdVMs66q6Tx): `first` wrote `answer` v1, `gone` revised it to v2, and `back` wrote v1 again.
  // The purge of `gone` leaves `back`'s rebuilt merge writing the bytes already there, and its marker keeps `back` as
  // the writer. A snapshot rebuilt from main's tree and history (a hand commit since holds none of its own) reads the
  // writer from the markers too, so it names `back`, never `first`; and once `first` is purged as well, `back`'s v1
  // still reads and serves (a writer read as `first` would make it 410 purged).
  test(`${kind}: a snapshot rebuilt after a purge names the run whose merge wrote a workflow last by its marker, though its bytes changed nothing: a purge of the run before keeps it`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-REWRITE-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "rewrit", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "rewrit", "What is three?");
    await ended(api, gone);
    const back = await started(api, "rewrit", "What is four?");
    await ended(api, back);
    const path = "workflows/answer/workflow.json";
    const v1 = answerAt("in whole numbers");
    await learned(data, "rewrit", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    await learned(data, "rewrit", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const crowned = await learned(data, "rewrit", (ws) => learningCommit(ws, { runId: back, reason: "It put answer back.", files: filesOf("in whole numbers") }));
    await store.settings.put("learning.promotions.rewrit", { v: 1, items: [{ workflow: "answer", digest: digestOf(v1[path]), at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", commit: crowned }] });
    const learning = learningStoreOf(data, "rewrit");
    // A hand commit: it holds no snapshot of its own, so every read of main rebuilds one from its tree and history.
    const byHand = async (text) => {
      const saved = await learning.save({ old: await learning.head(), message: "by hand", at: Math.floor(Date.now() / 1000), writes: [{ path: "corrections.md", text }] });
      assert.equal(saved.ok ?? true, true, JSON.stringify(saved));
    };
    const runOf = (snapshot) => snapshot?.workflows.find(({ name }) => name === "answer")?.run ?? null;
    const writers = async () => [runOf(await readSnapshot(learning)), runOf(await rebuiltSnapshotAt(learning, await learning.head()))];
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    await byHand("- Say the units.\n");
    assert.deepEqual(await writers(), [back, back], "after the purge and a hand commit, the writer is `back` on the snapshot read and as rebuilt from main");

    assert.equal((await api("DELETE", `/runs/${first}`)).status, 204);
    await byHand("- Say the units twice.\n");
    assert.deepEqual((await onMain(data, "rewrit")).files, v1, "main holds answer v1, as `back` wrote it");
    const file = await api("GET", `/agents/rewrit/learning/files/${encodeURIComponent(path)}`);
    const now = await servedNow(api, store, "rewrit", "What is six times seven?");
    assert.deepEqual({ writers: await writers(), file: file.status === 200 ? JSON.stringify(file.body) : `${file.status} ${file.body?.error?.code}`, served: now.served }, { writers: [back, back], file: v1[path], served: digestOf(v1[path]) }, "once `first` is purged too, `back` is still the writer, and its v1 reads and serves");
  });

  // The purged run's revision was the champion: `first` wrote `answer` v1, promoted; `gone` revised it to v2, promoted
  // after it. The purge puts v1 back on main. The champion record still names v2 at `gone`'s merge, a commit the purge
  // gate refuses (promote.ts refusedOf: it no longer holds v2's text), so championOf walks back to v1's record: the
  // champion read names v1's commit and a run that fits it is served v1. No byte of `gone`'s text reaches a read, a run
  // or a compile ask; the cost read names v1; the trim keeps v1's records; a revision promoted later still wins.
  test(`${kind}: a purge of the champion's run puts back the version before it, and the earlier champion serves again: none of the purged text is served, and a later promotion still wins`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-CHAMPION-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
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
    const kept = await learned(data, "crowned", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const crowned = await learned(data, "crowned", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const at = new Date().toISOString();
    // Each promotion's check, on its own number of inputs, so the cost read names whose it reads.
    const checked = (n) => ({ compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n, alone: n, agreed: n - 1 });
    await store.settings.put("learning.promotions.crowned", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept, check: checked(10) },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "promote", reason: "checked: promoted", commit: crowned, check: checked(20) },
    ] });
    const { compileAskOf } = await import("../dist/runner/learning-end.js");
    const reads = async (question) => {
      const view = (await api("GET", "/agents/crowned/learning")).body;
      const files = await Promise.all(Object.keys(v1).map((one) => api("GET", `/agents/crowned/learning/files/${encodeURIComponent(one)}`)));
      const ask = await compileAskOf({ store, data, learningStore: (agentId) => learningStoreOf(data, agentId) }, { runId: q, agentId: "crowned", outcome: "completed", refuse: [], input: { content: question, question }, seedWorkflows: 1 });
      const run = await api("POST", "/agents/crowned/runs", { input: { content: question, question } });
      assert.equal(run.status, 202, JSON.stringify(run.body));
      await ended(api, run.body.run_id);
      const promotions = (await api("GET", "/agents/crowned/learning/promotions")).body;
      return {
        holds: [view, files.map(({ body }) => body), ask ?? null].some((one) => JSON.stringify(one).includes(mark)),
        champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null,
        served: (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null,
      };
    };
    assert.deepEqual(await reads("What is six times seven?"), { holds: true, champion: crowned, served: digestOf(v2[path]) }, "before the purge, v2 is the champion and serves");
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.deepEqual((await onMain(data, "crowned")).files, v1, "main holds answer v1 again, both files as `first` wrote them");
    assert.deepEqual(await reads("What is seven times six?"), { holds: false, champion: await mergeAt(data, "crowned", first), served: digestOf(v1[path]) }, "no read, run or compile ask holds v2; the champion read names v1's commit, and a run that fits it is served v1");
    // The cost read names the champion the gate leaves: the serving check is v1's, and the bill says v1 serves, never v2.
    const cost = (await api("GET", "/agents/crowned/learning/cost")).body;
    const states = Object.fromEntries(cost.bill.revisions.filter(({ workflow }) => workflow === "answer").map(({ digest, state }) => [digest, state]));
    assert.deepEqual({ replay: cost.summary.replay?.n ?? null, states }, { replay: 10, states: { [digestOf(v1[path])]: "serving", [digestOf(v2[path])]: "stopped" } }, "the cost read's serving check and the bill's states name v1, never the purged v2");

    // The PROMOTIONS_KEPT trim keeps the champion the gate leaves: a record written past the bound, through the same port
    // the runner hands recordPromotion, drops none of v1's records, so v1 still serves.
    const { PROMOTIONS_KEPT, recordPromotion } = await import("../dist/learn/promote.js");
    const { recordLearningOf } = await import("../dist/purged-workflow.js");
    const filler = (await store.settings.get("learning.promotions.crowned")).items;
    for (let i = filler.length; i < PROMOTIONS_KEPT; i++) filler.push({ workflow: "other", digest: `other-${i}`, at, decided: "hold", reason: "held" });
    await store.settings.put("learning.promotions.crowned", { v: 1, items: filler });
    const trimmed = await recordPromotion(store.settings, "crowned", { workflow: "other", digest: "other-past", at, decided: "hold", reason: "held" }, (was) => was === undefined, recordLearningOf(learningStoreOf(data, "crowned"), store));
    assert.equal(trimmed.won, true);
    assert.equal((await store.settings.get("learning.promotions.crowned")).items.length, PROMOTIONS_KEPT, "the record past the bound trims one");
    assert.deepEqual(await reads("What is seven times seven?"), { holds: false, champion: await mergeAt(data, "crowned", first), served: digestOf(v1[path]) }, "past the trim, the champion read still names v1's commit, and a run that fits it is served v1");

    // A revision `later` promotes after the purge is the champion over v1.
    const v3 = answerAt("in tens");
    const promoted = await learned(data, "crowned", (ws) => learningCommit(ws, { runId: later, reason: "It revised answer.", files: filesOf("in tens") }));
    const { items } = await store.settings.get("learning.promotions.crowned");
    await store.settings.put("learning.promotions.crowned", { v: 1, items: [...items, { workflow: "answer", digest: digestOf(v3[path]), at, decided: "promote", reason: "checked: promoted", commit: promoted }] });
    assert.deepEqual(await reads("What is six times six?"), { holds: false, champion: promoted, served: digestOf(v3[path]) }, "a revision promoted after the purge is the champion and serves, not v1");
  });

  // #3458 round 2, rules (1) and (2), red before their fix. `first` wrote answer v1, promoted; `gone` revised it to v2.
  // (2) v2 was promoted, then held by a later check: the purge gate walks the digest promoted last whatever its newest
  // decision, so v2's records are refused and v1, the earlier champion, serves again. (1) A promote check of v2 still at
  // work when `gone` is purged records against the commit its runs were seeded from, the pre-purge merge: that promote
  // is never recorded, and v1 still serves.
  for (const rule of ["(2) the champion later held", "(1) a promote check in flight"]) test(`${kind}: round 2 ${rule}: a purge of the run that wrote v2 never leaves v2 the champion; v1, promoted before it, serves again`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-ROUND2-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "again", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "again", "What is three?");
    await ended(api, gone);

    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
    const kept = await learned(data, "again", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const revised = await learned(data, "again", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const at = new Date().toISOString();
    const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, alone: 5, agreed: 5 };
    const promoteV1 = { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept };
    const v2Record = (decided) => ({ workflow: "answer", digest: digestOf(v2[path]), at: new Date().toISOString(), decided, reason: `checked: ${decided === "promote" ? "promoted" : "held"}`, commit: revised, check });
    await store.settings.put("learning.promotions.again", { v: 1, items: rule.startsWith("(2)") ? [promoteV1, v2Record("promote"), v2Record("hold")] : [promoteV1] });
    const reads = async (question) => {
      const run = await api("POST", "/agents/again/runs", { input: { content: question, question } });
      assert.equal(run.status, 202, JSON.stringify(run.body));
      await ended(api, run.body.run_id);
      const promotions = (await api("GET", "/agents/again/learning/promotions")).body;
      return { champion: promotions.serving.find((line) => line.workflow === "answer")?.champion?.commit ?? null, served: (await store.runs.get(run.body.run_id)).metrics?.workflow_digest ?? null };
    };
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    if (rule.startsWith("(1)")) {
      // The check's settle, after the purge's rewrite and its record move: its promote names the pre-purge merge.
      const { recordPromotion } = await import("../dist/learn/promote.js");
      const { recordLearningOf } = await import("../dist/purged-workflow.js");
      await recordPromotion(store.settings, "again", v2Record("promote"), () => true, recordLearningOf(learningStoreOf(data, "again"), store));
      const records = (await api("GET", "/agents/again/learning/promotions")).body.promotions;
      assert.equal(records.some((one) => one.digest === digestOf(v2[path]) && one.decided === "promote"), false, "no promote is recorded for the purged run's revision");
    }
    assert.deepEqual(await reads("What is six times seven?"), { champion: await mergeAt(data, "again", first), served: digestOf(v1[path]) }, "v1's record, moved by the rewrite, is the champion and serves");
  });

  // #3458 (jobs/purge-keeps-champion 54885ee672), on both stores; v1's commit is the one the purge moved it to (mergeAt:
  // code.storage rebuilds every commit into the next generation). A check that outlives the purge: `gone`'s v2 replays on
  // other runs' inputs, so its purge never stops it, and it decides after the purge with the records at the trim bound.
  // Its decision lands no promote for v2 (the gate refuses v2 at the commit it was checked at), and a promote some writer
  // lands for v2 is asked of the gate with the records it trims, so v1's records stay and v1 still serves.
  test(`${kind}: a check that outlives the purge of its revision's run lands no promote for it, and past the trim the earlier champion still serves`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-LATE-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "late", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "late", "What is three?");
    await ended(api, gone);
    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
    const kept = await learned(data, "late", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const revised = await learned(data, "late", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const { PROMOTIONS_KEPT, promotionOf, recordPromotion } = await import("../dist/learn/promote.js");
    const { recordLearningOf } = await import("../dist/purged-workflow.js");
    const { decideCheck } = await import("../dist/runner/promotion.js");
    const { secretsShown } = await import("../dist/learning.js");
    const at = new Date().toISOString();
    const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
    const replay = { commit: revised, runs: ["late-replay-1"], replay_id: "late-replay" };
    await store.settings.put("learning.promotions.late", { v: 1, items: filledTo([
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "replaying", reason: "checking", check: bar, ...replay },
    ], PROMOTIONS_KEPT, at) });
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);

    // v2's check lands now, every input answered alone and agreed.
    const learning = learningStoreOf(data, "late");
    const rows = ["a", "b", "c", "d", "e"].map((one) => ({ of: `late-input-${one}`, input: "What is six?", agent: "6", outcome: "answered", answer: "6" }));
    const deps = { store, agentId: "late", log: () => {}, shown: async () => secretsShown([]), learning };
    await decideCheck(deps, "answer", digestOf(v2[path]), bar, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, (was) => was?.decided === "replaying", replay);
    assert.deepEqual(await servedNow(api, store, "late", "What is six times seven?"), { champion: await mergeAt(data, "late", first), served: digestOf(v1[path]) }, "past the late check's write, the champion read names v1's commit, and a run that fits it is served v1");
    const late = promotionOf((await store.settings.get("learning.promotions.late")).items, "answer", digestOf(v2[path]));
    assert.deepEqual({ decided: late?.decided, said: /purged/.test(late?.reason ?? "") }, { decided: "hold", said: true }, "the late check records no promote for v2: a hold that says its run was purged");

    // A promote some writer lands for v2 past the bound: the gate is asked over the records the write keeps, that one
    // included, so the trim keeps v1's.
    const landed = await recordPromotion(store.settings, "late", { workflow: "answer", digest: digestOf(v2[path]), at, decided: "promote", reason: "checked: promoted", commit: revised }, () => true, recordLearningOf(learning, store));
    assert.equal(landed.won, true);
    assert.deepEqual(await servedNow(api, store, "late", "What is seven times six?"), { champion: await mergeAt(data, "late", first), served: digestOf(v1[path]) }, "past a promote for the purged v2 and its trim, the champion read names v1's commit, and a run that fits it is served v1");
  });

  // A purged champion that was held since: `gone`'s v2 was promoted, then held (here by this release's DSL; an audit's
  // hold is the same record), so nothing served. The purge puts v1 back on main, and the gate walks the digest promoted
  // last whatever its newest decision: v2's records at `gone`'s commit are skipped, and v1 serves again, past the trim too.
  test(`${kind}: a purge of a champion's run that was held since puts the earlier champion back: it serves, and the trim keeps it`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-REHELD-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "reheld", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "reheld", "What is three?");
    await ended(api, gone);
    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
    const kept = await learned(data, "reheld", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const crowned = await learned(data, "reheld", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const { DSL_REFUSES } = await import("../dist/runner/promotion.js");
    const at = new Date().toISOString();
    await store.settings.put("learning.promotions.reheld", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "promote", reason: "checked: promoted", commit: crowned },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "hold", reason: `${DSL_REFUSES}: a node it names is gone`, commit: crowned },
    ] });
    assert.deepEqual(await servedNow(api, store, "reheld", "What is six times seven?"), { champion: null, served: null }, "before the purge, v2 is held and nothing serves");
    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.deepEqual((await onMain(data, "reheld")).files, v1, "main holds answer v1 again");
    assert.deepEqual(await servedNow(api, store, "reheld", "What is seven times six?"), { champion: await mergeAt(data, "reheld", first), served: digestOf(v1[path]) }, "after the purge of the held champion's run, the champion read names v1's commit, and a run that fits it is served v1");

    const { PROMOTIONS_KEPT, recordPromotion } = await import("../dist/learn/promote.js");
    const { recordLearningOf } = await import("../dist/purged-workflow.js");
    await store.settings.put("learning.promotions.reheld", { v: 1, items: filledTo((await store.settings.get("learning.promotions.reheld")).items, PROMOTIONS_KEPT, at) });
    const trimmed = await recordPromotion(store.settings, "reheld", { workflow: "other", digest: "other-past", at, decided: "hold", reason: "held" }, (was) => was === undefined, recordLearningOf(learningStoreOf(data, "reheld"), store));
    assert.equal(trimmed.won, true);
    assert.deepEqual(await servedNow(api, store, "reheld", "What is seven times seven?"), { champion: await mergeAt(data, "reheld", first), served: digestOf(v1[path]) }, "past the trim, the champion read still names v1's commit, and a run that fits it is served v1");
  });

  // #3458 (jobs/purge-keeps-champion 0695220cf9), on both stores. A purge gate whose store read fails (its read of a
  // writer's run row throws): a promote write still fails closed (decideCheck throws, nothing is promoted), and the
  // single-run GET answers 200. Here v2's commit holds v2, on main, so the gate's first two reads stand and its read of
  // the writer's row is the one that throws (#3458's case checks v2 at v1's commit, which this gate refuses as not
  // holding it before any row is read).
  test(`${kind}: a purge gate whose store read fails leaves the run read 200 and still refuses the promote write`, { timeout: 120_000 }, async (t) => {
    const { api, data, store } = await serve(t, { runner: false });
    onStore(t, data, settingsOf());
    const runId = await servedRunOf(api, store, "torn");
    // The workflow's writer, a run of another agent: no read of torn's own runs reads its row, only the gate does.
    assert.equal((await api("POST", "/agents", agent("elsewhere", { learning: true }))).status, 201);
    const writer = "torn-writer";
    await store.runs.create({ id: writer, agentId: "elsewhere", revisionId: (await store.agents.get("elsewhere")).currentRevision }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
    await store.runs.update(await store.claim(writer, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt("in words")];
    const first = await learned(data, "torn", (ws) => learningCommit(ws, { runId: writer, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const commit = await learned(data, "torn", (ws) => learningCommit(ws, { runId: writer, round: 2, reason: "It revised answer.", files: filesOf("in words") }));
    const at = new Date().toISOString();
    const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
    const replay = { commit, runs: ["torn-replay-1"], replay_id: "torn-replay" };
    await store.settings.put("learning.promotions.torn", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: first },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "replaying", reason: "checking", check: bar, ...replay },
    ] });
    // The writer's row no longer reads: every store read of it throws (its metrics are not JSON, past the column's check).
    const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 5_000 });
    try {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("UPDATE runs SET metrics = '{' WHERE id = ?").run(writer);
    } finally {
      db.close();
    }
    await assert.rejects(store.runs.get(writer), "the writer's row read throws");

    const run = await api("GET", `/runs/${runId}`);
    const { promotionOf } = await import("../dist/learn/promote.js");
    const { decideCheck } = await import("../dist/runner/promotion.js");
    const { secretsShown } = await import("../dist/learning.js");
    const rows = ["a", "b", "c", "d", "e"].map((one) => ({ of: `torn-input-${one}`, input: "What is six?", agent: "6", outcome: "answered", answer: "6" }));
    const deps = { store, agentId: "torn", log: () => {}, shown: async () => secretsShown([]), learning: learningStoreOf(data, "torn") };
    const write = await decideCheck(deps, "answer", digestOf(v2[path]), bar, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, (was) => was?.decided === "replaying", replay).then(() => "written", () => "refused");
    const decided = promotionOf((await store.settings.get("learning.promotions.torn")).items, "answer", digestOf(v2[path]))?.decided;
    assert.deepEqual({ run: run.status, write, decided }, { run: 200, write: "refused", decided: "replaying" }, "a gate whose store read fails leaves the run read 200, and the promote write is still refused");
  });

  // #3458 (0695220cf9), on both stores. A check that outlives its revision's run, with the inputs it did not agree on:
  // the run's purge puts v1 back on main while v2's check replays other runs' inputs, and the check lands a hold for v2
  // at the commit it was checked at. The gate refuses that hold as it refuses a promote there, so the compile's held
  // names (and the next run's compile ask) never ask a revision of the purged v2 from its disagreements.
  test(`${kind}: a hold a check lands after its revision's run is purged is refused by the gate: no compile is asked of it`, { timeout: 120_000 }, async (t) => {
    const { api, data, store } = await serve(t, { runner: false });
    onStore(t, data, settingsOf());
    assert.equal((await api("POST", "/agents", agent("rehold", { learning: true }))).status, 201);
    const revisionId = (await store.agents.get("rehold")).currentRevision;
    for (const runId of ["rehold-first", "rehold-gone", "rehold-next"]) {
      await store.runs.create({ id: runId, agentId: "rehold", revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
      await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
    }
    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt("in words")];
    const kept = await learned(data, "rehold", (ws) => learningCommit(ws, { runId: "rehold-first", reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const revised = await learned(data, "rehold", (ws) => learningCommit(ws, { runId: "rehold-gone", reason: "It revised answer.", files: filesOf("in words") }));
    const at = new Date().toISOString();
    const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
    const replay = { commit: revised, runs: ["rehold-replay-1"], replay_id: "rehold-replay" };
    await store.settings.put("learning.promotions.rehold", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "replaying", reason: "checking", check: bar, ...replay },
    ] });
    assert.equal((await api("DELETE", "/runs/rehold-gone")).status, 204);
    assert.deepEqual((await onMain(data, "rehold")).files, v1, "main holds answer v1 again");

    // v2's check lands now: every input answered, none as the agent did, so it holds with its disagreements.
    const { promotionOf, refusedOf } = await import("../dist/learn/promote.js");
    const { holdsTextOf } = await import("../dist/purged-workflow.js");
    const { decideCheck } = await import("../dist/runner/promotion.js");
    const { secretsShown } = await import("../dist/learning.js");
    const { heldNamesOf } = await import("../dist/learn/compile.js");
    const { compileAskOf } = await import("../dist/runner/learning-end.js");
    const learning = learningStoreOf(data, "rehold");
    const rows = ["a", "b", "c", "d", "e"].map((one) => ({ of: `rehold-input-${one}`, input: "What is six?", agent: "6", outcome: "answered", answer: "seven" }));
    const deps = { store, agentId: "rehold", log: () => {}, shown: async () => secretsShown([]), learning };
    await decideCheck(deps, "answer", digestOf(v2[path]), bar, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, (was) => was?.decided === "replaying", replay);
    const records = (await store.settings.get("learning.promotions.rehold")).items;
    assert.equal(promotionOf(records, "answer", digestOf(v2[path]))?.decided, "hold", "the late check lands a hold for v2");

    const ask = await compileAskOf({ store, data, learningStore: (agentId) => learningStoreOf(data, agentId) }, { runId: "rehold-next", agentId: "rehold", outcome: "completed", refuse: [], input: { content: "What is six?", question: "What is six?" }, seedWorkflows: 1 });
    assert.deepEqual({ held: [...heldNamesOf(records, await refusedOf(records, holdsTextOf(learning)))], asked: ask?.mode === "revise" ? ask.workflow : null }, { held: [], asked: null }, "the gate refuses the late hold at v2's commit: heldNamesOf names no workflow, and the next compile ask revises nothing");
  });

  // The raw reads of a workflow a purged run wrote that is still on main (its run purged before its purge took the
  // folder's text, until its DELETE is sent again): its files read 410 purged, as every route of that run does, and a
  // person's approval of it is refused the same way. The store's reads in place of git's.
  test(`${kind}: a workflow a purged run wrote, still on main, is refused at the raw reads: its files read 410 purged, and its approval is refused`, { timeout: 120_000 }, async (t) => {
    const { api, data, store } = await serve(t, { runner: false });
    onStore(t, data, settingsOf());
    assert.equal((await api("POST", "/agents", agent("raw", { learning: true }))).status, 201);
    const revisionId = (await store.agents.get("raw")).currentRevision;
    await store.runs.create({ id: "raw-writer", agentId: "raw", revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
    await store.runs.update(await store.claim("raw-writer", "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
    const flow = "workflows/drafted/workflow.json";
    const readme = "workflows/drafted/README.md";
    await learned(data, "raw", (ws) => learningCommit(ws, { runId: "raw-writer", reason: "It drafted one.", files: [{ path: flow, text: JSON.stringify(answerFlow("Draft it.")) }, { path: readme, text: "---\nname: drafted\ndescription: Answers a question; use when asked\nstatus: pending\n---\n" }] }));
    await store.runs.purge("raw-writer", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
    const file = async (path) => {
      const res = await api("GET", `/agents/raw/learning/files/${encodeURIComponent(path)}`);
      return { status: res.status, code: res.body?.error?.code ?? null, run: res.body?.error?.details?.run_id ?? null };
    };
    const { changeWorkflow } = await import("../dist/learning-routes.js");
    const learning = learningStoreOf(data, "raw");
    const etag = `"${(await readSnapshot(learning)).workflows.find((one) => one.name === "drafted").files.find((one) => one.path === readme).oid}"`;
    const approved = await changeWorkflow(data, "raw", readme, { action: "approve", ifMatch: etag, refuse: [], store }).then(() => ({ status: 200 }), (error) => ({ status: error.status, code: error.code }));
    const refused = { status: 410, code: "purged", run: "raw-writer" };
    assert.deepEqual({ flow: await file(flow), readme: await file(readme), approved }, { flow: refused, readme: refused, approved: { status: 410, code: "purged" } }, "the purged writer's files read 410 purged, and its approval is refused");
    const [onMainNow] = (await learning.read(await learning.head(), [readme])) ?? [];
    assert.match(Buffer.from(onMainNow.body).toString("utf8"), /status: pending/, "nothing approved it");
  });

  // Never the whole folder: a purge whose read of main's history finds no commit refuses (503 to its DELETE, sent again
  // later), and every file stays on main. The store's log in place of git's read.
  test(`${kind}: a purge whose read of main's history finds nothing refuses and takes none of the folder's files off`, { timeout: 120_000 }, async (t) => {
    const { api, data, store } = await serve(t, { runner: false });
    onStore(t, data, settingsOf());
    assert.equal((await api("POST", "/agents", agent("blind", { learning: true }))).status, 201);
    const revisionId = (await store.agents.get("blind")).currentRevision;
    for (const runId of ["blind-first", "blind-gone"]) {
      await store.runs.create({ id: runId, agentId: "blind", revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
      await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
    }
    await learned(data, "blind", (ws) => learningCommit(ws, { runId: "blind-first", reason: "It wrote v1.", files: filesOf("v1") }));
    await learned(data, "blind", (ws) => learningCommit(ws, { runId: "blind-gone", reason: "It wrote v2.", files: filesOf("v2") }));
    const before = await onMain(data, "blind");
    const { forgetRunText } = await import("../dist/learn/purge.js");
    const learning = learningStoreOf(data, "blind");
    // The store answers every call but the history read of main, which finds no commit.
    const blind = new Proxy(learning, {
      get(target, name) {
        if (name === "log") return async (ref, options) => (ref === before.main ? [] : target.log(ref, options));
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcome = await forgetRunText(blind, "blind-gone").then(() => "done", (error) => error.name);
    assert.deepEqual({ files: (await onMain(data, "blind")).files, outcome }, { files: before.files, outcome: "FolderUnreadable" }, "no history read refuses, and every file of the folder is still on main");
  });

  // The writer rule follows the bytes over runs that end cheaply (no runner): (c) a workflow the purged run wrote new
  // leaves main whole; (d) a later run's revision on top of the purged run's stays as it is; (f) two purged runs in a row
  // on one workflow leave the version before both, in either order of purge, its writer the run that wrote it in both the
  // snapshot a write leaves and the one a rebuild from main reads.
  test(`${kind}: a purge puts back only what no purged run wrote: a new workflow leaves main, a later run's revision stays, and two purged runs in a row leave the version before both in either order`, { timeout: 300_000 }, async (t) => {
    const { api, data, store } = await serve(t, { runner: false });
    onStore(t, data, settingsOf());
    /** Agent `agentId`, learning, with runs `runIds` ended, so a DELETE purges each. */
    const agentWith = async (agentId, runIds) => {
      assert.equal((await api("POST", "/agents", agent(agentId, { learning: true }))).status, 201);
      const revisionId = (await store.agents.get(agentId)).currentRevision;
      for (const runId of runIds) {
        await store.runs.create({ id: runId, agentId, revisionId }, { body: launchBody({ input: { content: "Q" }, title: "t", place: { mode: "runner" } }) });
        await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1 });
      }
    };
    const wrote = (agentId, runId, said) => learned(data, agentId, (ws) => learningCommit(ws, { runId, reason: `It wrote ${said}.`, files: filesOf(said) }));
    const purge = async (runId) => assert.equal((await api("DELETE", `/runs/${runId}`)).status, 204);
    /** The writer of `answer` in the snapshot on disk, then in one rebuilt from main whole. */
    const writers = async (agentId) => {
      const learning = learningStoreOf(data, agentId);
      const runOf = (snapshot) => snapshot?.workflows.find(({ name }) => name === "answer")?.run ?? null;
      return [runOf(await readSnapshot(learning)), runOf(await rebuiltSnapshotAt(learning, await learning.head()))];
    };

    // (c) Written new by the purged run: the whole folder leaves main.
    await agentWith("fresh", ["fresh-gone"]);
    await wrote("fresh", "fresh-gone", "new");
    await purge("fresh-gone");
    assert.deepEqual((await onMain(data, "fresh")).files, {}, "a workflow the purged run wrote new leaves main");

    // (d) A later run revised the purged run's version: it stays, no commit.
    await agentWith("later", ["later-first", "later-gone", "later-last"]);
    for (const [runId, said] of [["later-first", "v1"], ["later-gone", "v2"], ["later-last", "v3"]]) await wrote("later", runId, said);
    const kept = (await onMain(data, "later"));
    await purge("later-gone");
    assert.deepEqual((await onMain(data, "later")).files, kept.files, "a later run's v3 stays untouched (the rewrite moves main's id, never its files)");
    assert.deepEqual(kept.files, answerAt("v3"));

    // (f) Two purged runs in a row, the newest first: v2 back, then v1.
    await agentWith("twice", ["twice-first", "twice-gone1", "twice-gone2"]);
    for (const [runId, said] of [["twice-first", "v1"], ["twice-gone1", "v2"], ["twice-gone2", "v3"]]) await wrote("twice", runId, said);
    await purge("twice-gone2");
    assert.deepEqual((await onMain(data, "twice")).files, answerAt("v2"), "the purge of gone2 puts back gone1's v2");
    assert.deepEqual(await writers("twice"), ["twice-gone1", "twice-gone1"], "v2's writer is gone1 again, in the snapshot written and in one rebuilt from main");
    await purge("twice-gone1");
    assert.deepEqual((await onMain(data, "twice")).files, answerAt("v1"), "then the purge of gone1 puts back first's v1");
    assert.deepEqual(await writers("twice"), ["twice-first", "twice-first"]);

    // (f) The other order: gone1 first changes nothing (gone2 wrote main's), then gone2 skips gone1's purged v2 for v1.
    await agentWith("back", ["back-first", "back-gone1", "back-gone2"]);
    for (const [runId, said] of [["back-first", "v1"], ["back-gone1", "v2"], ["back-gone2", "v3"]]) await wrote("back", runId, said);
    const v3 = (await onMain(data, "back"));
    await purge("back-gone1");
    assert.deepEqual((await onMain(data, "back")).files, v3.files, "the purge of gone1 leaves gone2's v3 (the rewrite moves main's id, never its files)");
    await purge("back-gone2");
    assert.deepEqual((await onMain(data, "back")).files, answerAt("v1"), "the purge of gone2 puts back first's v1, never gone1's purged v2");
    assert.deepEqual(await writers("back"), ["back-first", "back-first"]);
  });
}

// The champion a start delivers is read at its promotion record's commit, older than the start's seed; the start keeps
// the run that wrote it, so a record dropped since (as the kept records' cap drops one) never lets it through, nor a
// purge through DELETE /runs/{id}, which rewrites the history the start read it from (learn/purge.ts).
// #3458's store-free cases (jobs/purge-keeps-champion 74b6749741, 54885ee672), the gate this branch's (promote.ts
// RecordLearning, a Refused set) in place of its refused port.
/** A settings double over one in-memory map, as the store's guarded writes act. */
const settingsOver = (kept, onGet = () => {}) => ({
  get: async (name) => {
    const was = kept.has(name) ? JSON.parse(kept.get(name)) : undefined;
    onGet(name, was);
    return was;
  },
  putIfAbsent: async (name, value) => (kept.has(name) ? JSON.parse(kept.get(name)) : (kept.set(name, JSON.stringify(value)), value)),
  replaceIf: async (name, was, value) => {
    if (kept.get(name) !== JSON.stringify(was)) return false;
    kept.set(name, JSON.stringify(value));
    return true;
  },
});

// The trim across two writers: a write reads the records one short of the bound, so it asks the purge gate nothing,
// then another writer lands one before its guarded write. That write would trim records it never asked the gate over:
// it reads them again and asks, and keeps the champion the gate leaves (v1's, past the purged v2). The gate here answers
// by commit (c2 holds nothing); `asked` is the commits it was asked of: once, after the landing.
test("a promotion write that another writer pushes past the trim bound asks the purge gate again and keeps the earlier champion", async () => {
  const { championOf, PROMOTIONS_KEPT, promotionsKey, recordPromotion } = await import("../dist/learn/promote.js");
  const key = promotionsKey("racing");
  const rec = (workflow, digest, decided, commit) => ({ workflow, digest, at: "t", decided, reason: "r", ...(commit ? { commit } : {}) });
  const items = [rec("answer", "v1", "promote", "c1"), rec("answer", "v2", "promote", "c2")];
  while (items.length < PROMOTIONS_KEPT - 1) items.push(rec("other", `other-${items.length}`, "hold"));
  const kept = new Map([[key, JSON.stringify({ v: 1, items })]]);
  let reads = 0;
  // Another writer lands right after this write's first read.
  const settings = settingsOver(kept, (name, was) => {
    if (++reads === 1) kept.set(name, JSON.stringify({ v: 1, items: [...was.items, rec("other", "landed", "hold")] }));
  });
  const skip = { keys: new Set(["answer\nv2\nc2"]), unread: false };
  const asked = [];
  const never = async () => assert.fail("a hold names no commit: nothing to check");
  const learning = { holds: async (_workflow, _digest, commit) => (asked.push(commit), commit !== "c2"), onMain: never, writerPurged: never };
  const done = await recordPromotion(settings, "racing", rec("other", "past", "hold"), (was) => was === undefined, learning);
  assert.equal(done.won, true);
  const after = JSON.parse(kept.get(key)).items;
  assert.deepEqual({ length: after.length, asked, champion: championOf(after, "answer", skip)?.digest ?? null }, { length: PROMOTIONS_KEPT, asked: ["c2", "c1"], champion: "v1" }, "the write asks the gate over the records it trims, the one it writes included, and v1 is still the champion past the purged v2");
});

// The pure readers of the records: the cost reads (the serving check, the bill's states) and the compile's held names
// skip a record the gate refuses as championOf does, so none of them names the purged digest.
test("the cost reads and the compile's held names skip a record the purge gate refuses: none names the purged digest", async () => {
  const { heldNamesOf } = await import("../dist/learn/compile.js");
  const { revisionLedgerOf, servingReplayOf } = await import("../dist/store-reads/learning.js");
  const check = (n) => ({ compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n, alone: n, agreed: n - 1 });
  const rec = (digest, decided, commit, extra = {}) => ({ workflow: "answer", digest, at: "t", decided, reason: "r", commit, ...extra });
  const skip = { keys: new Set(["answer\nv2\nc2"]), unread: false };
  const crowned = [rec("v1", "promote", "c1", { check: check(10) }), rec("v2", "promote", "c2", { check: check(20) })];
  const held = [...crowned, rec("v2", "hold", "c2")];
  const runs = [{ path: "workflow", workflow: "answer" }];
  const states = (records) => Object.fromEntries(revisionLedgerOf(records, [], [], [], skip).revisions.map(({ digest, state }) => [digest, state]));
  assert.deepEqual({ replay: servingReplayOf(crowned, runs, skip)?.n ?? null, states: states(crowned), held: [...heldNamesOf(held, skip)] }, { replay: 10, states: { v1: "serving", v2: "stopped" }, held: [] }, "the serving check is v1's, the bill says v1 serves, and no revision of the purged v2 is asked of the compile");
});

// Fail closed: a promotion write whose purge gate can't read a commit (the folder's backend fails) trims nothing, so no
// record the gate would keep is dropped on a guess.
test("a promotion write whose purge gate can't read a commit trims nothing: every record stays", async () => {
  const { PROMOTIONS_KEPT, promotionsKey, recordPromotion } = await import("../dist/learn/promote.js");
  const key = promotionsKey("unread");
  const rec = (workflow, digest, decided, commit) => ({ workflow, digest, at: "t", decided, reason: "r", ...(commit ? { commit } : {}) });
  const items = filledTo([rec("answer", "v1", "promote", "1".repeat(40)), rec("answer", "v2", "promote", "2".repeat(40))], PROMOTIONS_KEPT, "t");
  const kept = new Map([[key, JSON.stringify({ v: 1, items })]]);
  const settings = settingsOver(kept);
  // A learning whose every read fails, as a backend that cannot answer.
  const failing = async () => {
    throw new Error("the learning folder can't be read right now");
  };
  const learning = { holds: failing, onMain: failing, writerPurged: failing };
  const past = rec("other", "past", "hold");
  assert.equal((await recordPromotion(settings, "unread", past, (was) => was === undefined, learning)).won, true);
  assert.deepEqual(JSON.parse(kept.get(key)).items, [...items, past], "a commit read that throws trims nothing: every record stays, the new one after them");
});

// #3458 (f5567cd095): a purge that lands between a promotion write's ask of the gate and its write: the gate answered
// before the purged run was marked, so it refuses nothing, and the write's guard (the records it read) does not see a
// purge. The trim still keeps the champion promoted before the one the answer leaves, so once the purge refuses v2 its
// readers serve v1.
test("a promotion write whose gate answered before a purge keeps the champion before the one it left: after the purge v1 serves", async () => {
  const { championOf, PROMOTIONS_KEPT, promotionsKey, recordPromotion } = await import("../dist/learn/promote.js");
  const key = promotionsKey("stale");
  const rec = (workflow, digest, decided, commit) => ({ workflow, digest, at: "t", decided, reason: "r", ...(commit ? { commit } : {}) });
  const items = filledTo([rec("answer", "v1", "promote", "c1"), rec("answer", "v2", "promote", "c2")], PROMOTIONS_KEPT, "t");
  const kept = new Map([[key, JSON.stringify({ v: 1, items })]]);
  const settings = settingsOver(kept);
  // The gate's answer as it stood before the purge: none refused. The purge marks `c2`'s writer right after.
  const never = async () => assert.fail("a hold names no commit: nothing to check");
  const learning = { holds: async () => true, onMain: never, writerPurged: never };
  const past = rec("other", "past", "hold");
  assert.equal((await recordPromotion(settings, "stale", past, (was) => was === undefined, learning)).won, true);
  const after = JSON.parse(kept.get(key)).items;
  const purged = { keys: new Set(["answer\nv2\nc2"]), unread: false };
  assert.deepEqual({ length: after.length, champion: championOf(after, "answer", purged)?.digest ?? null }, { length: PROMOTIONS_KEPT, champion: "v1" }, "the write trims to the bound and keeps v1's promote, so once v2's run is purged, v1 is the champion");
});

// #3458 (0695220cf9): the same window when one run wrote two champions in a row: v2, then v3, each promoted over v1.
// The gate answered before the purge (none refused), and the purge of that run refuses both. The trim keeps a chain of
// CHAMPIONS_KEPT champions back from the one the answer leaves, so v1's promote is still there and v1 serves. Past the
// chain it fails closed as before: nothing a purged run wrote serves, and the agent takes the run.
test("a promotion write whose gate answered before a purge of a run that wrote two champions in a row keeps v1: after the purge v1 serves", async () => {
  const { CHAMPIONS_KEPT, championOf, PROMOTIONS_KEPT, promotionsKey, recordPromotion } = await import("../dist/learn/promote.js");
  const key = promotionsKey("chain");
  const rec = (workflow, digest, decided, commit) => ({ workflow, digest, at: "t", decided, reason: "r", ...(commit ? { commit } : {}) });
  const refusing = (records) => ({ keys: new Set(records.map((one) => `answer\n${one.digest}\n${one.commit}`)), unread: false });
  // The gate's answer as it stood before the purge: none refused. The purge marks the run that wrote c2 and c3 right after.
  const never = async () => assert.fail("a hold names no commit: nothing to check");
  const stale = { holds: async () => true, onMain: never, writerPurged: never };
  const past = rec("other", "past", "hold");
  const written = [rec("answer", "v2", "promote", "c2"), rec("answer", "v3", "promote", "c3")];
  const two = new Map([[key, JSON.stringify({ v: 1, items: filledTo([rec("answer", "v1", "promote", "c1"), ...written], PROMOTIONS_KEPT, "t") })]]);
  assert.equal((await recordPromotion(settingsOver(two), "chain", past, (was) => was === undefined, stale)).won, true);
  const after = JSON.parse(two.get(key)).items;
  assert.deepEqual({ length: after.length, champion: championOf(after, "answer", refusing(written))?.digest ?? null }, { length: PROMOTIONS_KEPT, champion: "v1" }, "the write trims to the bound and keeps v1's promote, so once the run that wrote v2 and v3 is purged, v1 is the champion");

  // Past the chain: one run wrote every champion after v1, CHAMPIONS_KEPT of them. v1 is trimmed, so after the purge
  // nothing serves (no purged run's revision either): it fails closed, as a champion trimmed before the purge does.
  const chain = Array.from({ length: CHAMPIONS_KEPT }, (_, i) => rec("answer", `w${i}`, "promote", `w${i}`));
  const many = new Map([[key, JSON.stringify({ v: 1, items: filledTo([rec("answer", "v1", "promote", "c1"), ...chain], PROMOTIONS_KEPT, "t") })]]);
  assert.equal((await recordPromotion(settingsOver(many), "chain", past, (was) => was === undefined, stale)).won, true);
  const capped = JSON.parse(many.get(key)).items;
  assert.deepEqual({ length: capped.length, champion: championOf(capped, "answer", refusing(chain))?.digest ?? null }, { length: PROMOTIONS_KEPT, champion: null }, "with CHAMPIONS_KEPT purged champions in a row the trim keeps none before them, and none serves");
});

// #3458 (cced5d642e): the champions before never crowd out a decision: enough workflows with CHAMPIONS_KEPT champions
// each to fill the bound, and a check decides a hold for a revision never promoted. The write says it won, so its hold
// must be there (dropped, the next claim finds no decision and pays for the same check again), and still there after the
// next write.
test("champions kept before the newest never crowd out a decision just written: the hold stays past the next write", async () => {
  const { CHAMPIONS_KEPT, championOf, PROMOTIONS_KEPT, promotionOf, promotionsKey, recordPromotion } = await import("../dist/learn/promote.js");
  const rec = (workflow, digest, decided) => ({ workflow, digest, at: "t", decided, reason: "r", commit: `${workflow}-${digest}` });
  const workflows = Array.from({ length: Math.ceil(PROMOTIONS_KEPT / CHAMPIONS_KEPT) }, (_, w) => `w${w}`);
  const kept = new Map([[promotionsKey("crowd"), JSON.stringify({ v: 1, items: workflows.flatMap((w) => Array.from({ length: CHAMPIONS_KEPT }, (_, d) => rec(w, `d${d}`, "promote"))) })]]);
  const settings = settingsOver(kept);
  // A gate that refuses nothing: every commit holds its text.
  const never = async () => assert.fail("a hold is written with no check of its commit");
  const none = { holds: async () => true, onMain: never, writerPurged: never };
  const first = await recordPromotion(settings, "crowd", rec("fresh", "n1", "hold"), (was) => was === undefined, none);
  const second = await recordPromotion(settings, "crowd", rec("fresh", "n2", "hold"), (was) => was === undefined, none);
  const items = JSON.parse(kept.get(promotionsKey("crowd"))).items;
  assert.deepEqual(
    { won: [first.won, second.won], n1: promotionOf(items, "fresh", "n1")?.decided ?? null, n2: promotionOf(items, "fresh", "n2")?.decided ?? null, champions: workflows.every((w) => championOf(items, w)?.digest === `d${CHAMPIONS_KEPT - 1}`) },
    { won: [true, true], n1: "hold", n2: "hold", champions: true },
    "both holds are kept and every workflow's champion still serves",
  );
});

// #3458 (0adfd8882d): a champion before is kept whole or not at all: its promote and its newest record (a hold since,
// here) go together. The room the newest leave is one record: kept alone, x's old promote would read as x's champion
// once the run that wrote b is purged, and the revision held for its answers would serve again.
test("a champion before that does not fit whole is dropped whole: its promote never stays without the hold after it", async () => {
  const { championOf, PROMOTIONS_KEPT, trimPromotions } = await import("../dist/learn/promote.js");
  const rec = (workflow, digest, decided, commit) => ({ workflow, digest, at: "t", decided, reason: "r", commit });
  const champions = Array.from({ length: PROMOTIONS_KEPT / 2 - 2 }, (_, z) => rec(`z${z}`, "p", "promote", `z${z}`));
  const fillers = Array.from({ length: PROMOTIONS_KEPT / 2 }, (_, i) => rec("other", `o${i}`, "hold", `o${i}`));
  const items = [rec("x", "a", "promote", "ca"), rec("x", "a", "hold", "ca"), ...fillers, rec("x", "b", "promote", "cb"), ...champions];
  assert.equal(items.length, PROMOTIONS_KEPT + 1);
  const kept = trimPromotions(items);
  const purgedB = { keys: new Set(["x\nb\ncb"]), unread: false };
  const a = kept.filter((one) => one.workflow === "x" && one.digest === "a").map((one) => one.decided);
  assert.deepEqual(
    { length: kept.length, promoteWithoutHold: a.includes("promote") && !a.includes("hold"), champion: championOf(kept, "x", purgedB)?.digest ?? null },
    { length: PROMOTIONS_KEPT, promoteWithoutHold: false, champion: null },
    "x's promote of a is never kept without its hold since, so once b's run is purged none serves",
  );

  // One further back, c, would fit where a did not: it is not kept past a, or c would serve in a's place (a, held since,
  // serves none).
  const deeper = [rec("x", "c", "promote", "cc"), ...items];
  const cutAt = trimPromotions(deeper);
  assert.deepEqual(
    { length: cutAt.length, c: cutAt.some((one) => one.workflow === "x" && one.digest === "c"), champion: championOf(cutAt, "x", purgedB)?.digest ?? null },
    { length: PROMOTIONS_KEPT, c: false, champion: null },
    "the chain is cut at a: c is not kept past it, so once b's run is purged none serves",
  );
});

for (const [kind, settingsOf] of Object.entries(STORES)) for (const via of ["the store's purge", "DELETE /runs/{id}, the history rewritten"]) test(`${kind}: an SDK start sent again never answers a workflow a purged run wrote (${via}): its receipt is 410 purged, its champion record gone or not, and a new start pins none`, async (t) => {
  const { api, data, store } = await serve(t, { runner: false });
  onStore(t, data, settingsOf());
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
    const learning = learningStoreOf(data, id);
    assert.equal(((await learning.log(await learning.head())) ?? []).some(({ sha }) => sha === merge), false, "the purge rewrote the commit the start read");
  } else await store.runs.purge(writer, { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  const again = await start("pinned");
  await store.settings.put(`learning.promotions.${id}`, { v: 1, items: [record(digestOf(v2), "hold", next)] });
  const refused = { status: 410, code: "purged", run: writer };
  assert.deepEqual({ again, dropped: await start("pinned"), fresh: await start("fresh") }, { again: refused, dropped: refused, fresh: { status: 201, workflows: [] } }, "the receipt sent again and a new start refuse the purged run's workflow");
});

