import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import { local, openRepo } from "@parcha/pi-git-remote";
import {
  admitWorkflow, collectUses, collectWorkflows, createGuard, inboxWorkflowFiles, LearnError, MAX_RUN_WORKFLOWS, parseRunUses, parseTrial, proposeLearning, readTrial,
  readSessionUses, readTrialIn, readUses, renderSkill, seedWorkflows, sessionEntries, settleWorkflowUses, usesSource, workflowsToTry,
} from "../dist/index.js";
import { agentRepo, scratch } from "./support.mjs";
import { curateStep, runStoreWith, workDirWith, workflowDoc } from "./workflow-support.mjs";

const AT = "2026-10-16T08:00:00.000Z";
const at = (h, m = 0) => `2026-10-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const WHEN = "Look up a company in a US state registry by its legal name.";
const guard = createGuard();
const records = async (workDir, name, digest) => ({
  [`${digest}.json`]: await readFile(path.join(workDir, ".pi/agentrun/workflows", name, `${digest}.json`), "utf8"),
  latest: `${digest}\n`,
});
const kyb = { name: "kyb-registry", description: WHEN };
/** A run's store that holds no `learn` calls. */
const noCandidates = { snapshot: async () => ({ order: [], byCall: {} }) };

/** Admits `doc` as `name`, as curate would for the records a run saved: one commit on main. */
async function admitted(repo, { name = kyb.name, doc = workflowDoc(), run = "author", description = WHEN, when = AT, allowExecutableCode = false } = {}) {
  // `description: null` hands over the records alone, as a run that saved a workflow and noted no workflow learning does.
  const { dir, saved } = await workDirWith({ [name]: doc });
  const digest = saved[name];
  const { sha, result } = await curateStep(repo, async (checkout) => admitWorkflow({
    dir: checkout, runId: run, name, ...(description === null ? {} : { description }), records: await records(dir, name, digest), now: () => new Date(when), allowExecutableCode,
  }));
  return { sha, result, digest };
}

/** The run's uses as a `uses/<run id>.json` holds them. */
const usesOf = (run, ...list) => ({ version: 1, run, uses: list.map(([name, sha256, outcome, when]) => ({ name, sha256, outcome, at: when })) });
const settle = (repo, uses, options = {}) => curateStep(repo, (dir) => settleWorkflowUses({ dir, uses, ...options }));
const checkoutOf = async (repo, sha) => {
  await repo.fetch();
  const dir = path.join(await scratch(), "checkout");
  await mkdir(dir);
  await repo.checkout(sha, { into: dir });
  return dir;
};

test("a workflow a run saved travels run, inbox, curate: its records load through the DSL's store at the new commit, with a skill and a trial beside them", async () => {
  const root = await scratch();
  const { bare, repo, main } = await agentRepo(root);
  const { dir: workDir, saved } = await workDirWith({ [kyb.name]: workflowDoc() });
  const digest = saved[kyb.name];

  const collected = await collectWorkflows({ repo, workDir, seedSha: main });
  assert.deepEqual(collected.skipped, []);
  assert.deepEqual(collected.found.map((f) => [f.name, f.sha256, Object.keys(f.files).sort()]), [[kyb.name, digest, [`${digest}.json`, "latest"]]]);
  assert.equal(collected.found[0].files[`${digest}.json`], await readFile(path.join(workDir, ".pi/agentrun/workflows", kyb.name, `${digest}.json`), "utf8"), "the record is copied byte for byte");
  assert.equal(collected.found[0].files.latest, `${digest}\n`);
  const inbox = inboxWorkflowFiles("run-1", collected.found);
  assert.deepEqual(Object.keys(inbox).sort(), [`inbox/run-1/workflows/${kyb.name}/${digest}.json`, `inbox/run-1/workflows/${kyb.name}/latest`]);
  assert.deepEqual(Object.keys(collected.records), [kyb.name]);
  const proposed = await proposeLearning({ repo, runId: "run-1", target: noCandidates, workflows: collected.records });
  assert.equal(proposed.status, "proposed", "the run's own guard admits its workflow records");

  // Curate is another process: it reads the run's branch from the remote and writes main.
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  await curator.fetch();
  const handed = {};
  for (const entry of await curator.list(`inbox/run-1/workflows/${kyb.name}`, proposed.sha)) handed[path.posix.basename(entry.path)] = await curator.read(entry.path, proposed.sha);
  const { sha, result } = await curateStep(curator, (dir) => admitWorkflow({ dir, runId: "run-1", name: kyb.name, description: WHEN, records: handed, now: () => new Date(AT) }));
  assert.equal(result.status, "admitted");
  assert.equal(result.sha256, digest);
  assert.deepEqual(Object.keys(result.files).sort(), [
    `.agents/skills/${kyb.name}/SKILL.md`, `.agents/skills/${kyb.name}/trial.json`, `.pi/agentrun/workflows/${kyb.name}/${digest}.json`, `.pi/agentrun/workflows/${kyb.name}/latest`,
  ]);
  assert.deepEqual(guard({ role: "curate", files: result.files }), [], "the guard admits exactly what curate writes");

  const fresh = await openRepo({ dir: path.join(root, "fresh"), remote: local(bare) });
  const dir = await checkoutOf(fresh, sha);
  const store = new WorkflowStore(dir);
  const loaded = await store.load(kyb.name);
  assert.equal(loaded.digest, digest, "latest names the admitted revision");
  assert.deepEqual(loaded.workflow, workflowDoc());
  assert.deepEqual((await store.list()).map((r) => [r.name, r.digest]), [[kyb.name, digest]]);
  const skill = await readFile(path.join(dir, `.agents/skills/${kyb.name}/SKILL.md`), "utf8");
  assert.equal(skill, renderSkill(kyb.name, WHEN));
  assert.match(skill, new RegExp(`^---\\nname: ${kyb.name}\\ndescription: ${JSON.stringify(WHEN).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n---\\n`));
  assert.match(skill, /Run it with the agentrun tool: load the workflow named kyb-registry, then run it with this case's input\./);
  assert.match(skill, /If it escalates, fails, or its answer does not fit the case, continue the task yourself\./);
  assert.deepEqual(parseTrial(await readFile(path.join(dir, `.agents/skills/${kyb.name}/trial.json`), "utf8"), kyb.name), {
    name: kyb.name, status: "trial",
    when: [{ pointer: "/sku", op: "exists" }, { pointer: "/amount", op: "exists" }, { pointer: "/amount", op: "gte", value: 0 }, { pointer: "/amount", op: "lte", value: 1000 }],
    revisions: [{ sha256: digest, status: "trial", since: AT, run: "run-1" }], uses: [],
  });
  assert.equal((await readTrialIn(dir, kyb.name)).status, "trial");
  assert.deepEqual(await workflowsToTry({ repo: fresh, sha }, { sku: "A-1", amount: 5 }), [{ name: kyb.name, status: "trial" }]);
});

test("the same revision proposed again changes nothing, and the same candidate admitted twice makes one trial", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const first = await admitted(repo);
  assert.equal(first.result.status, "admitted");
  const again = await admitted(repo, { run: "run-2", when: at(9) });
  assert.deepEqual([again.result.status, again.result.files, again.sha], ["unchanged", {}, first.sha]);
  const trial = await readTrial(repo, kyb.name, first.sha);
  assert.deepEqual(trial.revisions, [{ sha256: first.digest, status: "trial", since: AT, run: "author" }]);
});

test("preconditions decide what is tried: a workflow is offered for an input it fits and for no other", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const { sha } = await admitted(repo, { doc: workflowDoc({ country: true }) });
  const offered = (input) => workflowsToTry({ repo, sha }, input);
  assert.deepEqual(await offered({ sku: "A-1", amount: 5, country: "us" }), [{ name: kyb.name, status: "trial" }]);
  assert.deepEqual(await offered({ sku: "A-1", amount: 5, country: "ca", extra: true }), [{ name: kyb.name, status: "trial" }], "other fields do not matter");
  assert.deepEqual(await offered({ sku: "A-1", amount: 5, country: "mx" }), [], "a value outside the enumeration");
  assert.deepEqual(await offered({ sku: "A-1", amount: 5 }), [], "a missing required field");
  assert.deepEqual(await offered({ sku: "A-1", amount: 1001, country: "us" }), [], "above the bound");
  assert.deepEqual(await offered({ sku: "A-1", amount: "5", country: "us" }), [], "a string is not a number");
  assert.deepEqual(await offered("price a widget"), [], "an input that is prose has none of the fields");
  assert.deepEqual(await offered(undefined), []);
});

test("what is offered: live workflows only, active before trial, then by name, and a damaged trial.json is passed over", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  await admitted(repo, { name: "zeta-flow" });
  await admitted(repo, { name: "alpha-flow", run: "a2" });
  const beta = await admitted(repo, { name: "beta-flow", run: "a3" });
  // beta-flow earns its promotion; zeta-flow stays a trial; alpha-flow is promoted too.
  let sha = beta.sha;
  for (const name of ["beta-flow", "alpha-flow"]) {
    for (const [i, run] of ["u1", "u2", "u3"].entries()) sha = (await settle(repo, usesOf(run, [name, beta.digest, "frozen", at(10, i)]))).sha;
  }
  assert.deepEqual(await workflowsToTry({ repo, sha }, { sku: "A", amount: 1 }), [
    { name: "alpha-flow", status: "active" }, { name: "beta-flow", status: "active" }, { name: "zeta-flow", status: "trial" },
  ]);
  const broken = await repo.commitTo("main", { files: { ".agents/skills/zeta-flow/trial.json": "{ not json" }, message: "a damaged trial" });
  await repo.push(broken.sha, "main");
  assert.deepEqual((await workflowsToTry({ repo, sha: broken.sha }, { sku: "A", amount: 1 })).map((h) => h.name), ["alpha-flow", "beta-flow"]);
  const noRecord = await repo.commitTo("main", { files: { [`.pi/agentrun/workflows/alpha-flow/${beta.digest}.json`]: null }, message: "its record is gone" });
  await repo.push(noRecord.sha, "main");
  assert.deepEqual((await workflowsToTry({ repo, sha: noRecord.sha }, { sku: "A", amount: 1 })).map((h) => h.name), ["beta-flow"], "a workflow whose record is not there cannot run");
});

test("promotion on receipts through git: three clean uses promote, a changed revision that fails twice rolls back, the failed one is never tried again", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const first = await admitted(repo, { run: "author-1" });
  const d1 = first.digest;
  const status = async (sha) => (await readTrial(repo, kyb.name, sha)).status;
  let sha = first.sha;

  // The writer's own use is no evidence; three other runs' clean uses promote.
  const own = await settle(repo, usesOf("author-1", [kyb.name, d1, "frozen", at(9)]));
  assert.deepEqual(own.result.ignored.map((i) => [i.name, i.reason]), [[kyb.name, "author"]]);
  assert.deepEqual(own.result.files, {}, "nothing changed, so there is nothing to commit");
  for (const [i, run] of ["r1", "r2", "r3"].entries()) {
    const step = await settle(repo, usesOf(run, [kyb.name, d1, "frozen", at(10, i)]));
    assert.deepEqual(guard({ role: "curate", files: step.result.files }), []);
    sha = step.sha;
    assert.equal(await status(sha), i === 2 ? "active" : "trial");
  }
  assert.deepEqual((await workflowsToTry({ repo, sha }, { sku: "A", amount: 1 })), [{ name: kyb.name, status: "active" }]);

  // A run improves the workflow: its revision is a trial, the old one is kept to come back to.
  const second = await admitted(repo, { doc: workflowDoc({ country: true }), run: "author-2", when: at(11), description: "Look up a company in a US or Canadian registry." });
  const d2 = second.digest;
  assert.notEqual(d2, d1);
  let dir = await checkoutOf(repo, second.sha);
  assert.equal((await new WorkflowStore(dir).load(kyb.name)).digest, d2, "the store's latest is the trial");
  let trial = await readTrial(repo, kyb.name, second.sha);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[d1, "superseded"], [d2, "trial"]]);
  assert.ok(trial.when.some((c) => c.pointer === "/country" && c.op === "in"));
  assert.deepEqual(trial.uses.length, 3);

  // It escalates, then fails: demoted, and the first revision is active again, with its own preconditions and as `latest`.
  const bad = await settle(repo, usesOf("r4", [kyb.name, d2, "escalated", at(12)]));
  assert.equal(await status(bad.sha), "trial", "one is not two");
  const rolled = await settle(repo, usesOf("r5", [kyb.name, d2, "failed", at(13)]));
  assert.deepEqual(rolled.result.decisions.map((d) => [d.name, d.decision.action, d.decision.rollbackTo, d.at]), [[kyb.name, "demote", d1, at(13)]]);
  assert.deepEqual(guard({ role: "curate", files: rolled.result.files }), []);
  assert.deepEqual(Object.keys(rolled.result.files).sort(), [`.agents/skills/${kyb.name}/trial.json`, `.pi/agentrun/workflows/${kyb.name}/latest`]);
  trial = await readTrial(repo, kyb.name, rolled.sha);
  assert.deepEqual([trial.status, trial.revisions.map((r) => [r.sha256, r.status])], ["active", [[d1, "active"], [d2, "demoted"]]]);
  assert.deepEqual(trial.when, [{ pointer: "/sku", op: "exists" }, { pointer: "/amount", op: "exists" }, { pointer: "/amount", op: "gte", value: 0 }, { pointer: "/amount", op: "lte", value: 1000 }]);
  dir = await checkoutOf(repo, rolled.sha);
  assert.equal((await new WorkflowStore(dir).load(kyb.name)).digest, d1, "the store's latest is the restored revision");
  assert.deepEqual(await workflowsToTry({ repo, sha: rolled.sha }, { sku: "A", amount: 1 }), [{ name: kyb.name, status: "active" }]);

  // The demoted revision proposed again is refused.
  const again = await admitted(repo, { doc: workflowDoc({ country: true }), run: "author-3", when: at(14) });
  assert.deepEqual([again.result.status, again.result.reason], ["refused", "demoted"]);

  // The restored one then fails twice since it came back: nothing is left to restore, the skill goes, the history stays.
  const nothing = [];
  for (const [i, run] of ["r6", "r7"].entries()) nothing.push(await settle(repo, usesOf(run, [kyb.name, d1, "failed", at(15, i)])));
  const last = nothing.at(-1);
  assert.deepEqual(last.result.decisions.map((d) => [d.decision.action, d.decision.rollbackTo]), [["demote", null]]);
  assert.deepEqual(last.result.files[`.agents/skills/${kyb.name}/SKILL.md`], null);
  assert.deepEqual(guard({ role: "curate", files: last.result.files }), []);
  trial = await readTrial(repo, kyb.name, last.sha);
  assert.deepEqual([trial.status, trial.revisions.map((r) => r.status)], ["demoted", ["demoted", "demoted"]]);
  assert.equal(await repo.read(`.agents/skills/${kyb.name}/SKILL.md`, last.sha), undefined);
  assert.deepEqual(await workflowsToTry({ repo, sha: last.sha }, { sku: "A", amount: 1 }), []);
  assert.equal(trial.uses.length, 7, "the history is kept: every use but the writer's own");
});

test("a use of a workflow with no trial, or of a revision the trial does not hold, is left out and named", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  await admitted(repo);
  const step = await settle(repo, usesOf("r1", ["no-such-flow", "a".repeat(64), "frozen", at(9)], [kyb.name, "b".repeat(64), "frozen", at(9)]));
  assert.deepEqual(step.result.ignored.map((i) => [i.name, i.reason]).sort(), [["kyb-registry", "unknown_revision"], ["no-such-flow", "unknown_revision"]]);
  assert.deepEqual(step.result.files, {});
});

test("a rollback skips a superseded revision whose record the store can no longer load", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const docs = [workflowDoc({ limit: 10 }), workflowDoc({ limit: 20 }), workflowDoc({ limit: 30 })];
  const digests = [];
  let sha;
  for (const [i, doc] of docs.entries()) {
    const step = await admitted(repo, { doc, run: `author-${i}`, when: at(8 + i * 3) });
    digests.push(step.digest);
    sha = step.sha;
    if (i < 2) for (const [j, run] of ["u1", "u2", "u3"].entries()) sha = (await settle(repo, usesOf(`${run}-${i}`, [kyb.name, step.digest, "frozen", at(9 + i * 3, j)]))).sha;
  }
  // The middle revision's record is lost from main: it cannot run, so the demotion goes back past it.
  const lost = await repo.commitTo("main", { files: { [`.pi/agentrun/workflows/${kyb.name}/${digests[1]}.json`]: null }, message: "lose a record" });
  await repo.push(lost.sha, "main");
  const step = await curateStep(repo, (dir) => settleWorkflowUses({ dir, uses: usesOf("x1", [kyb.name, digests[2], "failed", at(20)], [kyb.name, digests[2], "failed", at(21)]) }));
  assert.deepEqual(step.result.decisions.map((d) => [d.decision.action, d.decision.rollbackTo, d.decision.skipped]), [["demote", digests[0], [digests[1]]]]);
  const dir = await checkoutOf(repo, step.sha);
  assert.equal((await new WorkflowStore(dir).load(kyb.name)).digest, digests[0]);
});

test("admitting refuses what must not run unreviewed or is not what it says, and says why", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const { dir: workDir, saved } = await workDirWith({ [kyb.name]: workflowDoc(), "with-code": workflowDoc({ code: true }), under_score: workflowDoc() });
  const good = await records(workDir, kyb.name, saved[kyb.name]);
  const admit = async (input) => (await curateStep(repo, (dir) => admitWorkflow({ dir, runId: "run-1", name: kyb.name, description: WHEN, now: () => new Date(AT), ...input }))).result;
  const refused = (result, reason) => assert.deepEqual([result.status, result.reason], ["refused", reason], result.detail);

  refused(await admit({ name: "under_score", records: await records(workDir, "under_score", saved.under_score) }), "name");
  refused(await admit({ name: "Kyb", records: good }), "name");
  refused(await admit({ name: "kyb-registry", records: { ...good, "notes.txt": "hello" } }), "records");
  refused(await admit({ records: { [Object.keys(good)[0]]: good[Object.keys(good)[0]] } }), "records");
  refused(await admit({ records: { ...good, latest: `${"c".repeat(64)}\n` } }), "records");
  refused(await admit({ records: { ...good, latest: "not a digest\n" } }), "records");
  const file = Object.keys(good).find((f) => f.endsWith(".json"));
  refused(await admit({ records: { ...good, [file]: good[file].replace('"registry-lookup"', '"another-name"') } }), "records");
  refused(await admit({ records: { ...good, [file]: `${good[file]}{}` } }), "records");
  refused(await admit({ name: "with-code", records: await records(workDir, "with-code", saved["with-code"]) }), "code");
  refused(await admit({ records: undefined }), "unknown");
  refused(await admit({ records: good, description: "   " }), "description");
  refused(await admit({ records: good, description: "x".repeat(1001) }), "description");
  refused(await admit({ records: good, description: 42 }), "description");
  assert.equal(await repo.resolve("main").then((sha) => repo.read(`.agents/skills/${kyb.name}/trial.json`, sha)), undefined, "nothing was committed");

  const coded = await admit({ name: "with-code", records: await records(workDir, "with-code", saved["with-code"]), allowExecutableCode: true });
  assert.equal(coded.status, "admitted", "a host may admit code");
});

test("a workflow admitted without a description stays out of what is tried until a workflow learning describes it", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const bare = await admitted(repo, { description: null });
  assert.equal(bare.result.status, "admitted");
  assert.deepEqual(Object.keys(bare.result.files).sort(), [`.agents/skills/${kyb.name}/trial.json`, `.pi/agentrun/workflows/${kyb.name}/${bare.digest}.json`, `.pi/agentrun/workflows/${kyb.name}/latest`].sort());
  assert.deepEqual(await workflowsToTry({ repo, sha: bare.sha }, { sku: "A", amount: 1 }), []);
  const described = await curateStep(repo, (dir) => admitWorkflow({ dir, runId: "run-2", name: kyb.name, description: WHEN }));
  assert.deepEqual([described.result.status, Object.keys(described.result.files)], ["described", [`.agents/skills/${kyb.name}/SKILL.md`]]);
  assert.deepEqual(await workflowsToTry({ repo, sha: described.sha }, { sku: "A", amount: 1 }), [{ name: kyb.name, status: "trial" }]);
  const again = await curateStep(repo, (dir) => admitWorkflow({ dir, runId: "run-3", name: kyb.name, description: WHEN }));
  assert.deepEqual([again.result.status, again.result.files], ["unchanged", {}]);
  const reworded = await curateStep(repo, (dir) => admitWorkflow({ dir, runId: "run-3", name: kyb.name, description: "Quote a SKU." }));
  assert.equal(reworded.result.status, "described");
  assert.equal(await repo.read(`.agents/skills/${kyb.name}/SKILL.md`, reworded.sha), renderSkill(kyb.name, "Quote a SKU."));
});

test("a checkout with a link where a directory should be is refused, never written through", async () => {
  const { dir: workDir, saved } = await workDirWith({ [kyb.name]: workflowDoc() });
  const outside = path.join(await scratch(), "outside");
  await mkdir(outside);
  const checkout = path.join(await scratch(), "checkout");
  await mkdir(path.join(checkout, ".agents"), { recursive: true });
  await symlink(outside, path.join(checkout, ".agents", "skills"));
  await assert.rejects(admitWorkflow({ dir: checkout, runId: "run-1", name: kyb.name, description: WHEN, records: await records(workDir, kyb.name, saved[kyb.name]) }), (e) => e instanceof LearnError && e.code === "invalid");
  assert.deepEqual(await readFile(path.join(outside, kyb.name, "SKILL.md")).catch((e) => e.code), "ENOENT");
  await assert.rejects(admitWorkflow({ dir: "relative/dir", runId: "run-1", name: kyb.name }), (e) => e instanceof LearnError);
});

// ------------------------------------------------------------ what a run hands over

test("a workflow the run was seeded with and did not change is not proposed; a changed revision, a new name and nothing else are", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const { sha } = await admitted(repo);
  const { dir: workDir } = await workDirWith();
  const seeded = await seedWorkflows({ repo, sha, into: workDir, workflows: [{ name: kyb.name, status: "trial" }, { name: "not-there", status: "trial" }] });
  assert.deepEqual(seeded.loaded.map((l) => l.name), [kyb.name]);
  assert.deepEqual(seeded.skipped.map((s) => s.name), ["not-there"]);
  const store = new WorkflowStore(workDir);
  assert.equal((await store.load(kyb.name)).digest, (await readTrial(repo, kyb.name, sha)).revisions[0].sha256, "the agentrun tool finds it by name");
  assert.deepEqual((await collectWorkflows({ repo, workDir, seedSha: sha })).found, [], "seeded and unchanged");

  const changed = (await store.save(kyb.name, workflowDoc({ limit: 55 }))).digest;
  await store.save("other-flow", workflowDoc({ limit: 5 }));
  const found = (await collectWorkflows({ repo, workDir, seedSha: sha })).found;
  assert.deepEqual(found.map((f) => [f.name, f.sha256]), [[kyb.name, changed], ["other-flow", (await store.load("other-flow")).digest]]);
  // The agent saved a draft and then a better one: only where it ended is handed over.
  await store.save("other-flow", workflowDoc({ limit: 6 }));
  const final = (await collectWorkflows({ repo, workDir, seedSha: sha })).found.find((f) => f.name === "other-flow");
  assert.equal(final.sha256, (await store.load("other-flow")).digest);
  assert.deepEqual(Object.keys(final.files).sort(), [`${final.sha256}.json`, "latest"]);
});

test("what a run leaves in its store cannot stop it proposing: names pi cannot load, oversize records, a stray file and too many workflows are named, not fatal", async () => {
  const root = await scratch();
  const { repo, main } = await agentRepo(root);
  const { dir: workDir, store } = await workDirWith({ "fine-flow": workflowDoc(), under_score: workflowDoc() });
  const big = workflowDoc();
  big.schemas.Big = { type: "object", description: "x".repeat(40_000) };
  await store.save("big-flow", big);
  const out = await collectWorkflows({ repo, workDir, seedSha: main });
  assert.deepEqual(out.found.map((f) => f.name), ["fine-flow"]);
  assert.deepEqual(out.skipped.map((s) => s.name).sort(), ["big-flow", "under_score"]);
  assert.match(out.skipped.find((s) => s.name === "under_score").reason, /not a skill name/);
  assert.match(out.skipped.find((s) => s.name === "big-flow").reason, /cap/);

  const many = await workDirWith(Object.fromEntries(Array.from({ length: MAX_RUN_WORKFLOWS + 2 }, (_, i) => [`flow-${String.fromCharCode(97 + i)}`, workflowDoc()])));
  const capped = await collectWorkflows({ repo, workDir: many.dir, seedSha: main });
  assert.equal(capped.found.length, MAX_RUN_WORKFLOWS);
  assert.deepEqual(capped.skipped.map((s) => s.name), ["flow-i", "flow-j"]);

  await writeFile(path.join(workDir, ".pi/agentrun/workflows/fine-flow/notes.txt"), "the agent left this");
  const junk = await collectWorkflows({ repo, workDir, seedSha: main });
  assert.deepEqual(junk.found, []);
  assert.match(junk.skipped[0].reason, /workflow store could not be read/);
  assert.deepEqual((await collectWorkflows({ repo, workDir: (await workDirWith()).dir, seedSha: main })).found, [], "no store at all");
  await assert.rejects(collectWorkflows({ repo, workDir: "relative", seedSha: main }), LearnError);
});

// ------------------------------------------------------------ uses, read from a run's store

test("a run's uses are read from its store: what finished, how, and under which saved name, and nothing a run did not finish", async () => {
  const doc = workflowDoc();
  const { dir: workDir, saved } = await workDirWith({ [kyb.name]: doc });
  const digest = saved[kyb.name];
  const before = Date.now();
  const store = await runStoreWith([
    { key: "a-frozen", workflow: doc, input: { sku: "A-1", amount: 5 } },
    { key: "b-escalated", workflow: doc, input: { sku: "A-2", amount: 500 } },
    { key: "c-failed", workflow: doc, input: { sku: "A-3", amount: 5 }, fail: true },
    { key: "d-unsaved", workflow: workflowDoc({ limit: 7 }), input: { sku: "A-4", amount: 5 } },
    { key: "e-cancelled", workflow: doc, input: { sku: "A-5", amount: 5 }, stop: "cancel" },
    { key: "f-paused", workflow: doc, input: { sku: "A-6", amount: 5 }, stop: "pause" },
  ]);
  const after = Date.now();
  const read = await readUses({ store, workDir, run: "run-9" });
  assert.equal(read.doc.version, 1);
  assert.equal(read.doc.run, "run-9");
  assert.deepEqual(read.doc.uses.map((u) => [u.name, u.sha256, u.outcome]), [[kyb.name, digest, "frozen"], [kyb.name, digest, "escalated"], [kyb.name, digest, "failed"]]);
  for (const use of read.doc.uses) {
    assert.match(use.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Date.parse(use.at) >= before - 1000 && Date.parse(use.at) <= after + 1000, "the use's time is when its task ended");
  }
  assert.deepEqual(read.skipped.map((s) => s.reason).sort(), ["run e-cancelled: ended aborted, which says nothing about the workflow", "run f-paused: not finished"]);
  assert.deepEqual(parseRunUses(JSON.stringify(read.doc), "run-9"), read.doc);
  assert.deepEqual(await collectUses({ store, workDir, run: "run-9" }), read.doc);
  assert.deepEqual(await usesSource({ store, workDir, run: "run-9" })({}), read.doc);
});

test("a run key started again after a failure is one use, by its last task; a run that used no saved workflow has no uses", async () => {
  const doc = workflowDoc();
  const { dir: workDir } = await workDirWith({ [kyb.name]: doc });
  const store = await runStoreWith([{ key: "g", workflow: doc, input: { sku: "A-1", amount: 5 }, fail: true, again: true }]);
  const read = await readUses({ store, workDir, run: "run-1" });
  assert.deepEqual(read.doc.uses.map((u) => u.outcome), ["failed"]);
  const other = await workDirWith({ elsewhere: workflowDoc({ limit: 3 }) });
  assert.equal((await readUses({ store, workDir: other.dir, run: "run-1" })).doc, undefined, "its workflow is not one this run's store holds");
  assert.equal(await collectUses({ store, workDir: other.dir, run: "run-1" }), undefined);
  await assert.rejects(readUses({ store: "/no/such/run.sqlite", workDir, run: "run-1" }), (e) => e instanceof LearnError && e.code === "missing");
  await assert.rejects(readUses({ store, workDir, run: "../x" }), (e) => e instanceof LearnError && e.code === "invalid");
  const junk = await workDirWith({ [kyb.name]: doc });
  await writeFile(path.join(junk.dir, ".pi/agentrun/workflows", kyb.name, "stray"), "x");
  const damaged = await readUses({ store, workDir: junk.dir, run: "run-1" });
  assert.equal(damaged.doc, undefined);
  assert.match(damaged.skipped[0].reason, /workflow store could not be read/);
});

test("the receipts the agentrun pi tool leaves in its session give the same uses", async () => {
  const doc = workflowDoc();
  const { dir: workDir, saved } = await workDirWith({ [kyb.name]: doc });
  const digest = saved[kyb.name];
  const report = (status, over = {}) => ({ digest, status, calls: { agent: 0, judge: 0, tool: 1 }, events: [], ...over });
  const snapshot = (runId, status, over = {}) => ({ type: "custom", customType: "agentrun:snapshot", data: { version: 1, workflow: doc, input: {}, savedName: kyb.name, runId, createdAt: at(9), ...(status ? { report: report(status) } : {}), ...over } });
  const entries = [
    snapshot("r-1", undefined, { running: true }),
    snapshot("r-1", "complete", { createdAt: at(9, 1) }),
    snapshot("r-2", "escalated", { createdAt: at(9, 2) }),
    snapshot("r-3", "failed", { createdAt: at(9, 3) }),
    snapshot("r-4", "interrupted"),
    { type: "message", message: "hello" },
    snapshot("r-5", "complete", { report: report("complete", { digest: "f".repeat(64) }) }),
    snapshot("r-6", "complete", { savedName: "other-name", createdAt: at(9, 6) }),
    snapshot("r-7", "complete", { createdAt: "yesterday" }),
  ];
  const read = await readSessionUses({ entries, workDir, run: "run-9" });
  assert.deepEqual(read.doc.uses.map((u) => [u.name, u.sha256, u.outcome, u.at]), [
    [kyb.name, digest, "frozen", at(9, 1)], [kyb.name, digest, "escalated", at(9, 2)], [kyb.name, digest, "failed", at(9, 3)], [kyb.name, digest, "frozen", at(9, 6)],
  ]);
  assert.deepEqual(read.skipped.map((s) => s.reason), ["run r-4: ended interrupted, which says nothing about the workflow", "run r-7 has no end time"]);
  const file = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{"torn`;
  assert.equal(sessionEntries(file).length, entries.length);
  assert.deepEqual(await collectUses({ entries: sessionEntries(file), workDir, run: "run-9" }), read.doc);
  assert.equal((await readSessionUses({ entries: [], workDir, run: "run-9" })).doc, undefined);
  await assert.rejects(readSessionUses({ entries: "x", workDir, run: "run-9" }), LearnError);
});

