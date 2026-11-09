// An agent with learning on, on claude-agent's real adapter (its CLI and Agent SDK) against a scripted Anthropic endpoint
// on loopback, with no tool of its own: the end-of-run turn answers with two notes in ```note blocks, as the turn's
// message asks, and calls no tool; the server reads them from the answer, whole, and they are proposed, graded on the
// agent's own model at the same endpoint, and merged. What the CLI wrote beside the workspace never counts.
// What the model reads of that message is checked here, where the model reads it: the folder relative to the run's
// work, never a host path. The run's timeline shows a person only that it looks back.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { ended, learner, made, reflectRows, settled, started, turnOf } from "./learn-support.mjs";
import { runDir, serve, withEnv } from "./support.mjs";

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
        return { text: JSON.stringify({ merge: true, reason: "Each note is general and new.", items: [{ file: "check-units.md", keep: true, why: "It holds as a general rule." }, { file: "cite-sources.md", keep: true, why: "It holds as a general rule." }] }) };
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
  assert.equal(realpathSync(cwd), realpathSync(join(runDir(data, runId), "work")), "the CLI works in the run's workspace");
  assert.equal(turns, 1, "one end-of-run turn");
  assert.deepEqual(reflectRows(rows).filter((row) => row.kind === "tool_use" || row.kind === "tool_result"), [], "it called no tool");
  assert.equal(view.learning?.state, "proposed", JSON.stringify(view.learning));
  assert.equal(turnOf(data, runId).answer, answerWith([["check-units.md", UNITS], ["cite-sources.md", SOURCES]]), "the answer whole");
  // The message names the folder relative to the run's work, never by a host path; the timeline shows none of it.
  assert.match(prompt, /The task is done\./);
  assert.match(prompt, /Your notes from earlier runs are in `\.learning\/`, listed in MEMORY\.md/);
  assert.doesNotMatch(prompt, /(?:^|[\s`'"(\[])\/[^\s/]/m, "the message holds no absolute path");
  assert.ok(!prompt.includes(data), "nor the data directory");
  assert.deepEqual(reflectRows(rows).filter((row) => row.kind === "user_message").map((row) => [row.summary, row.text]), [["Looking back on this run.", "Looking back on this run."]]);
  const proposal = JSON.parse(readFileSync(join(runDir(data, runId), "learning-proposal.json"), "utf8"));
  assert.deepEqual(proposal.notes, [{ file: "check-units.md", text: UNITS }, { file: "cite-sources.md", text: SOURCES }]);
  // The grade and the merge are the runner's learning run, its grader asked through the kernel's proxy
  // (runner-learning-loop.test.mjs, runner-learning-folder.test.mjs): no server asks this endpoint to grade.
  assert.equal(graded, 0, "the server grades nothing");
});

test("on claude-agent's real adapter, a run that reads a note its CLI names by the working directory's full path used it: its learning block names the note by its name, and a note its end-of-run turn reads is not one it used", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let cwd;
  const text = (content) => (typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
  const results = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").length;
  const fake = await fakeAnthropic({
    reply: (r) => {
      if (!r.tools.includes("mcp__hands__read")) return { text: "ok" };
      cwd ??= CWD.exec(JSON.stringify(r.body))?.[1];
      const turn = r.messages.findLastIndex((m) => m.role === "user" && ASKED.test(text(m.content)));
      // The job: the note read at the CLI's working directory joined with .learning/, as Claude names a file, then the answer.
      if (turn < 0) return results(r.messages) === 0 ? { tool: { name: "mcp__hands__read", input: { path: `${cwd}/.learning/check-units.md` } } } : { text: "Claude answered." };
      // The end-of-run turn reads the other note, and keeps nothing.
      return results(r.messages.slice(turn + 1)) === 0 ? { tool: { name: "mcp__hands__read", input: { path: ".learning/cite-sources.md" } } } : { text: "Nothing new." };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL"]);
  const { api } = await serve(t, { learning: "on", faux: undefined });
  const id = "claude-reader";
  await made(api, learner(id, { harness: "claude-agent", model: `anthropic/${MODEL}`, tools: ["write", "read"], instructions: "Answer the question." }));
  // Two notes, as a person writes them.
  for (const [file, body] of [["check-units.md", UNITS], ["cite-sources.md", SOURCES]]) assert.equal((await api("PUT", `/agents/${id}/learning/files/${file}`, { text: body }, { "if-none-match": "*" })).status, 201);

  const runId = await started(api, id, "Answer.");
  const { view, rows } = await ended(api, runId, ["completed"]);
  assert.equal(view.result.final_answer, "Claude answered.");
  // Each read as claude-agent's rows hold it: the host's read, its path as the model gave it, and its result a success.
  const calls = rows.filter((row) => row.kind === "tool_use" && row.tool_name === "read").map((row) => [row.agent_label, row.tool_input_preview]);
  assert.deepEqual(calls, [[null, `${cwd}/.learning/check-units.md`], ["learning", ".learning/cite-sources.md"]], JSON.stringify(calls));
  assert.ok(rows.filter((row) => row.kind === "tool_result" && row.tool_name === "read").every((row) => row.tool_status === "success"));
  settled(view, rows, "dropped", "empty");
  assert.deepEqual(view.learning.read, [{ file: "check-units.md", name: "Check units" }]);
  assert.deepEqual((await api("GET", `/agents/${id}/runs`)).body.runs[0].learning.read, view.learning.read);
});
