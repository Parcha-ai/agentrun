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

  // The purged run's revision was the champion: `first` wrote `answer` v1, promoted; `gone` revised it to v2, promoted
  // after it. The purge puts v1 back on main. The champion record still names v2 at `gone`'s merge, a commit every read
  // refuses (purgeGate): the champion read reads no commit, no run is served v2 and none is served v1 either (it is not
  // the champion), so the agent takes the run, as when a champion can't be read. No byte of `gone`'s text reaches a read, a run or a compile ask.
  test(`${kind}: a purge of the champion's run puts back the version before it and serves none of the purged text: the agent takes the run`, { timeout: 300_000 }, async (t) => {
    const mark = `PURGED-CHAMPION-${randomBytes(6).toString("hex")}`;
    const { api, data, store } = await serve(t, { learning: "on" });
    onStore(t, data, settingsOf());
    const first = (await startRun(api, "crowned", "What is two?", { learning: true, instructions: "Answer the question." })).run_id;
    await ended(api, first);
    const gone = await started(api, "crowned", "What is three?");
    await ended(api, gone);
    const q = await started(api, "crowned", "What is four?");
    await ended(api, q);

    const path = "workflows/answer/workflow.json";
    const [v1, v2] = [answerAt("in whole numbers"), answerAt(mark)];
    const kept = await learned(data, "crowned", (ws) => learningCommit(ws, { runId: first, reason: "It learned answer.", files: filesOf("in whole numbers") }));
    const crowned = await learned(data, "crowned", (ws) => learningCommit(ws, { runId: gone, reason: "It revised answer.", files: filesOf(mark) }));
    const at = new Date().toISOString();
    await store.settings.put("learning.promotions.crowned", { v: 1, items: [
      { workflow: "answer", digest: digestOf(v1[path]), at, decided: "promote", reason: "checked: promoted", commit: kept },
      { workflow: "answer", digest: digestOf(v2[path]), at, decided: "promote", reason: "checked: promoted", commit: crowned },
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
    assert.deepEqual(await reads("What is seven times six?"), { holds: false, champion: null, served: null }, "no read, run or compile ask holds v2; the champion read reads no commit for v2's record, so the agent takes the run");
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

