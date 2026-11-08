// One grader decides whether a run's checked notes join main: a bounded call on the agent's own model, read fail-closed.
// No injection screen runs: the grader's Planted question decides. What the grade spends is kept on the run's learning
// and, with how its learning ended, in the learning ledger, which /v2/usage's `learning` meter reads; a call cut off at
// its bound costs what nobody knows, never $0. A server that goes mid-grade grades the run once at its next start, and a
// run is merged once, never twice. GET /v2/stats counts how the runs that tried to learn fared, from the ledger and the
// runs the server holds, never a run's files.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { judgeProposal } from "../dist/grade.js";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, ledgerOf, made, mergesOf, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { agent, follow, runDir, runsFolders, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];
const callsIn = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

test("the grader's verdict decides: a drop, a merge that keeps no note and an answer that is no verdict are dropped as grader, with the verdict kept; a model that fails is grade_failed", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  // Each in words: the grader's own reason; where the reason is the host's (it refused the answer), the grader's word on
  // the note it did not keep; an answer that held neither said as one that could not be read.
  const cases = [
    ["Grade: drop.", "grader", { merge: false, reason: "A note is about the one case it came from.", items: [{ file: "check-units.md", keep: false, question: "General", why: "It is about one case." }] }, "Not kept: It is about one case."],
    ["Grade: sly.", "grader", { merge: false, reason: "the grader said merge, but did not keep every item", items: [{ file: "check-units.md", keep: false, question: "General", why: "It is about one case." }] }, "Not kept: It is about one case."],
    ["Grade: garbage.", "grader", { merge: false, reason: "the grader's verdict could not be read", items: [] }, "Not kept: learning stopped (the review of the new notes gave an answer that could not be read)."],
    ["Grade: fail.", "grade_failed", undefined, "Not kept: learning stopped (the review of the new notes gave no answer)."],
  ];
  for (const [rule, reason, verdict, detail] of cases) {
    const id = rule.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");
    await made(api, learner(id, { instructions: rule, plan: PLAN }));
    const runId = await started(api, id);
    const { view, rows } = await ended(api, runId);
    assert.equal(view.result.final_answer, "Job answer.");
    settled(view, rows, "dropped", reason);
    assert.equal(view.learning.detail, detail, rule);
    const { learning } = await savedOf(data, runId);
    assert.deepEqual(learning.verdict, verdict, rule);
    assert.equal(git(repoOf(data, id), ["rev-list", "--count", "main"]), "1", `${rule}: nothing merged`);
    // Its cost kept, unknown when the call failed; an answer that could not be read, read twice, is kept as it came.
    assert.equal(learning.cost_usd.grade === null, reason === "grade_failed", JSON.stringify(learning.cost_usd));
    assert.equal(learning.unread, rule === "Grade: garbage." ? "Looks fine to me." : undefined, rule);
  }
  // One grader call a run, and one more for the answer that could not be read.
  assert.equal(callsIn(calls).filter((call) => call.kind === "grade").length, cases.length + 1, "one grader call a run, two for the unread one");
});

test("what is read from a partial answer goes through the grader like any answer: a note beside an opening never closed is graded, alone, before it merges or drops", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  // A valid note, then a skill's opening that never closes: the opening is left out, and the note is all that is read.
  const answer = [`\`\`\`note check-units.md\n${note("Check units", "Convert every amount to one unit before comparing")}\`\`\``, "````skill weekly-summary\n---\nname: weekly-summary\ndescription: The weekly summary\n---\nThree lines.", "Reflected."].join("\n\n");
  const grades = () => callsIn(calls).filter((call) => call.kind === "grade").length;
  for (const [id, rule, state] of [["partial-kept", "", "merged"], ["partial-dropped", "Grade: drop.", "dropped"]]) {
    await made(api, learner(id, { instructions: ["Answer the question.", `Answer: ${JSON.stringify(answer)}`, rule].filter(Boolean).join("\n") }));
    const before = grades();
    const runId = await started(api, id);
    const { view, rows } = await ended(api, runId);
    settled(view, rows, state, state === "merged" ? null : "grader");
    assert.equal(grades() - before, 1, `${id}: the grader is asked once`);
    const { learning } = await savedOf(data, runId);
    assert.deepEqual(learning.verdict.items.map(({ file }) => file), ["check-units.md"], `${id}: the note alone is graded, the unclosed skill never`);
    assert.equal(git(repoOf(data, id), ["ls-tree", "-r", "--name-only", "main", "--", "check-units.md"]), state === "merged" ? "check-units.md" : "", `${id}: on main only once kept`);
  }
});

