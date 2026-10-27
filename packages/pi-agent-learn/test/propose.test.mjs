import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentLearn, collectCandidates, guard, learningId, parseLearning, proposeFiles, proposeLearning, readRunBranch, renderLearning, runBranchFiles, seedLearning } from "../dist/index.js";
import { allObjects, commitCount, git, refsOf } from "./git-support.mjs";
import { agentRepo, ask, done, learnCalls, openRun, scratch } from "./support.mjs";
import { workDirWith, workflowDoc } from "./workflow-support.mjs";

const candidate = (over = {}) => ({ callId: "call-1", type: "lesson", text: "Search registries by the legal name without the suffix.", evidence: ["a 404 on the full name"], ...over });

// The run's store holds the candidates the learn tool noted, in order.
// `seed` is the sha in the run's learn.seed record, when it has one.
const targetOf = (candidates, seed) => ({
  snapshot: async (doc) =>
    doc.definition.kind === "learn.seed"
      ? (seed === undefined ? undefined : { sha: seed, index: [], omitted: [], workflows: [], copied: false })
      : { order: candidates.map((c) => c.callId), byCall: Object.fromEntries(candidates.map((c) => [c.callId, c])) },
});
/** The paths a proposal changed, sorted. */
const changed = (dir, main, sha) => git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", main, sha]).toString().trim().split("\n").sort();
const notePath = (runId, text) => `learnings/${learningId(runId, text)}.md`;
const TEXT = "Search registries by the legal name without the suffix.";
/** The memo's front matter on a run's branch. */
const memoFront = async (repo, runId, sha) => Object.fromEntries((/^---\n([\s\S]*?)\n---\n/.exec(await repo.read(`memos/${runId}.md`, sha))[1]).split("\n").map((l) => l.split(": ")));

async function seededRemote(root) {
  const { bare, main } = await agentRepo(root);
  return { dir: bare, remote: local(bare), main };
}

async function host(root, remote, name = "host") {
  return openRepo({ dir: path.join(root, name), remote });
}

const holds = (gitDir, needle) => allObjects(gitDir).includes(Buffer.from(needle));
const OPTIONS = { runId: "run-1", secrets: [], caseValues: [] };

test("a run's candidates become one commit on runs/<run id>, pushed, with main untouched", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const candidates = [candidate(), candidate({ callId: "call-2", type: "used", id: "L-0123456789ab", text: "", evidence: [] })];
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf(candidates) });
  assert.equal(result.status, "proposed");
  const refs = await refsOf(dir);
  assert.equal(refs["refs/heads/runs/run-1"], result.sha);
  assert.equal(refs["refs/heads/main"], main, "main does not move");
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1);
  const [entry] = await repo.log({ ref: "runs/run-1", max: 1 });
  assert.deepEqual(entry.trailers["Run-Id"], ["run-1"]);
  // The used mark names no learning on main, so it changes no note.
  assert.deepEqual(changed(dir, main, result.sha), ["learnings/INDEX.md", notePath("run-1", TEXT), "memos/run-1.md"].sort());
  assert.deepEqual(await memoFront(repo, "run-1", result.sha), { run: "run-1", base: main, harness: "pi", outcome: "completed", untrusted: "false" });
  const note = parseLearning(await repo.read(notePath("run-1", TEXT), result.sha));
  assert.deepEqual([note.text, note.provenance], [TEXT, { runs: ["run-1"], sha: main, untrusted: false, shaFrom: "branch-base" }], "a run that was not seeded says its branch starts at main");
});

