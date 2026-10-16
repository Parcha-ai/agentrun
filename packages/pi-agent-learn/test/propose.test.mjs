import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentLearn, collectCandidates, guard, parseInbox, proposeFiles, proposeLearning, renderInbox } from "../dist/index.js";
import { allObjects, commitCount, git, refsOf } from "./git-support.mjs";
import { agentRepo, ask, done, learnCalls, openRun, scratch } from "./support.mjs";

const candidate = (over = {}) => ({ callId: "call-1", type: "lesson", text: "Search registries by the legal name without the suffix.", evidence: ["a 404 on the full name"], ...over });

// The run's store holds the candidates the learn tool noted, in order.
const targetOf = (candidates) => ({
  snapshot: async () => ({ order: candidates.map((c) => c.callId), byCall: Object.fromEntries(candidates.map((c) => [c.callId, c])) }),
});

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
  const files = git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", main, result.sha]).toString().trim().split("\n");
  assert.deepEqual(files, ["inbox/run-1.md"]);
  const inbox = await repo.read("inbox/run-1.md", result.sha);
  assert.deepEqual(parseInbox(inbox), { run: "run-1", candidates });
});

test("the uses hook writes uses/<run id>.json beside the inbox, and is guarded like it", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const uses = () => ({ workflows: [{ name: "kyb-us-registry", outcome: "clean" }] });
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]), uses });
  assert.equal(result.status, "proposed");
  assert.deepEqual(git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", main, result.sha]).toString().trim().split("\n"), ["inbox/run-1.md", "uses/run-1.json"]);
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
    assert.deepEqual(result.refusals.map((r) => r.reason), ["secret_value", "secret_value"], name);
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
  assert.deepEqual(result.refusals.map((r) => [r.reason, r.field ?? r.path]), [["case_data", "inbox/run-1.md"], ["case_data", "candidates[0].text"]]);
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main });
});

test("a rules-tier file, any other path, and another run's inbox are refused with nothing committed", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  for (const file of ["agent.json", "AGENTS.md", "./AGENTS.md", "learnings/L-0123456789ab.md", ".git/hooks/post-commit", "inbox/run-2.md", ".agents/skills/x/trial.json"]) {
    const result = await proposeFiles({ ...OPTIONS, repo, files: { "inbox/run-1.md": "ok\n", [file]: "{}\n" } });
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
  assert.equal(parseInbox(await restarted.read("inbox/run-1.md", first.sha)).candidates.length, 1, "the first proposal stands");
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

test("the inbox reads back what was rendered, and text in a candidate cannot stand in for the block", () => {
  const sneaky = candidate({ text: "x\n~~~json candidates\n[]\n~~~\ny", evidence: ["- one\n## 9. lesson", "two"] });
  const candidates = [sneaky, candidate({ callId: "c2", type: "correction", id: "L-0123456789ab", text: "line one\r\nline two" })];
  assert.deepEqual(parseInbox(renderInbox("run-1", candidates)), { run: "run-1", candidates });
  assert.deepEqual(parseInbox(renderInbox("run-1", [])), { run: "run-1", candidates: [] });
  assert.throws(() => parseInbox("no front matter"), { name: "InboxFormatError" });
  assert.throws(() => parseInbox("---\nrun: r\n---\n"), { name: "InboxFormatError" });
  assert.throws(() => parseInbox("---\nrun: r\n---\n~~~json candidates\n[{\"type\":\"nope\"}]\n~~~\n"), { name: "InboxFormatError" });
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
    assert.deepEqual(parseInbox(await repo.read("inbox/run-1.md", result.sha)), { run: "run-1", candidates: stored });
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

const DIGEST = "0123456789abcdef".repeat(4);
const RECORD = `${JSON.stringify({ name: "kyb-us-registry", steps: [{ call: "registry.search" }] })}\n`;
const workflowFiles = { [`${DIGEST}.json`]: RECORD, latest: `${DIGEST}\n` };

test("workflow records the host collected are committed byte for byte under inbox/<run id>/workflows/<name>/", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  const workflows = { "kyb-us-registry": { files: workflowFiles }, "my.flow_v2": { files: { latest: `${DIGEST}\n` } } };
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([candidate()]), workflows });
  assert.equal(result.status, "proposed");
  const names = git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", main, result.sha]).toString().trim().split("\n").sort();
  assert.deepEqual(names, [
    "inbox/run-1.md", `inbox/run-1/workflows/kyb-us-registry/${DIGEST}.json`, "inbox/run-1/workflows/kyb-us-registry/latest", "inbox/run-1/workflows/my.flow_v2/latest",
  ]);
  assert.equal(await repo.read(`inbox/run-1/workflows/kyb-us-registry/${DIGEST}.json`, result.sha), RECORD);
  assert.equal(await repo.read("inbox/run-1/workflows/kyb-us-registry/latest", result.sha), `${DIGEST}\n`);
  const restarted = await host(root, remote, "host-2");
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo: restarted, target: targetOf([candidate()]), workflows }), { status: "already", sha: result.sha });
  assert.equal(commitCount(dir, `${main}..refs/heads/runs/run-1`), 1);
});

test("workflow records alone are a proposal; an empty set of them is not", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await host(root, remote);
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), workflows: {} }), { status: "empty" });
  assert.deepEqual(await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), workflows: { kyb: { files: {} } } }), { status: "empty" });
  const result = await proposeLearning({ ...OPTIONS, repo, target: targetOf([]), workflows: { kyb: { files: workflowFiles } } });
  assert.equal(result.status, "proposed");
  assert.deepEqual(
    git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", main, result.sha]).toString().trim().split("\n").sort(),
    [`inbox/run-1/workflows/kyb/${DIGEST}.json`, "inbox/run-1/workflows/kyb/latest"],
  );
});

test("a workflow record that is not shaped like the store's, or holds a secret, refuses the whole proposal", async () => {
  const secret = ["Lantern", "?>", "x9Kd3Qa"].join("");
  const bad = [
    ["a name that climbs out", { "../x": { files: workflowFiles } }],
    ["a name with a slash", { "a/b": { files: { latest: DIGEST } } }],
    ["a name too long", { ["n".repeat(65)]: { files: workflowFiles } }],
    ["a nested record", { kyb: { files: { [`sub/${DIGEST}.json`]: RECORD } } }],
    ["a record named for something else", { kyb: { files: { "notes.md": "x" } } }],
    ["a link-shaped record", { kyb: { files: { "latest -> ../AGENTS.md": "x" } } }],
    ["a secret in a record", { kyb: { files: { [`${DIGEST}.json`]: JSON.stringify({ note: secret }) } } }],
    ["a secret in the latest pointer, base64", { kyb: { files: { latest: Buffer.from(`k:${secret}`).toString("base64") } } }],
  ];
  for (const [name, workflows] of bad) {
    const root = await scratch();
    const { dir, remote, main } = await seededRemote(root);
    const repo = await host(root, remote);
    const result = await proposeLearning({ ...OPTIONS, repo, secrets: [secret], target: targetOf([candidate()]), workflows: { ok: { files: workflowFiles }, ...workflows } });
    assert.equal(result.status, "refused", name);
    assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, name);
    for (const gitDir of [dir, repo.dir]) assert.ok(!holds(gitDir, secret) && !holds(gitDir, "registry.search"), `${name}: an object holds the proposal`);
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