test("an answer the host cannot read is asked once more with the same prompt: a readable second answer decides, and each ask's spend is booked once; two unreadable answers drop, with the last kept on the run cut of secrets and in size, and never served", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  // A value saved as a tool key before the runs: the grader's answer holds it, and the run's learning never does.
  // It holds a space, as a tool key may: an answer cut before it is cut of secrets could keep one half of it.
  const half = () => `zq${process.pid}${Date.now().toString(36)}${randomBytes(16).toString("hex")}`.slice(0, 32);
  const [front, back] = [half(), half()];
  const value = `${front} ${back}`;
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const grades = () => callsIn(calls).filter((call) => call.kind === "grade").length;

  // Once unreadable, then a verdict: it merges, on two asks, both booked, once each.
  await made(api, learner("plain", { plan: PLAN }));
  const plain = await ended(api, await started(api, "plain"));
  settled(plain.view, plain.rows, "merged");
  assert.equal(grades(), 1, "a readable answer is asked once");
  await made(api, learner("once", { instructions: "Grade: garbage once.", plan: PLAN }));
  const once = await ended(api, await started(api, "once"));
  settled(once.view, once.rows, "merged");
  assert.equal(grades(), 3, "an unreadable answer is asked once more, and no more");
  const [one, two] = [(await savedOf(data, plain.view.run_id)).learning, (await savedOf(data, once.view.run_id)).learning];
  assert.equal(two.unread, undefined, "a verdict read on the second ask keeps no answer");
  // The same prompt asked twice: twice the input tokens of one ask, near enough (the prompts differ by their run's id).
  assert.ok(two.tokens.grade.input > 1.8 * one.tokens.grade.input && two.tokens.grade.input < 2.2 * one.tokens.grade.input, JSON.stringify([one.tokens, two.tokens]));
  assert.ok(two.cost_usd.grade > one.cost_usd.grade, JSON.stringify([one.cost_usd, two.cost_usd]));
  const booked = ledgerOf(data).filter((line) => line.run === once.view.run_id);
  assert.deepEqual(booked.map(({ cost, tokens }) => ({ cost, tokens })), [{ cost: two.cost_usd.grade, tokens: two.tokens.grade }], "one ledger line, with both asks");

  // Unreadable twice, past any bound, holding the key at its start and again with its space before the 1,500th character
  // and its back half across it: dropped, with the last answer kept cut of the key, in whole and in part, then in size.
  const spaced = value.replace(" ", "_");
  const babble = `${spaced}_${"word_".repeat(271)}${spaced}_${"word_".repeat(1_000)}end`;
  await made(api, learner("babble", { instructions: `Grade: garbage saying ${babble}.`, plan: PLAN }));
  const dropped = await ended(api, await started(api, "babble"));
  settled(dropped.view, dropped.rows, "dropped", "grader");
  assert.equal(grades(), 5, "two asks");
  const { learning } = await savedOf(data, dropped.view.run_id);
  assert.deepEqual(learning.verdict, { merge: false, reason: "the grader's verdict could not be read", items: [] });
  assert.ok(learning.unread.startsWith("Looks fine to me. [redacted] word word") && learning.unread.endsWith("word word end"), learning.unread.slice(0, 80));
  assert.match(learning.unread, /word \n…\n word/);
  assert.ok(learning.unread.length <= 2_000, `${learning.unread.length} characters`);
  for (const part of [front.slice(0, 8), front.slice(-8), back.slice(0, 8), back.slice(-8)]) assert.ok(!learning.unread.includes(part), "no part of the key");
  assert.equal(learning.unread.split("[redacted]").length - 1, 2, "the key, twice");
  // Kept on the run's file for a person to diagnose; no read serves it.
  const served = JSON.stringify([(await api("GET", `/runs/${dropped.view.run_id}`)).body, (await api("GET", `/runs/${dropped.view.run_id}/learning`)).body, (await api("GET", "/runs")).body, (await api("GET", "/agents/babble/runs")).body, dropped.rows]);
  assert.ok(!served.includes("Looks fine to me") && !served.includes("word word"), "the answer is never served");
});