test("the uses hook writes uses/<run id>.json beside the memo, and is guarded like it", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const uses = () => ({ workflows: [{ name: "kyb-us-registry", outcome: "clean" }] });
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]), uses });
  assert.equal(result.status, "proposed");
  assert.deepEqual(changed(dir, main, result.sha), ["learnings/INDEX.md", notePath("run-1", TEXT), "memos/run-1.md", "uses/run-1.json"].sort());
  assert.deepEqual(JSON.parse(await repo.read("uses/run-1.json", result.sha)), uses());
  const onlyUses = await proposeLearning({ ...OPTIONS, runId: "run-2", repo, target: targetOf([]), uses });
  assert.equal(onlyUses.status, "proposed", "uses alone are a proposal");
  const secret = ["Zinnia", "?>", "q7Rk2Mw"].join("");
  const leaked = await proposeLearning({ ...OPTIONS, runId: "run-3", secrets: [secret], repo, target: targetOf([]), uses: () => ({ note: `key "${secret}"` }) });
  assert.equal(leaked.status, "refused");
  assert.equal((await refsOf(dir))["refs/heads/runs/run-3"], undefined);
});

test("a planted secret refuses the whole proposal: no ref and no object holds it, raw or base64", async () => {
  const secret = ["Lantern", "?>", "x9Kd3Qa"].join("");
  for (const [name, form] of [["raw", (s) => s], ["base64", (s) => Buffer.from(`pad:${s}`).toString("base64")]]) {
    const root = await scratch();
    const { dir, remote, main } = await seededRemote(root);
    const repo = await host(root, remote);
    const candidates = [candidate(), candidate({ callId: "call-2", text: `the key is ${form(secret)}` })];
    const result = await proposeLearning({ ...OPTIONS, repo, secrets: [secret], target: targetOf(candidates) });
    assert.equal(result.status, "refused", name);
    assert.ok(result.refusals.length >= 2 && result.refusals.every((r) => r.reason === "secret_value"), name);
    assert.ok(!JSON.stringify(result.refusals).includes(secret), "a refusal never repeats the secret");
    assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, `${name}: the remote has no new ref`);
    for (const gitDir of [dir, repo.dir]) {
      assert.ok(!holds(gitDir, form(secret)) && !holds(gitDir, secret) && !holds(gitDir, "the key is"), `${name}: an object in ${path.basename(gitDir)} holds the proposal`);
    }
    assert.deepEqual(Object.keys(await refsOf(repo.dir)).filter((r) => r.includes("runs/")), [], `${name}: the host repository has no run branch`);
  }
});

test("a case value in a candidate refuses the proposal", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const result = await proposeLearning({ ...OPTIONS, repo, caseValues: ["Acme Holdings GmbH"], target: targetOf([candidate({ text: "For acme holdings gmbh use the registry." })]) });
  const text = "For acme holdings gmbh use the registry.";
  assert.deepEqual(result.refusals.map((r) => [r.reason, r.field ?? r.path]), [["case_data", notePath("run-1", text)], ["case_data", "learnings/INDEX.md"], ["case_data", "candidates[0].text"]]);
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
});

test("a rules-tier file, any other path, another run's memo and a workflow's records are refused with nothing committed", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  for (const file of ["agent.json", "AGENTS.md", "./AGENTS.md", ".git/hooks/post-commit", "inbox/run-1.md", "memos/run-2.md", ".agents/skills/x/trial.json", `workflows/kyb/${"a".repeat(64)}.json`]) {
    const result = await proposeFiles({ ...OPTIONS, repo, files: { "memos/run-1.md": "ok\n", [file]: "{}\n" } });
    assert.equal(result.status, "refused", file);
    assert.ok(result.refusals.some((r) => r.reason === "rules_locked" || r.reason === "path_not_allowed"), file);
  }
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
  assert.deepEqual(Object.keys(await refsOf(repo.dir)).filter((r) => r.includes("runs/")), []);
});

test("an invalid run id is refused, not committed", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  for (const runId of ["../x", "", "a b", "x".repeat(200)]) {
    const result = await proposeLearning({ ...OPTIONS, runId, repo, target: targetOf([candidate()]) });
    assert.equal(result.status, "refused", JSON.stringify(runId));
  }
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
});

test("no candidates and no uses is empty and touches nothing", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo, target: targetOf([]) }), { status: "empty" });
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), uses: () => undefined }), { status: "empty" });
  assert.deepEqual(await proposeFiles({ ...OPTIONS, repo, files: {} }), { status: "empty" });
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
  assert.deepEqual(Object.keys(await refsOf(repo.dir)).filter((r) => r.includes("runs/")), []);
});

