// An agent with learning on, on claude-agent's real adapter (its CLI and Agent SDK) against a scripted Anthropic endpoint
// on loopback, with no tool of its own: the end-of-run turn answers with two notes in ```note blocks, as the turn's
// message asks, and calls no tool; the server reads them from the answer, whole, and they are proposed, graded on the
// agent's own model at the same endpoint, and merged. What the CLI wrote beside the workspace never counts.
// What the model reads of that message is checked here, where the model reads it: the folder relative to the run's
// work, never a host path. The run's timeline shows a person only that it looks back.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { ended, keptProposal, learner, made, reflectRows, started } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-4-5";
const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
// A note longer than a timeline row's text, with a URL in it: the server reads the answer whole, never a row of it.
const SOURCES = note("Cite sources", "Name the page each figure came from", `A figure with no page could not be checked: https://example.com/policies/refund-policy?ref=notes\n${"Keep the page's own words. ".repeat(80).trimEnd()}\n`);
/** The end-of-run turn's message (reflectPrompt). */
const ASKED = /Answer with one block per note to keep\./;
/** The working directory the CLI tells its model, in the request's system prompt. */
const CWD = /(?:Primary working directory|Working directory): (\/[^\s"\\]+)/;
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));

test("on claude-agent's real adapter, with no tool of its own, the end-of-run turn answers with its notes and calls no tool: the server reads both whole from the answer, and they are proposed, for the runner's learning run to grade and merge", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let cwd;
  let graded = 0;
  let turns = 0;
  let prompt;
  const fake = await fakeAnthropic({
    reply: (r) => {
      // The grader: one call with no tools, on the agent's own model, which keeps both notes.
      if (r.text.includes("Answer with one JSON object and nothing else")) {
        graded += 1;
        return { text: JSON.stringify({ merge: true, reason: "Each note is general and new.", items: [{ file: "check-units.md", decision: "keep", why: "It holds as a general rule." }, { file: "cite-sources.md", decision: "keep", why: "It holds as a general rule." }] }) };
      }
      cwd ??= CWD.exec(JSON.stringify(r.body))?.[1];
      // The end-of-run turn: its message asks for the notes, and the answer holds them.
      const asked = r.messages.findLast((m) => m.role === "user" && ASKED.test(textOf(m)));
      if (asked) {
        turns += 1;
        prompt = textOf(asked);
        return { text: answerWith([["check-units.md", UNITS], ["cite-sources.md", SOURCES]]) };
      }
      return { text: "Claude answered." };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: undefined });
  const id = "claude-learner";
  await made(api, learner(id, { harness: "claude-agent", model: `anthropic/${MODEL}`, instructions: "Answer the question." }));

  const runId = await started(api, id, "Answer.");
  const { view, rows } = await ended(api, runId);
  assert.equal(view.status, "completed");
  assert.equal(view.result.final_answer, "Claude answered.", "the answer is the job's, never the turn's");
  assert.ok(cwd, "the CLI told its model its working directory");
  assert.equal(turns, 1, "one end-of-run turn");
  assert.deepEqual(reflectRows(rows).filter((row) => row.kind === "tool_use" || row.kind === "tool_result"), [], "it called no tool");
  const kept = await keptProposal({ api, data }, runId);
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
  assert.equal(kept.turn.answer, answerWith([["check-units.md", UNITS], ["cite-sources.md", SOURCES]]), "the answer whole");
  // The message names the folder relative to the run's work, never by a host path; the timeline shows none of it.
  assert.match(prompt, /The task is done\./);
  assert.match(prompt, /Your notes from earlier runs are in `\.learning\/`, listed in MEMORY\.md/);
  assert.doesNotMatch(prompt, /(?:^|[\s`'"(\[])\/[^\s/]/m, "the message holds no absolute path");
  assert.ok(!prompt.includes(data), "nor the data directory");
  assert.deepEqual(reflectRows(rows).filter((row) => row.kind === "user_message").map((row) => [row.summary, row.text]), [["Looking back on this run.", "Looking back on this run."]]);
  assert.deepEqual(kept.proposal.proposal.notes, [{ file: "check-units.md", text: UNITS }, { file: "cite-sources.md", text: SOURCES }]);
  // The grade and the merge are the runner's learning run (runner-learning-loop.test.mjs, runner-learning-folder.test.mjs),
  // which asks this endpoint once at most.
  assert.ok(graded <= 1, `the learning run grades once at most: ${graded}`);
});