test("the grader runs on the model the server names for it, --grade-model (AGENTRUN_SERVE_GRADE_MODEL) before its strong tier (AGENT_MODEL_STRONG), whatever the agent's own model; with neither, on the agent's own", { timeout: 180_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const named = [];
  const graded = async (options, env = {}) => {
    Object.assign(process.env, env);
    const { api, close } = await serve(t, { learning: "on", faux: LEARN, ...options });
    // Capabilities say which model grades here: the name, or null for each run's agent's own.
    named.push((await api("GET", "/capabilities")).body.learning?.grade_model);
    await made(api, learner("model", { plan: PLAN }));
    const { view, rows } = await ended(api, await started(api, "model"));
    settled(view, rows, "merged");
    for (const name of Object.keys(env)) delete process.env[name];
    await close();
    return callsIn(calls).at(-1).model;
  };
  assert.equal(await graded({}), "faux-1", "neither: the agent's own model");
  assert.equal(await graded({}, { AGENT_MODEL_STRONG: "faux-strong" }), "faux-strong", "the strong tier");
  assert.equal(await graded({}, { AGENT_MODEL_STRONG: "faux-strong", AGENTRUN_SERVE_GRADE_MODEL: "faux-grader" }), "faux-grader", "the grade model's variable, before the strong tier");
  assert.equal(await graded({ gradeModel: "faux-named" }, { AGENTRUN_SERVE_GRADE_MODEL: "faux-grader" }), "faux-named", "the option, before the variable");
  assert.equal(callsIn(calls).length, 4, "one grade a run");
  assert.deepEqual(named, [null, "faux-strong", "faux-grader", "faux-named"], "capabilities.learning.grade_model");
});

// A learning end an older server wrote, with a reason no server gives any more, is read as any reason this server does
// not give: it is not counted in /v2/stats.
test("a run's learning end with a reason this server does not give (an older server's tool_denied) is not counted in /v2/stats", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("older"));
  const runId = await started(first.api, "older");
  const { view, rows } = await ended(first.api, runId);
  settled(view, rows, "dropped", "empty");
  await savedOf(data, runId);
  await first.close();
  // Its serve.json and its ledger line say tool_denied, a reason no server gives now: read as any reason it does not know.
  const meta = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8"));
  writeFileSync(join(runDir(data, runId), "serve.json"), JSON.stringify({ ...meta, learning: { ...meta.learning, reason: "tool_denied" } }));
  const ledger = join(data, "learning-usage.jsonl");
  writeFileSync(ledger, readFileSync(ledger, "utf8").replaceAll('"reason":"empty"', '"reason":"tool_denied"'));
  assert.ok(readFileSync(ledger, "utf8").includes('"tool_denied"'));
  const again = await serve(t, { learning: "on", faux: LEARN, data });
  const none = { runs: 0, merged: 0, dropped: {}, in_progress: 0 };
  assert.deepEqual((await again.api("GET", "/stats?agent=older")).body.learning, none, "not counted from the ledger");
  // Read, the run is held with its learning as stored, and still not counted.
  assert.equal((await again.api("GET", `/runs/${runId}`)).body.learning.reason, "tool_denied", "shown as stored");
  assert.deepEqual((await again.api("GET", "/stats?agent=older")).body.learning, none, "nor once the run is held");
});

test("the grader reads what the user said in the run, in order and cut of the server's secrets, and never the end-of-run turn's message", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, token, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("asked", { plan: PLAN }));
  const runId = await started(api, "asked", `For next time: answer in tables. The server's token is ${token}.`);
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  const [call] = callsIn(calls);
  assert.deepEqual(call.asked, ["1. For next time: answer in tables. The server's token is [redacted]."]);
  assert.ok(!JSON.stringify(callsIn(calls)).includes(token), "the token never reached the grader");
  // The proposal keeps them as the grader read them, so a grade after a restart reads the same.
  const proposal = readFileSync(join(runDir(data, runId), "learning-proposal.json"), "utf8");
  assert.deepEqual(JSON.parse(proposal).asked, ["For next time: answer in tables. The server's token is [redacted]."]);
  assert.ok(!proposal.includes(token));
});

/** A user message of `n` characters whose last words take back the rule it opened with, well past where a run's own
 *  record of a message stops (2,000 characters). */
const REVERSAL = " - actually no, never include those; use the ticket id only. Remember that.";
const reversed = (n) => {
  const start = "From now on, in every report, include the customer's full name and account number.";
  let middle = " Context for the report: the API latency incident on Tuesday ran 40 minutes, root cause a bad deploy, rolled back by the on-call engineer.";
  while (middle.length < n) middle += middle;
  return `${start}${middle.slice(0, n - start.length - REVERSAL.length)}${REVERSAL}`;
};