test("proposing twice makes one commit, from the same host and from a restarted one with an empty local repository", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const options = { ...OPTIONS, target: targetOf([candidate()]) };
  const first = await proposeLearning({ ...options, repo: await host(root, remote, "host-1") });
  assert.equal(first.status, "proposed");
  const again = await proposeLearning({ ...options, repo: await host(root, remote, "host-1") });
  assert.deepEqual(again, { status: "already", sha: first.sha });
  const restarted = await host(root, remote, "host-2");
  assert.deepEqual(Object.keys(await refsOf(restarted.dir)).filter((r) => r.startsWith("refs/heads/")), [], "the restarted host has no local branch");
  const after = await proposeLearning({ ...options, repo: restarted, target: targetOf([candidate(), candidate({ callId: "call-9", text: "A later thought." })]) });
  assert.deepEqual(after, { status: "already", sha: first.sha });
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1);
  assert.equal(await restarted.read(notePath("run-1", "A later thought."), first.sha), undefined, "the first proposal stands");
});

test("a crash between the commit and the push: the retry pushes the same commit and makes no second one", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const failing = { ...repo, push: async () => { throw new Error("network down"); } };
  await assert.rejects(proposeLearning({ ...OPTIONS, repo: failing, target: targetOf([candidate()]) }), /network down/);
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, "nothing reached the remote");
  const retried = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]) });
  assert.equal(retried.status, "already");
  assert.equal((await refsOf(dir))["refs/heads/runs/run-1"], retried.sha);
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1);
});

