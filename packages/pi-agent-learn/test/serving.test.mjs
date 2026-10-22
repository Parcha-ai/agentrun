// While a successor is on trial: which revision a host runs first, a revision read back from the repository at a commit,
// and the words that ask the agent to run the trial first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { admitRevision, deriveSeed, foldUses, readRevision, renderSection, servingRevision, trialFirstText } from "../dist/index.js";
import { agentRepo, commitMain, scratch } from "./support.mjs";
import { workDirWith, workflowDoc } from "./workflow-support.mjs";

const sha = (c) => c.repeat(64);
const at = (h, m = 0) => `2026-10-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const use = (run, digest, outcome, when) => ({ run, sha256: sha(digest), outcome, at: when });
const WHEN = [{ pointer: "/sku", op: "exists" }];
const admit = (trial, digest, hour) => {
  const admitted = admitRevision(trial, { name: "audit", sha256: sha(digest), run: `author-${digest}`, at: at(hour), when: WHEN });
  assert.equal(admitted.status, "admitted");
  return admitted.trial;
};
/** `digest` admitted at `hour`, then promoted by clean uses of its own (as many as any threshold up to 3 needs). */
const proven = (trial, digest, hour) => {
  const folded = foldUses(admit(trial, digest, hour), [1, 2, 3].map((m) => use(`u${digest}${m}`, digest, "frozen", at(hour, m))));
  assert.equal(folded.trial.status, "active");
  return folded.trial;
};
const served = (serving) => serving && { serve: serving.serve.sha256[0], trial: serving.trial?.sha256[0], canary: serving.canary };

test("servingRevision: the active revision; while a successor is on trial, the most recent superseded one that still runs, with the trial named; none for a first trial", () => {
  const first = admit(undefined, "a", 1);
  assert.equal(servingRevision(first), undefined, "a first trial has nothing proven before it: the agent runs the trial");
  const a = proven(undefined, "a", 1);
  assert.deepEqual(served(servingRevision(a)), { serve: "a", trial: undefined, canary: false });
  const b = admit(a, "b", 5);
  assert.deepEqual(served(servingRevision(b)), { serve: "a", trial: "b", canary: true });
  // b proven, then c on trial: a and b are both superseded, and the most recent one is served.
  const c = admit(proven(a, "b", 5), "c", 9);
  assert.deepEqual(c.revisions.map((r) => [r.sha256[0], r.status]), [["a", "superseded"], ["b", "superseded"], ["c", "trial"]]);
  assert.deepEqual(served(servingRevision(c)), { serve: "b", trial: "c", canary: true });
  assert.deepEqual(served(servingRevision(c, { unrunnable: new Set([sha("b")]) })), { serve: "a", trial: "c", canary: true }, "one the store cannot load is passed over");
  assert.equal(servingRevision(c, { unrunnable: new Set([sha("a"), sha("b")]) }), undefined);
});

test("servingRevision never serves a revision that was retired or demoted", () => {
  // a trial replaced before it proved itself is retired, not superseded: its successor has nothing proven before it.
  const replaced = admit(admit(undefined, "a", 1), "b", 2);
  assert.deepEqual(replaced.revisions.map((r) => [r.sha256[0], r.status]), [["a", "retired"], ["b", "trial"]]);
  assert.equal(servingRevision(replaced), undefined);
  // b on trial over a, then demoted by two bad uses: a comes back as the live, active revision and is served alone.
  const demoted = foldUses(admit(proven(undefined, "a", 1), "b", 5), [use("x1", "b", "escalated", at(6)), use("x2", "b", "failed", at(7))]).trial;
  assert.deepEqual(demoted.revisions.map((r) => [r.sha256[0], r.status]), [["a", "active"], ["b", "demoted"]]);
  assert.deepEqual(served(servingRevision(demoted)), { serve: "a", trial: undefined, canary: false });
});

test("readRevision: a revision's workflow at a commit, read back through the DSL's store; none when the record is missing or is not that revision", async () => {
  const { repo } = await agentRepo(await scratch());
  const name = "registry-lookup";
  const { dir, saved } = await workDirWith({ [name]: workflowDoc({ name }) });
  const digest = saved[name];
  const record = await readFile(path.join(dir, ".pi/agentrun/workflows", name, `${digest}.json`), "utf8");
  const file = (d) => `.pi/agentrun/workflows/${name}/${d}.json`;
  const main = await commitMain(repo, { [file(digest)]: record });
  const workflow = await readRevision(repo, name, digest, main);
  assert.deepEqual(workflow.root, workflowDoc({ name }).root);
  assert.equal(await readRevision(repo, name, sha("f"), main), undefined, "no record");
  const other = await commitMain(repo, { [file(sha("e"))]: record });
  assert.equal(await readRevision(repo, name, sha("e"), other), undefined, "another revision's record under this digest");
  const tampered = await commitMain(repo, { [file(digest)]: JSON.stringify({ ...JSON.parse(record), workflow: workflowDoc({ name, limit: 5 }) }) });
  assert.equal(await readRevision(repo, name, digest, tampered), undefined, "a document that does not hash to its digest");
  assert.equal(await readRevision(repo, "Not A Name", digest, main), undefined);
});

test("trialFirstText: the proven revision did not finish; the trial is named and asked to run first, the job by hand only if it escalates too", () => {
  assert.equal(
    trialFirstText({ name: "kyb-registry", served: sha("a"), trial: sha("b") }),
    "The proven revision aaaaaaaa of kyb-registry did not finish this input. A newer revision of kyb-registry, bbbbbbbb, is on trial: load kyb-registry and run it first; do the job by hand only if it escalates too. Its clean runs are what earn it trust.",
  );
});

test("the section asks for a workflow on trial to be run first, and only when one is on trial", () => {
  const SHA = "c2a91f0e1b2c".padEnd(40, "0");
  const lineOf = (workflows) => renderSection(deriveSeed(SHA, [], { workflows })).split("\n").find((l) => l.startsWith("Workflows to try first"));
  assert.equal(lineOf([{ name: "kyb-us-registry", status: "trial" }]), "Workflows to try first for this input: kyb-us-registry (trial). Run one with the agentrun tool; if it escalates, continue yourself. A workflow on trial earns trust only from its own clean runs: run it before doing the job yourself, and change it only after it escalates or fails.");
  assert.equal(lineOf([{ name: "kyb-us-registry", status: "active" }]), "Workflows to try first for this input: kyb-us-registry. Run one with the agentrun tool; if it escalates, continue yourself.");
});