test("a user message past 2,000 characters reaches the grader whole from the run's own record: its last words, which take back its rule, are in the prompt and the proposal, after the marker", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("long", { plan: PLAN }));
  const message = reversed(2_500);
  assert.ok(message.length === 2_500 && message.indexOf(REVERSAL) > 2_000);
  const runId = await started(api, "long", message);
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  const [call] = callsIn(calls);
  const [asked] = JSON.parse(readFileSync(join(runDir(data, runId), "learning-proposal.json"), "utf8")).asked;
  for (const shown of [asked, call.asked[0]]) {
    assert.ok(shown.endsWith(REVERSAL.trim().slice(-40)) && shown.includes("actually no, never include those"), shown.slice(-120));
    assert.match(shown, /\n\[\d+ characters left out in the middle\]\n/);
  }
});

test("a follow-up sent while the run works, past 2,000 characters, reaches the grader whole too, after the run's first message", { timeout: 150_000 }, async (t) => {
  const gate = join(await scratch(t), "answer");
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("followed", { plan: PLAN, instructions: `Answer once ${gate} exists.` }));
  const runId = await started(api, "followed", "Write today's report.");
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
    assert.ok(i < 1200, "the run works");
    await sleep(50);
  }
  const sent = await api("POST", `/runs/${runId}/messages`, { content: reversed(2_500) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  writeFileSync(gate, "");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  const [call] = callsIn(calls);
  assert.equal(call.asked.length, 2, JSON.stringify(call.asked).slice(0, 200));
  assert.ok(call.asked[0].startsWith("1. Write today's report."));
  assert.ok(call.asked[1].includes("actually no, never include those") && /\n\[\d+ characters left out in the middle\]\n/.test(call.asked[1]), call.asked[1].slice(-160));
});

test("a server secret the user's message holds across either point it is shortened at shows no part of itself: each message is cut of the server's secrets whole first, then shortened to its head and its tail, in the proposal and in the grader's prompt", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, token, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("straddled", { plan: PLAN }));
  // The token sits across the head's end (about 650 characters in) and again across the tail's start (300 from the
  // end). The message stays within what a run's own record of it holds (2,000 characters).
  const message = `${"Look at this. ".repeat(60).slice(0, 640)}${token} and the rest of what the user said. ${"More. ".repeat(100)}${token} and the last words the user said.${" End.".repeat(50)}`;
  assert.ok(message.length <= 2_000 && message.length - message.lastIndexOf(token) > 300 && message.length - message.lastIndexOf(token) - token.length < 300, "the second token across the tail's start");
  const runId = await started(api, "straddled", message);
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  const proposal = readFileSync(join(runDir(data, runId), "learning-proposal.json"), "utf8");
  const shown = `${proposal}\n${JSON.stringify(callsIn(calls))}`;
  assert.equal(callsIn(calls).length, 1, "the grader was asked");
  for (let i = 0; i + 12 <= token.length; i++) assert.ok(!shown.includes(token.slice(i, i + 12)), `no 12 characters of the token, from its ${i}th: ${token.slice(i, i + 12)}`);
  const [asked] = JSON.parse(proposal).asked;
  assert.ok(asked.startsWith("Look at this.") && asked.endsWith("End.") && asked.length <= 1_000, `what the user said is kept, cut of the token and shortened to its head and tail: ${asked.length}`);
  assert.equal(asked.split("[redacted]").length - 1, 2, "the token cut whole in the head and in the tail");
  assert.match(asked, /\n\[\d+ characters left out in the middle\]\n/);
});