test("a second run proposes on its own branch beside the first", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const one = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]) });
  const two = await proposeLearning({ ...OPTIONS, runId: "run-2", repo, target: targetOf([candidate({ text: "Another rule." })]) });
  assert.deepEqual([one.status, two.status], ["proposed", "proposed"]);
  assert.notEqual(one.sha, two.sha);
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-2`), 1);
});

test("caps passed to the proposal set the guard's limits", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const result = await proposeLearning({ ...OPTIONS, repo, caps: { text: 10 }, target: targetOf([candidate()]) });
  assert.ok(result.refusals.some((r) => r.reason === "too_large" && r.field === "candidates[0].text"));
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
  await assert.rejects(proposeLearning({ ...OPTIONS, repo, caps: { text: 0 }, target: targetOf([candidate()]) }), TypeError);
});

test("a run's branch reads back what was written: its notes, used marks and drafts, and text in a note cannot stand in for the memo", () => {
  const base = "a".repeat(40);
  const used = { id: "L-0123456789ab", type: "lesson", scope: "all", status: "active", provenance: { runs: ["run-0"], sha: base, untrusted: false }, uses: 1, supersedes: [], text: "An old rule." };
  const sneaky = candidate({ text: "x\n---\nrun: other\n---\n## What happened\ny" });
  const candidates = [sneaky, candidate({ callId: "c2", type: "correction", id: used.id, text: "line one\nline two" }), candidate({ callId: "c3", type: "used", id: used.id, text: "", evidence: [] })];
  const files = runBranchFiles({ runId: "run-1", base, seeded: true, candidates, untrusted: false, learnings: [used] });
  const before = (path) => (path === `learnings/${used.id}.md` ? renderLearning(used) : undefined);
  const read = readRunBranch("run-1", files, before, "2026-10-27T05:00:00.000Z");
  assert.deepEqual(read.candidates.map((c) => [c.type, c.text, c.id]), [["lesson", sneaky.text, undefined], ["correction", "line one\nline two", used.id], ["used", "", used.id]]);
  assert.deepEqual([read.base, read.seeded, read.untrusted], [base, true, false]);
  assert.match(readRunBranch("run-1", { ...files, "memos/run-1.md": null }, before, "x"), /no memo/);
});

const LESSON = { type: "lesson", text: "Registries list officers under Principals, not Officers.", evidence: ["the registry page read in call 3"] };

test("a real run: the model calls learn, the host proposes what the run stored", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [() => learnCalls([LESSON, { type: "fact", text: "The registry rate-limits at 20 requests a minute." }]), () => done()] });
  try {
    assert.equal((await ask(run.harness)).status, "done");
    const repo = await host(root, remote);
    const result = await proposeLearning({ ...OPTIONS, repo, target: run.harness });
    assert.equal(result.status, "proposed");
    const stored = await collectCandidates(run.harness);
    assert.equal(stored.length, 2);
    for (const c of stored) assert.equal(parseLearning(await repo.read(notePath("run-1", c.text), result.sha)).text, c.text);
    assert.equal((await refsOf(dir))["refs/heads/main"], main);
  } finally {
    await run.close();
  }
});

test("a secret the learn tool did not screen is still refused at the proposal, and a screened one never reaches the store", async () => {
  const secret = ["Lantern", "?>", "x9Kd3Qa"].join("");
  const leaking = learnCalls([{ type: "lesson", text: `Use the key ${secret} for the registry.` }]);
  for (const [name, extension] of [["unscreened", agentLearn()], ["screened", agentLearn({ guard, secrets: () => [secret] })]]) {
    const root = await scratch();
    const { dir, remote, main } = await seededRemote(root);
    const run = await openRun(path.join(root, "run.sqlite"), { extension, steps: [() => leaking, () => done()] });
    try {
      await ask(run.harness);
      const repo = await host(root, remote);
      const result = await proposeLearning({ ...OPTIONS, repo, secrets: [secret], target: run.harness });
      assert.equal(result.status, name === "unscreened" ? "refused" : "empty", name);
      assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, name);
      for (const gitDir of [dir, repo.dir]) assert.ok(!holds(gitDir, secret), `${name}: an object holds the secret`);
    } finally {
      await run.close();
    }
  }
});

const DOC = workflowDoc({ name: "kyb-us-registry" });

test("the workflows the host collected become drafts on the run's branch: the document latest names, and a README", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const { dir: work } = await workDirWith({ "kyb-us-registry": DOC });
  const target = targetOf([candidate(), candidate({ callId: "w", type: "workflow", id: "kyb-us-registry", text: "For a US company's registry.", evidence: [] })]);
  const result = await proposeLearning({ ...OPTIONS, repo, target, workDir: work });
  assert.equal(result.status, "proposed");
  assert.deepEqual(changed(dir, main, result.sha), ["learnings/INDEX.md", notePath("run-1", TEXT), "memos/run-1.md", "workflows/kyb-us-registry/README.md", "workflows/kyb-us-registry/workflow.json"].sort());
  assert.deepEqual(JSON.parse(await repo.read("workflows/kyb-us-registry/workflow.json", result.sha)), DOC);
  assert.equal(await repo.read("workflows/kyb-us-registry/README.md", result.sha), "# kyb-us-registry\n\nFor a US company's registry.\n");
  const restarted = await host(root, remote, "host-2");
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo: restarted, target, workDir: work }), { status: "already", sha: result.sha });
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1);
});

test("a draft alone is a proposal; an empty set of workflows is not", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), workflows: {} }), { status: "empty" });
  const { dir: work } = await workDirWith({ kyb: workflowDoc({ name: "kyb" }) });
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), workDir: work });
  assert.equal(result.status, "proposed");
  assert.deepEqual(changed(dir, main, result.sha), ["memos/run-1.md", "workflows/kyb/README.md", "workflows/kyb/workflow.json"]);
});

test("workflow records that are not the DSL store's, or a workflow name that is not one, refuse the whole proposal", async () => {
  const DIGEST = "0123456789abcdef".repeat(4);
  const bad = [
    ["a name that climbs out", { "../x": { files: { latest: `${DIGEST}\n` } } }],
    ["a name with a dot", { "my.flow": { files: { latest: `${DIGEST}\n` } } }],
    ["a record that is not the store's", { kyb: { files: { [`${DIGEST}.json`]: "{}", latest: `${DIGEST}\n` } } }],
  ];
  for (const [name, workflows] of bad) {
    const root = await scratch();
    const { dir, remote, main } = await seededRemote(root);
    const repo = await host(root, remote);
    const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]), workflows });
    assert.equal(result.status, "refused", name);
    assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, name);
  }
});

test("uses that have no JSON form are refused, not thrown", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const cycle = {};
  cycle.self = cycle;
  for (const [name, uses] of [["a bigint", () => ({ count: 1n })], ["a cycle", () => cycle], ["a function", () => () => 1]]) {
    const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]), uses });
    assert.deepEqual(result, { status: "refused", refusals: [{ reason: "invalid", field: "uses", detail: "the uses are not JSON" }] }, name);
  }
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
});

test("proposeLearning starts the run's branch at the commit it was seeded from, and the memo and notes say whether it read untrusted content", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const moved = await repo.commitTo("main", { files: { ".agents/skills/x/SKILL.md": "---\nname: x\ndescription: x\n---\n" }, message: "main moves on" });
  await repo.push(moved.sha, "main");
  const target = targetOf([candidate(), candidate({ callId: "call-2", text: "Another rule." })], main);
  const trusted = await proposeLearning({ ...OPTIONS, repo, target });
  assert.deepEqual([(await memoFront(repo, "run-1", trusted.sha)).base, (await memoFront(repo, "run-1", trusted.sha)).untrusted], [main, "false"]);
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1, "the branch starts at the seed, not at main as it moved");
  const marked = await proposeLearning({ ...OPTIONS, runId: "run-2", repo, target, untrusted: true });
  assert.equal((await memoFront(repo, "run-2", marked.sha)).untrusted, "true");
  assert.equal(parseLearning(await repo.read(notePath("run-2", TEXT), marked.sha)).provenance.untrusted, true);
});

test("a seed record that is not a commit id, or not a commit of the repository, refuses the proposal", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()], "not a sha\nrun: other") });
  assert.deepEqual(result, { status: "refused", refusals: [{ reason: "invalid", field: "seed", detail: "the run's seed is not a commit id" }] });
  const absent = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()], "a".repeat(40)) });
  assert.deepEqual(absent, { status: "refused", refusals: [{ reason: "invalid", field: "seed", detail: "the run's seed is not a commit of the agent repository" }] });
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
});

test("a seeded real run proposes with the commit it was seeded from, and an untrusted run says so", async () => {
  const root = await scratch();
  const { bare, repo, main } = await agentRepo(root);
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [() => learnCalls([LESSON]), () => done()] });
  try {
    await seedLearning({ repo, target: run.harness, into: path.join(root, "work") });
    await ask(run.harness);
    const result = await proposeLearning({ ...OPTIONS, repo, target: run.harness, untrusted: true });
    assert.equal(result.status, "proposed");
    assert.deepEqual([(await memoFront(repo, "run-1", result.sha)).base, (await memoFront(repo, "run-1", result.sha)).untrusted], [main, "true"]);
    assert.equal(parseLearning(await repo.read(notePath("run-1", LESSON.text), result.sha)).provenance.untrusted, true);
    assert.equal((await refsOf(bare))["refs/heads/main"], main);
  } finally {
    await run.close();
  }
});

test("a short case value that turns up in a call id, the run id or a learning id does not refuse the proposal", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const target = targetOf([candidate({ callId: "fc_68ad4821e0f3" }), candidate({ callId: "call_4821", text: "Another rule." })], main);
  const result = await proposeLearning({ ...OPTIONS, runId: "run-4821", repo, target, caseValues: ["4821"] });
  assert.equal(result.status, "proposed", JSON.stringify(result));
  assert.equal((await memoFront(repo, "run-4821", result.sha)).base, main);
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-4821`), 1);
  const leaking = await proposeLearning({ ...OPTIONS, runId: "run-2", repo, target: targetOf([candidate({ callId: "fc_1", text: "Order 4821 failed." })]), caseValues: ["4821"] });
  assert.equal(leaking.status, "refused", "what the model wrote is still checked");
  assert.ok(leaking.refusals.length >= 2 && leaking.refusals.every((r) => r.reason === "case_data"));
  assert.equal((await refsOf(dir))["refs/heads/runs/run-2"], undefined);
});
