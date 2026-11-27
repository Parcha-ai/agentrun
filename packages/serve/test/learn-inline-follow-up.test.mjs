// An inline agent that learns, launched as a host launches it (POST /runs with its external reference and its definition,
// the run's input an object of its own schema), corrected by a follow-up whose words arrive wrapped in the host's turn
// text (POST /runs/{id}/messages), then run again inline: once on the same external version (its stored revision), once
// on a new one (its definition changed, so a new revision). The correction is kept (the run's learning, the agent's
// corrections.md) and the next run's system prompt carries it under # Learned. learn-follow-up-cli.test.mjs is the same
// round on a stored agent and a bare follow-up.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { askedForCompile } from "../dist/learn/compile.js";
import { ended, sleep } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-5-5";
const CODE = "HARBOR-DAA96D";
const QUESTION = `Correction for every later run: the harbor code is ${CODE}`;
const ASK = "What is the harbor code? If you do not know it, answer exactly: UNKNOWN.";
// The host's follow-up turn text: its preamble, a research turn's report line, the question, its language.
const FOLLOW_UP = [
  "Follow-up on this job. Your workspace and this conversation hold the earlier turns' work: read what you wrote before and build on it rather than repeating it. The instructions you were given at the start still apply, except where those below change them.",
  "Update report.md with the new findings, keeping what still holds.",
  `**Follow-up question**: ${QUESTION}`,
  "Write in language code: en.",
].join("\n\n");
// The host's run input schema: a closed object, its task in content and what changes from run to run beside it.
const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    content: { type: "string" },
    date: { type: "string", description: "Today's date, as the run's date grounding block states it" },
    routing: { type: "string", description: "This job's routing instructions" },
    tools: { type: "string", description: "The run's tool paths and shapes (its ContextForge tool block)" },
    schedule: { type: "object", additionalProperties: false, description: "The schedule that fired this run", properties: { name: { type: "string" }, fired_at: { type: "string" }, frequency: { type: "string" }, run_number: { type: "integer" } } },
  },
};
const HOST_TOOLS = ["read", "write", "edit", "web_search", "web_fetch"];
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n"));
const systemOf = ({ body }) => (typeof body.system === "string" ? body.system : textOf(body.system));
const corrects = ({ body }) => (body.messages ?? []).some((m) => m.role === "user" && textOf(m.content).includes(CODE));
const SKIP = { timeout: 300_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" };

/** The host's inline body: the agent's reference (`version`), its definition (instructions `prompt`), the run's input. */
const inline = ({ harness, version, prompt, tools, keyed }) => ({
  external: { source: "host", kind: "expert", id: "workspace-1:expert-1", version },
  definition: {
    name: "Harbor expert",
    instructions: prompt,
    skills: [],
    tools,
    harness,
    model: `anthropic/${MODEL}`,
    input_schema: INPUT_SCHEMA,
    computer: { kind: "none" },
    learning: { compile_after: 3 },
  },
  input: { content: ASK, date: "Today's date is 2026-11-26." },
  max_cost_usd: 5,
  ...(keyed ? { model_key: "fake-test-key-run" } : {}),
});

async function harbor(t, { harness = "claude-agent", newVersion = false, split = false, keyed = false, tools = [] } = {}) {
  const systems = [];
  const fake = await fakeAnthropic({
    reply: async (request) => {
      if (request.path !== "/v1/messages") return { text: "" };
      systems.push(systemOf(request));
      return { text: corrects(request) ? `The harbor code is ${CODE}.` : "UNKNOWN" };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}`, ...(keyed ? { AGENT_MODEL_BASE_URL: fake.url } : {}) }, keyed ? ["AGENT_MODEL_STRONG"] : ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG"]);
  const { api } = await serve(t, { learning: "on", faux: undefined, ...(split ? { childRuns: {} } : {}) });
  const prompt = "You are the harbor expert. Answer the user's question.";

  const first = await api("POST", "/runs", inline({ harness, version: "1.aaaaaaaaaaaaaaaa", prompt, tools, keyed }));
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const runId = first.body.run_id;
  const agentId = first.body.agent_id;
  await ended(api, runId);
  const sent = await api("POST", `/runs/${runId}/messages`, { content: FOLLOW_UP, ...(keyed ? { model_key: "fake-test-key-message" } : {}) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const second = await ended(api, runId);
  assert.equal(second.view.status, "completed");
  const learning = (await api("GET", `/runs/${runId}/learning`)).body;
  assert.equal(learning?.state, "merged", `run 1's follow-up round kept the correction: ${JSON.stringify(learning)}`);
  const corrections = (await api("GET", `/agents/${agentId}/learning/corrections`)).body;
  assert.ok(String(corrections?.text ?? "").includes(CODE), `the agent's corrections hold it: ${JSON.stringify(corrections)}`);

  const asked = systems.length;
  const next = await api("POST", "/runs", inline({ harness, version: newVersion ? "2.bbbbbbbbbbbbbbbb" : "1.aaaaaaaaaaaaaaaa", prompt: newVersion ? `${prompt} Be brief.` : prompt, tools, keyed }));
  assert.equal(next.status, 202, JSON.stringify(next.body));
  assert.equal(next.body.agent_id, agentId, "the same agent");
  const { view } = await ended(api, next.body.run_id);
  const laid = systems.slice(asked);
  assert.ok(laid.length, "the next run asked its model");
  assert.ok(laid.every((system) => system.includes("# Learned") && system.includes(CODE)), `the next run's system prompt carries the correction under # Learned: ${JSON.stringify({ revision: view.revision_id, learning: view.learning, system: laid[0]?.slice(-800) })}`);
}

for (const harness of ["claude-agent", "pi"]) {
  for (const newVersion of [false, true]) {
    const version = newVersion ? "a new external version" : "the same external version";
    test(`${harness}: an inline run's wrapped follow-up correction reaches the next inline run on ${version}`, SKIP, (t) => harbor(t, { harness, newVersion }));
    test(`${harness}: the same on ${version}, each run in a process of its own`, SKIP, (t) => harbor(t, { harness, newVersion, split: true }));
  }
}

for (const newVersion of [false, true]) {
  const version = newVersion ? "a new external version" : "the same external version";
  test(`claude-agent: the same on ${version}, split, keyed, with the host's no-computer tools`, SKIP, (t) => harbor(t, { newVersion, split: true, keyed: true, tools: HOST_TOOLS }));
  test(`claude-agent: the same on ${version}, split and keyed, no tools`, SKIP, (t) => harbor(t, { newVersion, split: true, keyed: true }));
}

/** The host launches the next run as soon as the corrected one reads completed: the follow-up's answer is in (its job's
 *  end is kept, so the run reads completed) while its learning round still runs (here its compile turn, held open by the
 *  fake until the next run's POST has answered). The next run still starts from the correction once that round merges. */
async function raced(t, { harness = "claude-agent", split = false, waitMs, stop = false } = {}) {
  const asks = [];
  let armed = false;
  let roundAsked;
  const asked = new Promise((resolve) => (roundAsked = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const fake = await fakeAnthropic({
    reply: async (request) => {
      if (request.path !== "/v1/messages") return { text: "" };
      // A compile ask (or its re-ask) is the request's last user message; earlier turns of the session stay in its history.
      const compile = askedForCompile(textOf((request.body.messages ?? []).findLast((m) => m.role === "user")?.content));
      asks.push({ system: systemOf(request), compile: Boolean(compile), at: Date.now() });
      if (compile) {
        // The follow-up round's compile turn (its first ask): held until the next run was launched. Every compile answer
        // drafts nothing the checks take, so no learned workflow ever answers the next run in its model's stead.
        if (armed && compile === true) {
          armed = false;
          roundAsked();
          await held;
        }
        return { text: "No workflow for this job." };
      }
      return { text: corrects(request) ? `The harbor code is ${CODE}.` : "UNKNOWN" };
    },
  });
  t.after(() => fake.close());
  const bound = waitMs === undefined ? {} : { AGENTRUN_LEARNING_ROUND_WAIT_MS: String(waitMs) };
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}`, ...bound }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG", ...(waitMs === undefined ? ["AGENTRUN_LEARNING_ROUND_WAIT_MS"] : [])]);
  const { api } = await serve(t, { learning: "on", faux: undefined, ...(split ? { childRuns: {} } : {}) });
  const prompt = "You are the harbor expert. Answer the user's question.";
  // compile_after 1: each round of the corrected run asks a compile turn (its first fails its checks, so the follow-up
  // round's is the one more a failed first compile gets).
  const body = () => {
    const one = inline({ harness, version: "1.aaaaaaaaaaaaaaaa", prompt, tools: [] });
    return { ...one, definition: { ...one.definition, learning: { compile_after: 1 } } };
  };

  const first = await api("POST", "/runs", body());
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const runId = first.body.run_id;
  const agentId = first.body.agent_id;
  await ended(api, runId);
  armed = true;
  const sent = await api("POST", `/runs/${runId}/messages`, { content: FOLLOW_UP });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  let timer;
  await Promise.race([asked, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the follow-up round asked no compile turn")), 90_000)))]).finally(() => clearTimeout(timer));
  // The follow-up's answer is in and its round is under way: the run reads completed, its learning not yet merged.
  let view;
  for (let i = 0; i < 600; i++) {
    view = (await api("GET", `/runs/${runId}`)).body;
    if (view.status === "completed") break;
    await sleep(50);
  }
  assert.equal(view.status, "completed", JSON.stringify({ status: view.status, learning: view.learning }));
  assert.equal(view.learning?.state, "reflecting", JSON.stringify(view.learning));

  const before = asks.length;
  const launched = Date.now();
  const next = await api("POST", "/runs", body());
  assert.equal(next.status, 202, JSON.stringify(next.body));
  assert.equal(next.body.agent_id, agentId, "the same agent");
  // The next run's own asks: after its launch, every ask but a compile turn's (the corrected run asks only those then).
  const ownAsks = () => asks.slice(before).filter((one) => !one.compile);
  if (stop) {
    // A person stops the next run while its claim waits on the held round, through the runner: the wait ends at the stop
    // (its loop starts and is stopped while the round is still held), the run ends stopped, never asks its model, and its
    // start is left as its POST read it (no wait's end written).
    // Claimed (its view still reads queued until its first turn), then left to wait a moment.
    let waiting;
    for (let i = 0; i < 600; i++) {
      waiting = (await api("GET", `/runs/${next.body.run_id}`)).body;
      if (waiting.claim) break;
      await sleep(50);
    }
    assert.ok(waiting.claim, JSON.stringify(waiting));
    await sleep(750);
    const rowsOf = async () => (await api("GET", `/runs/${next.body.run_id}/timeline`)).body.rows ?? [];
    assert.deepEqual([ownAsks().length, (await rowsOf()).length], [0, 0], "claimed, it waits on the round: no ask, no row of its own");
    const stopAt = Date.now();
    assert.equal((await api("POST", `/runs/${next.body.run_id}/stop`)).body.stopped, true);
    // The wait ended at the stop, the round still held: its loop started (its input row) well inside the bound.
    let rows = [];
    for (let i = 0; i < 300 && !rows.some((row) => row.kind === "user_message"); i++) {
      await sleep(50);
      rows = await rowsOf();
    }
    assert.ok(rows.some((row) => row.kind === "user_message"), `the stop ended the wait while the round was held: ${JSON.stringify(rows.map((row) => row.kind))}`);
    assert.ok(Date.now() - stopAt < 15_000, `the stop ended the wait, not its ${waitMs} ms bound`);
    // Its stopped end is written once the agent's round before it ends (an agent's rounds go one after another).
    release();
    let done;
    for (let i = 0; i < 600; i++) {
      done = (await api("GET", `/runs/${next.body.run_id}`)).body;
      if (done.pending?.kind === "stopped" || ["completed", "failed", "cancelled"].includes(done.status)) break;
      await sleep(50);
    }
    assert.deepEqual([done.status, done.pending?.kind], ["input_required", "stopped"], JSON.stringify(done));
    assert.equal(ownAsks().length, 0, "it never asked its model");
    await ended(api, runId);
    const read = (await api("GET", `/runs/${next.body.run_id}/learning`)).body;
    assert.equal(read?.seed_waited ?? null, null, `nothing written: its start is the one its POST read: ${JSON.stringify(read)}`);
    return;
  }
  if (waitMs !== undefined) {
    // A runner whose bound passes with the round still held: the next run starts once the bound passed (at once for 0),
    // from the learning as it is, and its start says its wait timed out. It is never refused.
    // Its own answer, while the round is still held (its own round may queue behind that one, so its learning read waits).
    let done;
    for (let i = 0; i < 1800; i++) {
      done = (await api("GET", `/runs/${next.body.run_id}`)).body;
      if (done.status === "completed" || done.status === "failed") break;
      await sleep(50);
    }
    release();
    assert.equal(done.status, "completed", JSON.stringify(done));
    const first = ownAsks()[0];
    assert.ok(first, "the next run asked its model while the round was held");
    if (waitMs > 0) assert.ok(first.at - launched >= waitMs - 100, `it waited its bound first: asked ${first.at - launched} ms after its launch`);
    await ended(api, runId);
    await ended(api, next.body.run_id);
    const read = (await api("GET", `/runs/${next.body.run_id}/learning`)).body;
    assert.deepEqual([read?.seed_waited, read?.seed_failed], ["timed_out", null], JSON.stringify(read));
    return;
  }
  release();

  await ended(api, runId);
  const learning = (await api("GET", `/runs/${runId}/learning`)).body;
  assert.equal(learning?.state, "merged", `the follow-up round kept the correction: ${JSON.stringify(learning)}`);
  const { view: done } = await ended(api, next.body.run_id);
  const laid = ownAsks().map((one) => one.system);
  assert.ok(laid.length, "the next run asked its model");
  assert.ok(laid.every((system) => system.includes("# Learned") && system.includes(CODE)), `the next run, launched while the corrected run's round ran, starts from the correction it merged: ${JSON.stringify({ learning: done.learning, system: laid[0]?.slice(-800) })}`);
  // Its learning read names the merge it started from, a seed read, and the # Learned text it was given.
  const read = (await api("GET", `/runs/${next.body.run_id}/learning`)).body;
  assert.deepEqual([read.seed, read.seed_failed, read.seed_waited], [learning.merged, null, "ended"], JSON.stringify(read));
  assert.ok(read.learned_chars >= CODE.length, JSON.stringify(read));
}

for (const harness of ["claude-agent", "pi"]) test(`${harness}: an inline run launched while the corrected run's follow-up round runs starts from its correction`, SKIP, (t) => raced(t, { harness }));
test("claude-agent: the same, each run in a process of its own", SKIP, (t) => raced(t, { split: true }));
test("claude-agent: a runner whose bound is 0 starts the next run at once from the learning as it is, its wait timed out", SKIP, (t) => raced(t, { waitMs: 0 }));
test("claude-agent: a runner whose 1.5 s bound passes with the round held starts the next run after it, from the learning as it is, its wait timed out", SKIP, (t) => raced(t, { waitMs: 1_500 }));
test("claude-agent: a stop while the next run's claim waits ends it stopped at once through the runner, nothing asked and nothing written", SKIP, (t) => raced(t, { waitMs: 60_000, stop: true }));