test("a uses file that is not exactly what collectUses writes is refused", () => {
  const ok = { version: 1, run: "run-1", uses: [{ name: "kyb-registry", sha256: "a".repeat(64), outcome: "frozen", at: AT }] };
  assert.deepEqual(parseRunUses(JSON.stringify(ok), "run-1"), ok);
  const refuses = (value, run = "run-1") => assert.throws(() => parseRunUses(typeof value === "string" ? value : JSON.stringify(value), run), (e) => e instanceof LearnError && e.code === "format");
  refuses("{");
  refuses({ ...ok, version: 2 });
  refuses({ ...ok, extra: 1 });
  refuses(ok, "run-2");
  refuses({ ...ok, uses: [{ ...ok.uses[0], outcome: "clean" }] });
  refuses({ ...ok, uses: [{ ...ok.uses[0], name: "Kyb_Registry" }] });
  refuses({ ...ok, uses: [{ ...ok.uses[0], sha256: "abc" }] });
  refuses({ ...ok, uses: [{ ...ok.uses[0], at: "2026-02-31T00:00:00.000Z" }] });
  refuses({ ...ok, uses: Array.from({ length: 33 }, () => ok.uses[0]) });
});

test("end to end with no model: a run saves a workflow, curate admits it, three later runs use it from their own stores, and it is promoted", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const doc = workflowDoc();
  const input = { sku: "A-1", amount: 5 };
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });

  // Run 1 authors the workflow and proposes it.
  const { dir: authorDir, saved } = await workDirWith({ [kyb.name]: doc });
  const digest = saved[kyb.name];
  const seed0 = await repo.resolve("main");
  const collected = await collectWorkflows({ repo, workDir: authorDir, seedSha: seed0 });
  assert.equal((await proposeLearning({ repo, runId: "run-1", target: noCandidates, workflows: collected.records })).status, "proposed");
  await curator.fetch();
  const handed = {};
  for (const entry of await curator.list(`inbox/run-1/workflows/${kyb.name}`, await curator.resolve("runs/run-1"))) handed[path.posix.basename(entry.path)] = await curator.read(entry.path, await curator.resolve("runs/run-1"));
  // Admitted in the past, so that the later runs, which really happen now, come after the standing it gave the trial.
  let main = (await curateStep(curator, (dir) => admitWorkflow({ dir, runId: "run-1", name: kyb.name, description: WHEN, records: handed, now: () => new Date("2026-01-01T00:00:00.000Z") }))).sha;

  // Runs 2 to 4 are seeded from main: each is offered the workflow, has it in its own store, runs it, and proposes its use.
  const trials = [];
  for (const run of ["run-2", "run-3", "run-4"]) {
    const hints = await workflowsToTry({ repo: curator, sha: main }, input);
    assert.deepEqual(hints, [{ name: kyb.name, status: trials.at(-1) === "active" ? "active" : "trial" }]);
    const { dir: workDir } = await workDirWith();
    assert.deepEqual((await seedWorkflows({ repo: curator, sha: main, into: workDir, workflows: hints })).loaded, [{ name: kyb.name, sha256: digest }]);
    const store = await runStoreWith([{ key: `k-${run}`, workflow: (await new WorkflowStore(workDir).load(kyb.name)).workflow, input }]);
    assert.deepEqual((await collectWorkflows({ repo: curator, workDir, seedSha: main })).found, [], "it used what it was given and saved nothing new");
    const proposed = await proposeLearning({ repo: curator, runId: run, target: noCandidates, uses: usesSource({ store, workDir, run }) });
    assert.equal(proposed.status, "proposed");
    const text = await curator.read(`uses/${run}.json`, await curator.resolve(`runs/${run}`));
    const step = await curateStep(curator, (dir) => settleWorkflowUses({ dir, uses: parseRunUses(text, run) }));
    main = step.sha;
    trials.push((await readTrial(curator, kyb.name, main)).status);
  }
  assert.deepEqual(trials, ["trial", "trial", "active"]);
  assert.deepEqual(await workflowsToTry({ repo: curator, sha: main }, input), [{ name: kyb.name, status: "active" }]);
}, { timeout: 60_000 });