test("a grade on the model the server names for grading carries the server's key, which the server holds unlisted as it holds every secret: the gateway is sent that key, never none", { timeout: 60_000 }, async (t) => {
  // The model gateway: each Responses request answered with a verdict that keeps the note, its key and model noted.
  const keys = [];
  const models = [];
  const verdict = JSON.stringify({ merge: true, reason: "Each note is general and new.", items: [{ file: "check-units.md", decision: "keep", origin: "run", why: "It holds as a general rule." }] });
  const gateway = createServer(async (req, res) => {
    keys.push(req.headers.authorization);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    models.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").model);
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: verdict, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: verdict },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  // As the server's own environment holds it (secrets.ts withSecrets): the key is there to read, and lists as nothing.
  const key = `not-a-secret-${"gateway"}-${randomBytes(8).toString("hex")}`;
  const env = { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, AGENT_MODEL: "gpt-test", AGENT_MODEL_PRICE: "1,2" };
  Object.defineProperty(env, "AGENT_MODEL_API_KEY", { value: key, enumerable: false });
  assert.ok(!Object.keys(env).includes("AGENT_MODEL_API_KEY") && env.AGENT_MODEL_API_KEY === key);
  const judged = await judgeProposal({
    runId: "named-grade", agent: { instructions: "Answer the question." }, main: { active: [], superseded: [], graded: {} },
    proposed: [{ file: "check-units.md", text: PLAN[0][1] }], gradeModel: "gpt-strong", env, signal: new AbortController().signal,
  });
  assert.deepEqual(keys, [`Bearer ${key}`], "the gateway got the server's key");
  assert.deepEqual(models, ["gpt-strong"], "on the model named for grading");
  assert.equal(judged.verdict?.merge, true, JSON.stringify(judged));
});

test("with no independent judge there is no injection screen: Jev is never asked, the grader alone decides, and the run merges", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: join(dir, "jev.jsonl"), AGENTRUN_TEST_FAUX_CALLS: join(dir, "calls.jsonl") }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN, fauxJev: FAUX_JEV });
  await made(api, learner("unscreened", { plan: PLAN }));
  const { view, rows } = await ended(api, await started(api, "unscreened"));
  settled(view, rows, "merged");
  assert.deepEqual(callsIn(join(dir, "jev.jsonl")), [], "Jev was never asked");
  assert.equal(callsIn(join(dir, "calls.jsonl")).length, 1, "the grader was");
});

// No injection screen runs, Jev or not: a page classifier cannot see where a note came from, and a preference the user
// stated reads like an instruction to it. The grader's Planted question decides, with what the user said in view.
test("with Jev here no injection screen runs either: Jev is never asked, the grader alone decides, and a note the user stated as an instruction merges", { timeout: 150_000 }, async (t) => {
  const dir = await scratch(t);
  const jev = join(dir, "jev.jsonl");
  const calls = join(dir, "calls.jsonl");
  withEnv(t, { TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: jev, AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, fauxJev: FAUX_JEV });
  // The person states a preference, phrased as an instruction as people do; the faux grader keeps it as theirs (origin you).
  await made(api, learner("preference", { plan: PLAN, instructions: "Answer the question.\nGrade: you check-units.md." }));
  // The faux Jev scores every yes-or-no question 0.92, over the old threshold: it would have dropped this run.
  const { view, rows } = await ended(api, await started(api, "preference", "Always convert every amount to one unit before comparing. Remember that."));
  settled(view, rows, "merged");
  assert.deepEqual(callsIn(jev), [], "Jev was never asked");
  assert.equal(callsIn(calls).length, 1, "the grader was");
  const grade = callsIn(calls)[0];
  assert.ok(JSON.stringify(grade).includes("Always convert every amount to one unit"), "the grader read what the person said");
  const kept = git(repoOf(data, "preference"), ["show", "main:check-units.md"]);
  assert.match(kept, /^origin: you$/m, "the person's preference is kept as theirs");
});

test("a server that goes mid-grade grades the run once at its next start; a run whose kept verdict is merged again is the merge already on main, never a second", { timeout: 180_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_TEST_FAUX_GRADE_HOLD: "1" }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("held", { plan: PLAN }));
  const runId = await started(first.api, "held");
  for (let i = 0; callsIn(calls).length === 0; i++) {
    assert.ok(i < 1200, "the grader is asked");
    await sleep(50);
  }
  assert.equal((await first.api("GET", `/runs/${runId}`)).body.learning.state, "proposed");
  await first.close();
  const saved = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8"));
  assert.deepEqual([saved.learning.state, saved.learning.verdict], ["proposed", undefined], "nothing was decided");
  // The next start grades it, once.
  delete process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD;
  const second = await serve(t, { learning: "on", faux: LEARN, data });
  const { view, rows } = await ended(second.api, runId);
  settled(view, rows, "merged");
  assert.equal(callsIn(calls).length, 2, "one grader call per server");
  const repo = repoOf(data, "held");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(mergesOf(repo, runId).length, 1);
  await second.close();
  // A server that went after the verdict was kept and before the merge was saved: the run reads proposed, verdict kept.
  const merged = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8"));
  writeFileSync(join(runDir(data, runId), "serve.json"), JSON.stringify({ ...merged, learning: { ...merged.learning, state: "proposed", merged: undefined } }));
  const third = await serve(t, { learning: "on", faux: LEARN, data });
  const again = await ended(third.api, runId);
  settled(again.view, again.rows, "merged");
  assert.equal((await savedOf(data, runId)).learning.merged, main, "the merge already on main");
  assert.equal(git(repo, ["rev-parse", "main"]), main, "main did not move");
  assert.equal(mergesOf(repo, runId).length, 1, "merged once");
  assert.equal(callsIn(calls).length, 2, "the kept verdict was not asked again");
});

