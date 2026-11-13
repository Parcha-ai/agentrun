// A run on a CLI harness reads `reflecting` while its end-of-run turn runs, as a pi run does (#2349): the CLI record writes
// the turn's prompt as the turn is asked, not only once it is answered, so the run's view and Timeline say it is looking
// back from the moment it starts, between the job's answer and what the turn proposes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { ended, learner, made, reflectRows, sleep, started } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-5-5";
const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
/** The end-of-run turn's message (reflectPrompt). */
const ASKED = /Answer with one block per note to keep\./;
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));

test("on claude-agent, a run reads reflecting while its end-of-run turn runs: after the job's answer, before the turn's proposal", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let turnStarted;
  const asked = new Promise((resolve) => (turnStarted = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const fake = await fakeAnthropic({
    reply: async (r) => {
      if (r.text.includes("Answer with one JSON object and nothing else")) {
        return { text: JSON.stringify({ merge: true, reason: "General and new.", items: [{ file: "check-units.md", decision: "keep", general: true, why: "It holds as a general rule." }] }) };
      }
      // The end-of-run turn: held open until the test has read the run while it runs.
      if (r.messages.some((m) => m.role === "user" && ASKED.test(textOf(m)))) {
        turnStarted();
        await held;
        return { text: answerWith([["check-units.md", UNITS]]) };
      }
      return { text: "Claude answered." };
    },
  });
  t.after(() => fake.close());
  t.after(() => release());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api } = await serve(t, { learning: "on", faux: undefined });
  await made(api, learner("cli-reflect", { harness: "claude-agent", model: `anthropic/${MODEL}`, instructions: "Answer the question." }));
  const runId = await started(api, "cli-reflect", "Answer.");

  await asked;
  // The turn runs (its model request is held): the run reads reflecting, its answer is already given, and its Timeline
  // shows the turn's "Looking back" row.
  let view;
  for (let i = 0; i < 200; i++) {
    view = (await api("GET", `/runs/${runId}`)).body;
    if (view.learning?.state === "reflecting") break;
    await sleep(50);
  }
  assert.equal(view.learning?.state, "reflecting", JSON.stringify(view.learning));
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  assert.ok(rows.some((row) => row.kind === "final_answer"), "the job has answered");
  assert.ok(reflectRows(rows).some((row) => /Looking back/.test(row.summary ?? row.text ?? "")), JSON.stringify(rows.map((row) => [row.kind, row.agent_label, row.summary])));

  release();
  const { view: done } = await ended(api, runId);
  assert.equal(done.status, "completed");
  assert.equal(done.learning?.state, "merged", JSON.stringify(done.learning));
});

// The live wake (#2365 review): an already-open Timeline stream (server.ts timeline, its watchRun) re-reads its page only
// when a commit gives it events. A CLI run's end-of-run turn starts with one commit that holds only the turn's prompt (the
// CLI record's answering): that commit gives the turn's message, labelled the turn's, so the open stream shows "Looking
// back" at once, never on its 15-second beat.
test("a stream already open when a CLI run's end-of-run turn is asked is woken by the turn's prompt, labelled the turn's", async (t) => {
  const { KINDS } = await import("../dist/runner/journal-kinds.js");
  const { REFLECT_LABEL } = await import("../dist/runner/end-of-run.js");
  const { watchRun } = await import("../dist/live/stream.js");
  let seq = 0;
  const commits = [];
  const commit = (entries) => commits.push({ seq: ++seq, entries, documents: [], tasks: [], submissions: [] });
  const entry = (kind, data, model) => ({ id: seq + 1, conversationId: 1, kind, data, ...(model ? { model } : {}) });
  // The run so far: the person's message and the job's answer, as a CLI run records them.
  commit([entry(KINDS.message, { role: "person", text: "Answer." })]);
  commit([entry(KINDS.message, { role: "model", text: "Answered." })]);
  const store = {
    runs: { get: async () => ({ id: "run-1", epoch: 1, state: "running" }) },
    journal: () => ({
      commitsAfter: async (after) => ({ commits: commits.filter((one) => one.seq > after) }),
      close: async () => {},
    }),
    live: { read: async () => [] },
  };
  const stream = await watchRun(store, "run-1", { pollMs: 20 });
  t.after(() => stream.stop());
  const woken = [];
  stream.start((events) => void woken.push(...events));
  await sleep(100);
  const before = woken.length;
  // The turn is asked: the CLI record writes its prompt in a commit of its own (adapter-loop.ts answering).
  const prompt = "Answer with one block per note to keep.";
  commit([entry(KINDS.endOfRunTurn, { role: "person", text: prompt, requestId: "learn-reflect-run-1" }, [{ role: "user", content: prompt, timestamp: 1 }])]);
  for (let i = 0; i < 100 && woken.length === before; i++) await sleep(20);
  const turn = woken.slice(before);
  assert.ok(turn.length > 0, "the turn's prompt wakes the open stream");
  const ended = turn.find((event) => event.type === "message_end");
  assert.ok(ended, `the prompt is a message: ${JSON.stringify(turn)}`);
  assert.equal(ended.agent_label, REFLECT_LABEL, "labelled the turn's");
});
