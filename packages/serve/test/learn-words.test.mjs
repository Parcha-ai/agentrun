// What a person reads of a run's learning is said in their words: each `detail`, and the run's learning row in its
// timeline, which says the same. Started from what, learned what workflow, kept a correction, what waits for the owner's
// OK, or why nothing was kept: what the checks refused, in words. Never the machine's words: no "main", "merged into",
// "end-of-run turn", "grader's verdict" or "proposal". The reason codes do not change.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { said, short, STOPPED, wordsOf } from "../dist/learning-words.js";
import { COMPILED } from "./fixtures/faux-learn.mjs";
import { ended, fedBack, LEARN, learner, learningRows, made, settled, sleep, started, UNSAID } from "./learn-support.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

/** The faux compile answer for a workflow named `name`, its first node's instructions `instructions`. */
const compiledAs = (name, instructions = "Answer the question.") => COMPILED.replace("````workflow answer", `\`\`\`\`workflow ${name}`).replace('"name":"answer"', `"name":"${name}"`).replace('"instructions":"Answer the question."', `"instructions":${JSON.stringify(instructions)}`);
/** A learner whose first completed run compiles its job into `name`'s workflow. */
const compiler = (id, name, instructions) => learner(id, { learning: { compile_after: 1 }, instructions: `Answer the question.\nCompile: ${JSON.stringify(compiledAs(name, instructions))}` });

test("the words: what a run started from counted as a person counts it, what it learned by name, what waits for the owner's OK, the checks' rules in words, and none of the machine's words anywhere", () => {
  assert.deepEqual([said.seeded(0), said.seeded(1), said.seeded(3), said.seeded(0, 1), said.seeded(2, 3)], ["Started with nothing learned yet.", "Started from 1 correction.", "Started from 3 corrections.", "Started from 1 workflow.", "Started from 2 corrections and 3 workflows."]);
  assert.equal(said.merged([{ name: "answer-in-tables" }]), "Learned the workflow answer-in-tables.");
  assert.equal(said.merged([], 1), "Kept your correction.");
  assert.equal(said.merged([], 2), "Kept 2 of your corrections.");
  assert.equal(said.merged([{ name: "answer-in-tables" }], 1), "Learned the workflow answer-in-tables. Kept your correction.");
  assert.equal(said.merged([{ name: `${"long-".repeat(12)}name` }]), `Learned the workflow ${"long-".repeat(12)}name.`, "a long name is said whole: a read cuts it short, once it is cut of secrets");
  // A workflow that waits for the owner's OK, said with what was learned beside it, or alone.
  assert.equal(said.merged([{ name: "answer-in-tables" }, { name: "paperdepot24-first", pending: true }]), "Learned the workflow answer-in-tables. Waiting for your OK: workflow paperdepot24-first.");
  assert.equal(said.merged([{ name: "a", pending: true }, { name: "b", pending: true }]), "Waiting for your OK: workflow a; workflow b.");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "secret_value" }, { rule: "too_large" }]), "Not kept: it held something that must not be stored (one of this server's secrets).");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "workflow" }]), "Not kept: it didn't pass the checks (a workflow over 16 KB; a workflow that can't run here).");
  assert.equal(said.checker([{ rule: "a_rule_added_later" }]), "Not kept: it didn't pass the checks (a_rule_added_later).");
  // What the checks refused beside what was kept.
  assert.equal(said.merged([], 1, [{ rule: "secret_shape" }]), "Kept your correction. Not kept: it held something that must not be stored (text that looks like a key or a password).");
  const all = [
    said.seeded(0), said.seeded(2, 1), said.reflecting, said.asked, said.askedCompile, said.askedCompileAgain, said.merged([{ name: "a" }]), said.merged([{ name: "a" }, { name: "b", pending: true }], 1), said.merged([{ name: "b", pending: true }]),
    said.empty, said.onlyWorkflow, said.use, said.retiredSince,
    ...["secret_value", "secret_shape", "invisible_unicode", "outside", "file_name", "file_mode", "encoding", "deleted", "too_large", "workflow", "no_tool_list", "executable_node", "front_matter", "kept"].map((rule) => said.checker([{ rule }])),
    said.noBudget, said.unknownCost, ...Object.values(STOPPED).map(said.stopped),
  ];
  // A read says a name again from its parts, each cut first: a value inside them is found whole.
  const cut = (text) => text.replaceAll("secret-value", "[redacted]");
  assert.equal(wordsOf({ state: "merged", detail: "Learned the workflow secret-value.", workflows: [{ file: "workflows/use-secret-value/workflow.json", name: "use-secret-value" }], corrections: 0 }, cut), "Learned the workflow use-[redacted].");
  assert.equal(wordsOf({ state: "merged", detail: "x", workflows: [{ file: "workflows/b/workflow.json", name: "buy-secret-value", pending: true }] }, cut), "Waiting for your OK: workflow buy-[redacted].");
  assert.equal(wordsOf({ state: "merged", detail: "Kept your correction.", workflows: [], corrections: 1 }, cut), "Kept your correction.");
  assert.equal(wordsOf({ state: "dropped", detail: said.empty }, cut), said.empty);
  assert.equal(wordsOf({ state: "dropped", detail: "Not kept: secret-value" }, cut), "Not kept: [redacted]", "any other detail is cut as well");
  for (const text of all) {
    assert.doesNotMatch(text, UNSAID, text);
    assert.doesNotMatch(text, /_/, `no rule's code: ${text}`);
  }
  assert.equal(short(`${"word ".repeat(40)}end`, 140).length <= 140, true);
});