// A run whose learning waits to be checked or graded is opened again for a follow-up, and its server goes while the
// follow-up runs. The next server reads the run as running, so its start passes the learning over: the run's own end,
// once the follow-up finishes, is where it is checked and graded, with no later restart.
for (const at of ["proposed", "reflecting"]) {
  test(`a run opened again for a follow-up while its learning is ${at}, its server gone while the follow-up runs: the next server finishes the follow-up, then ${at === "proposed" ? "grades" : "checks and grades"} what the run proposed, and it merges, with no restart after`, { timeout: 180_000 }, async (t) => {
    const gate = join(await scratch(t), "answer");
    const calls = join(await scratch(t), "calls.jsonl");
    writeFileSync(gate, "");
    withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_TEST_FAUX_GRADE_HOLD: "1" }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
    const first = await serve(t, { learning: "on", faux: LEARN });
    const { data } = first;
    await made(first.api, learner("reopened", { plan: PLAN, instructions: `Answer once ${gate} exists.` }));
    const runId = await started(first.api, "reopened");
    for (let i = 0; callsIn(calls).length === 0; i++) {
      assert.ok(i < 1200, "the grader is asked");
      await sleep(50);
    }
    assert.equal((await first.api("GET", `/runs/${runId}`)).body.learning.state, "proposed");
    // The follow-up's answer holds until the gate is back, so the server goes while it runs, mid-grade.
    rmSync(gate);
    const sent = await first.api("POST", `/runs/${runId}/messages`, { content: "One more thing." });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    for (let i = 0; (await first.api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
      assert.ok(i < 1200, "the follow-up runs");
      await sleep(50);
    }
    await first.close();
    const saved = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8"));
    assert.deepEqual([saved.learning.state, saved.learning.verdict], ["proposed", undefined], "nothing was decided");
    if (at === "reflecting") {
      // A server that went after the run settled and before its check: what the turn answered is kept, not yet checked.
      writeFileSync(join(runDir(data, runId), "serve.json"), JSON.stringify({ ...saved, learning: { ...saved.learning, state: "reflecting", reason: null, detail: "Looking back on this run…" } }));
      rmSync(join(runDir(data, runId), "learning-proposal.json"));
      assert.match(JSON.parse(readFileSync(join(runDir(data, runId), "learning-turn.json"), "utf8")).answer, /^```note check-units\.md\n/, "the turn's answer is kept");
    }
    // The next server: the follow-up answers, the run ends, and its learning goes on from where it was.
    delete process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD;
    writeFileSync(gate, "");
    const second = await serve(t, { learning: "on", faux: LEARN, data });
    const { view, rows } = await ended(second.api, runId);
    assert.equal(view.status, "completed");
    settled(view, rows, "merged");
    assert.equal(callsIn(calls).length, 2, "one grader call per server");
    const repo = repoOf(data, "reopened");
    assert.equal((await savedOf(data, runId)).learning.merged, git(repo, ["rev-parse", "main"]));
    assert.equal(mergesOf(repo, runId).length, 1, "merged once");
    assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "check-units.md"]);
    await second.close();
  });
}

test("a grader that never answers is cut off at its bound: the run's learning is grade_failed, and what the grade spent is unknown (null), never $0, on the run, in the ledger and on /v2/usage", { timeout: 120_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_GRADE_HOLD: "never", AGENTRUN_TEST_FAUX_CALLS: calls }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, gradeTimeoutMs: 1_500 });
  await made(api, learner("stuck", { plan: PLAN }));
  const runId = await started(api, "stuck");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "grade_failed");
  assert.equal(callsIn(calls).length, 1, "the grader was asked, and never answered");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual([learning.cost_usd, learning.tokens], [{ grade: null }, { grade: null }]);
  assert.deepEqual(ledgerOf(data).map(({ run, state, reason, cost, tokens }) => [run, state, reason, cost, tokens]), [[runId, "dropped", "grade_failed", null, null]]);
  const line = (await api("GET", "/usage?group_by=meter")).body.lines.find((entry) => entry.meter === "learning");
  assert.deepEqual([line.usd, line.unpriced_runs], [0, 1], "unpriced, never $0");
});

// GET /v2/usage on one server with both kinds of spend outside a run's tokens: a run whose paid tool charged (monid's
// `tools`, from S2) and a run whose grade spent (the learning ledger's `learning`). Each groups the same way, and the
// total is every line once.
test("GET /v2/usage books a run's tool charge as tools and a grade as learning, beside the runs' tokens: by meter, agent and day the lines sum to the same total", { timeout: 180_000 }, async (t) => {
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_MONID_CALLS: join(await scratch(t), "monid.jsonl"), AGENTRUN_TEST_FAUX_MONID_ACCEPTS: createHash("sha256").update(saved).digest("hex") }, ["MONID_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID });
  // A learning run on pi, graded and merged: its grade's cost is the learning ledger's.
  await made(api, learner("learner", { plan: PLAN }));
  const learnt = await started(api, "learner");
  const learning = await ended(api, learnt);
  settled(learning.view, learning.rows, "merged");
  const grade = (await savedOf(data, learnt)).learning.cost_usd.grade;
  assert.ok(grade > 0, "the grade cost something");
  // A run on claude-agent whose monid call charged $0.003, on a key saved through the settings API.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);
  await made(api, agent("enrich", { harness: "claude-agent", instructions: "Run monid's /person/enrich on Ada.", tools: ["monid.discover", "monid.inspect", "monid.run"], tool_settings: { "monid.discover": { permission: "allow" }, "monid.inspect": { permission: "allow" }, "monid.run": { permission: "allow" } } }));
  const enriched = await started(api, "enrich", "hi");
  await follow(api, enriched, ["completed"], { deadlineMs: 55_000 });
  const cost = async (runId) => (await api("GET", `/runs/${runId}`)).body.cost.usd;
  const [learnerRun, enrichRun] = [await cost(learnt), await cost(enriched)];
  assert.equal(enrichRun, 0.005, "two requests and monid's charge");
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const usage = async (group) => (await api("GET", `/usage?group_by=${group}`)).body;
  const sum = (body) => round(body.lines.reduce((total, line) => total + line.usd, 0));
  const byMeter = await usage("meter");
  assert.deepEqual(Object.fromEntries(byMeter.lines.map((line) => [line.meter, line.usd])), { tokens: round(learnerRun + 0.002), tools: 0.003, learning: round(grade) });
  assert.equal(byMeter.total_usd, round(learnerRun + enrichRun + grade), "every run's cost, and the grade, once");
  assert.equal(sum(byMeter), byMeter.total_usd, "the lines sum to the total");
  const byAgent = await usage("agent");
  assert.deepEqual(Object.fromEntries(byAgent.lines.map((line) => [line.group, line.usd])), { learner: round(learnerRun + grade), enrich: enrichRun });
  assert.equal(byAgent.total_usd, byMeter.total_usd);
  const byDay = await usage("day");
  // One day, or two in a row when the runs straddle UTC midnight: the day lines still sum to the same total.
  const days = byDay.lines.map((line) => line.group).sort();
  assert.ok(days.length === 1 || (days.length === 2 && Date.parse(days[1]) - Date.parse(days[0]) === 86_400_000), `one day, or two in a row: ${days.join(", ")}`);
  assert.equal(sum(byDay), byMeter.total_usd, "the day lines sum to the total");
  assert.equal(byDay.total_usd, byMeter.total_usd);
  for (const body of [byMeter, byAgent, byDay]) assert.equal(body.unpriced_runs, 0);
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.usage.meters, ["tokens", "tools", "browser_time", "learning"]);
});

test("GET /v2/usage books each grade under the meter learning, by agent and by day; GET /v2/stats counts the runs that tried to learn, over its filters, from the ledger, and a restarted server counts the same with runs/ unreadable", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { api, data } = first;
  await made(api, learner("counted", { plan: PLAN, once: true }));
  // An agent whose end-of-run turn gives its note out of format: no ```note block.
  await made(api, learner("mute", { instructions: `Answer: ${JSON.stringify("Keep this:\n---\nname: Loose\ndescription: Out of format\ntype: reference\n---\nA note with no block.\n")}` }));
  await made(api, agent("plain", { tools: ["write"] }));
  const merged = await ended(api, await started(api, "counted"));
  const empty = await ended(api, await started(api, "counted"));
  const mute = await ended(api, await started(api, "mute"));
  await ended(api, await started(api, "plain"));
  assert.deepEqual([merged.view.learning.state, empty.view.learning.reason, mute.view.learning.reason], ["merged", "empty", "unparsed"]);
  const grade = (await savedOf(data, merged.view.run_id)).learning.cost_usd.grade;
  assert.ok(grade > 0);
  for (const { view } of [empty, mute]) await savedOf(data, view.run_id);
  const byMeter = (await api("GET", "/usage?group_by=meter")).body;
  const line = byMeter.lines.find((entry) => entry.meter === "learning");
  assert.equal(line.usd, Math.round(grade * 1e6) / 1e6);
  assert.ok(byMeter.lines.find((entry) => entry.meter === "tokens").usd > 0, "the runs' own cost stays under tokens");
  assert.ok((await api("GET", "/usage?group_by=agent")).body.lines.find((entry) => entry.group === "counted").usd >= line.usd);

  const want = { runs: 3, merged: 1, dropped: { empty: 1, unparsed: 1 }, in_progress: 0 };
  assert.deepEqual((await api("GET", "/stats")).body.learning, want);
  assert.deepEqual((await api("GET", "/stats?agent=mute")).body.learning, { runs: 1, merged: 0, dropped: { unparsed: 1 }, in_progress: 0 });
  assert.deepEqual((await api("GET", `/stats?from=${new Date(Date.now() + 60_000).toISOString()}`)).body.learning, { runs: 0, merged: 0, dropped: {}, in_progress: 0 });
  // One ledger line per run that tried to learn, once its end was saved: the grade's spend on the merged one, none on the
  // others, which were never graded.
  const lines = ledgerOf(data).map(({ run, agent, state, reason, at, cost, tokens }) => ({ run, agent, state, reason, at: typeof at, cost, tokens }));
  const zero = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  const saved = await savedOf(data, merged.view.run_id);
  assert.deepEqual(lines.sort((a, b) => a.run.localeCompare(b.run)), [
    { run: merged.view.run_id, agent: "counted", state: "merged", reason: null, at: "string", cost: grade, tokens: saved.learning.tokens.grade },
    { run: empty.view.run_id, agent: "counted", state: "dropped", reason: "empty", at: "string", cost: 0, tokens: zero },
    { run: mute.view.run_id, agent: "mute", state: "dropped", reason: "unparsed", at: "string", cost: 0, tokens: zero },
  ].sort((a, b) => a.run.localeCompare(b.run)));
  await first.close();
  const again = await serve(t, { learning: "on", faux: LEARN, data });
  // The restarted server holds none of these runs: it counts them from the ledger alone, and never opens runs/.
  const runs = runsFolders(data);
  for (const folder of runs) chmodSync(folder, 0o000);
  try {
    assert.deepEqual((await again.api("GET", "/stats")).body.learning, want, "read back from the ledger");
    assert.deepEqual((await again.api("GET", "/stats?agent=mute")).body.learning, { runs: 1, merged: 0, dropped: { unparsed: 1 }, in_progress: 0 });
  } finally {
    for (const folder of runs) chmodSync(folder, 0o700);
  }
  assert.equal((await again.api("GET", "/usage?group_by=meter")).body.lines.find((entry) => entry.meter === "learning").usd, line.usd, "counted once");
  assert.equal(ledgerOf(data).length, 3, "the restart wrote no line again");
});

test("a note the checks refuse is left out and the rest of the proposal goes on: the good note is graded and merged, the bad one named with its problem; a secret in any note still drops every note", { timeout: 150_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const GOOD = note("Check units", "Convert every amount to one unit before comparing");
  const BAD = "---\nname: No description\ntype: project\n---\nA note with no description line.\n";
  await made(api, learner("partly", { plan: [["check-units.md", GOOD], ["no-description.md", BAD]] }));
  const runId = await started(api, "partly");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  assert.equal(view.learning.detail, "Learned: Check units. Not kept: it didn't pass the checks on notes (a note whose header is not in shape).");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual(learning.problems.map((p) => [p.rule, p.path]), [["note", "no-description.md"]], "the left-out note, named");
  assert.deepEqual(learning.verdict.items.map((item) => item.file), ["check-units.md"], "the grader judged only what passed");
  const tree = git(repoOf(data, "partly"), ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  assert.ok(tree.includes("check-units.md") && !tree.includes("no-description.md"), tree.join(","));
  // A secret in one note: the run's answer holds what must never be stored, so nothing of it is kept.
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  await made(api, learner("leaky", { plan: [["check-units.md", GOOD], ["sign-in.md", note("Sign in", "How to sign in", `Use ${shaped} to sign in.\n`)]] }));
  const leaky = await ended(api, await started(api, "leaky"));
  settled(leaky.view, leaky.rows, "dropped", "checker");
  assert.deepEqual(mergesOf(repoOf(data, "leaky"), leaky.view.run_id), []);
});