/** Until `check` holds, every 50 ms, at most 60 s. */
async function until(what, check) {
  for (let i = 0; !(await check()); i++) {
    assert.ok(i < 1200, what);
    await sleep(50);
  }
}

test("each run's learning in words, from its start to its end, its learning row saying the same: started from nothing, then from a correction; learned a workflow by name; kept a correction; nothing new", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  const learning = async (runId) => (await api("GET", `/runs/${runId}`)).body.learning;
  const gate = (name) => join(dir, name);

  // Seeded with nothing, held at its answer; then it learns a workflow.
  await made(api, learner("words", { learning: { compile_after: 1 }, instructions: `Answer once ${gate("one")} exists.` }));
  const one = await started(api, "words");
  await until("run 1 is seeded", async () => (await learning(one))?.state === "seeded");
  assert.equal((await learning(one)).detail, "Started with nothing learned yet.");
  writeFileSync(gate("one"), "");
  const learned = await ended(api, one);
  settled(learned.view, learned.rows, "merged");
  assert.equal(learned.view.learning.detail, "Learned the workflow answer.");
  assert.equal(learningRows(learned.rows)[0].summary, "Learned the workflow answer.");
  assert.equal((await api("GET", "/agents/words/runs")).body.runs.find((run) => run.run_id === one).learning.detail, "Learned the workflow answer.", "a list says the same");

  // Its owner's correction is kept; the next run is seeded with it, held at its answer.
  await made(api, learner("corrector"));
  const corrected = await fedBack(api, "corrector");
  assert.equal(corrected.view.learning.detail, "Kept your correction.", JSON.stringify(corrected.view.learning));
  const { id: _, version: __, ...next } = learner("corrector", { instructions: `Answer once ${gate("two")} exists.` }).definition;
  assert.equal((await api("PUT", "/agents/corrector/definition", { definition: next })).status, 200);
  const two = await started(api, "corrector");
  await until("run 2 is seeded", async () => (await learning(two))?.state === "seeded");
  assert.equal((await learning(two)).detail, "Started from 1 correction.");
  writeFileSync(gate("two"), "");
  await ended(api, two);

  // Nothing new.
  await made(api, learner("quiet"));
  const quiet = await ended(api, await started(api, "quiet"));
  settled(quiet.view, quiet.rows, "dropped", "empty");
  assert.equal(quiet.view.learning.detail, "Nothing new to keep from this run.");
  assert.equal((await api("GET", "/agents/quiet/runs")).body.runs[0].learning.detail, "Nothing new to keep from this run.", "a list says the same");
});

test("a workflow it wrote holding text shaped like a key is not kept, said as a secret: never as a workflow that can't run here", { timeout: 240_000 }, async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  const shaped = ["s", "k-", "a1".repeat(16)].join("");
  await made(api, compiler("leaky", "leaky", `Sign in with ${shaped}.`));
  const { view, rows } = await ended(api, await started(api, "leaky"));
  settled(view, rows, "dropped", "checker");
  const whole = (await api("GET", `/runs/${view.run_id}/learning`)).body;
  assert.ok(!JSON.stringify(whole).includes(shaped), "no read shows the key");
  assert.deepEqual(whole.problems.map((problem) => problem.rule), ["secret_shape"], JSON.stringify(whole));
  assert.equal(view.learning.detail, "Not kept: it held something that must not be stored (text that looks like a key or a password).", JSON.stringify(whole));
  assert.equal((await api("GET", "/agents/leaky/runs")).body.runs[0].learning.detail, view.learning.detail, "a list says the same");
});

test("a workflow's name holding a value that becomes a secret after the run shows no part of it: each read cuts the value whole before it shortens anything, in the run's view, the run lists, the timeline's learning row and the run's whole learning", { timeout: 240_000 }, async (t) => {
  // Built at the run: no file of this repository holds it, and it is saved as a tool key only after the run learned.
  const value = `zq${randomBytes(8).toString("hex")}`;
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, compiler("named", `use-${value}-first`));
  const named = await ended(api, await started(api, "named"));
  settled(named.view, named.rows, "merged");
  // Shown whole while it is no secret.
  assert.equal(named.view.learning.detail, `Learned the workflow use-${value}-first.`);

  // Saved as a key, the server running on: every read after it cuts the value whole.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const runId = named.view.run_id;
  const read = (await api("GET", `/runs/${runId}`)).body.learning;
  const row = (await follow(api, runId, ["completed"])).rows.find((one) => one.kind === "learning");
  const whole = (await api("GET", `/runs/${runId}/learning`)).body;
  const lists = [(await api("GET", "/runs")).body.runs, (await api("GET", "/agents/named/runs")).body.runs].map((runs) => runs.find((one) => one.run_id === runId).learning);
  assert.match(read.detail, /\[redacted\]/, read.detail);
  assert.deepEqual([row.summary, row.text, row.learning.detail, whole.detail], [read.detail, read.detail, read.detail, read.detail], "the row and the run's whole learning say the same");
  for (const listed of lists) assert.ok(listed.detail.length <= 140 && read.detail.startsWith(listed.detail.replace(/…$/, "")), listed.detail);
  assert.ok(!JSON.stringify([read, row, whole, ...lists]).includes(value), "no read shows the value");
});
