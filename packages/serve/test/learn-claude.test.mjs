// An agent with learning on, on claude-agent's real adapter (its CLI and Agent SDK) against a scripted Anthropic endpoint
// on loopback: the end-of-run turn writes its notes where the turn's message says, and they land in the run's
// work/.learning/, are proposed, graded on the agent's own model at the same endpoint, and merged. The scripted model
// does what a model does with that message: one note at the folder it names, relative, and one at its CLI's working
// directory joined with that folder, as a model that resolves "in your working directory" writes it (QA run 3, F20).
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, learner, made, reflectRows, repoOf, savedOf, settled, started, turnCopyOf } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-4-5";
const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const SOURCES = note("Cite sources", "Name the page each figure came from", "A figure with no page could not be checked.\n");
/** The folder the end-of-run turn's message names (reflectPrompt): "Your notes from earlier runs are in `<dir>/`". */
const FOLDER = /Your notes from earlier runs are in `([^`]+)\/`, in your working directory/;
/** The working directory the CLI tells its model, in the request's system prompt. */
const CWD = /(?:Primary working directory|Working directory): (\/[^\s"\\]+)/;

test("on claude-agent's real adapter, the end-of-run turn's notes land in the run's work/.learning/, one written relative to the folder the turn names and one at the CLI's working directory, and both are proposed, graded at the same endpoint and merged", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let cwd;
  let graded = 0;
  const fake = await fakeAnthropic({
    reply: (r) => {
      // The grader: one call with no tools, on the agent's own model, which keeps both notes.
      if (r.text.includes("Answer with one JSON object and nothing else")) {
        graded += 1;
        return { text: JSON.stringify({ merge: true, reason: "Each note is general and new.", items: [{ file: "check-units.md", keep: true, why: "It holds as a general rule." }, { file: "cite-sources.md", keep: true, why: "It holds as a general rule." }] }) };
      }
      if (!r.tools.includes("mcp__hands__write")) return { text: "ok" };
      cwd ??= CWD.exec(JSON.stringify(r.body))?.[1];
      // The end-of-run turn: its message names the folder; after a write's result comes the next write, then a line.
      const turn = r.messages.findLastIndex((m) => m.role === "user" && FOLDER.test(typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")));
      if (turn < 0) return { text: "Claude answered." };
      const asked = r.messages[turn];
      const dir = FOLDER.exec(typeof asked.content === "string" ? asked.content : asked.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"))[1];
      const written = r.messages.slice(turn + 1).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").length;
      if (written === 0) return { tool: { name: "mcp__hands__write", input: { path: `${dir}/check-units.md`, content: UNITS } } };
      if (written === 1) return { tool: { name: "mcp__hands__write", input: { path: `${cwd}/${dir}/cite-sources.md`, content: SOURCES } } };
      return { text: "Noted." };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t, { learning: "on", faux: undefined });
  const id = "claude-learner";
  await made(api, learner(id, { harness: "claude-agent", model: `anthropic/${MODEL}`, instructions: "Answer the question." }));

  const runId = await started(api, id, "Answer.");
  const { view, rows } = await ended(api, runId);
  assert.equal(view.status, "completed");
  assert.equal(view.result.final_answer, "Claude answered.", "the answer is the job's, never the turn's");
  const work = join(data, "runs", runId, "work");
  assert.ok(cwd, "the CLI told its model its working directory");
  assert.equal(realpathSync(cwd), realpathSync(work), "the CLI works in the run's workspace");
  // The turn's two writes, both through the host's write tool, both in work/.learning/.
  const writes = reflectRows(rows).filter((row) => row.kind === "tool_result").map((row) => [row.tool_name, row.tool_status]);
  assert.deepEqual(writes, [["write", "success"], ["write", "success"]], JSON.stringify(reflectRows(rows).map((row) => row.tool_result_preview)));
  settled(view, rows, "merged");
  // Set aside out of its work as the run ended: what the turn wrote is what was checked.
  assert.equal(readFileSync(join(turnCopyOf(data, runId), "check-units.md"), "utf8"), UNITS);
  assert.equal(readFileSync(join(turnCopyOf(data, runId), "cite-sources.md"), "utf8"), SOURCES);
  const proposal = JSON.parse(readFileSync(join(data, "runs", runId, "learning-proposal.json"), "utf8"));
  assert.deepEqual(proposal.notes.map((n) => n.file).sort(), ["check-units.md", "cite-sources.md"]);

  // Graded once, at the endpoint the run's own requests went to, and merged onto the folder's main.
  assert.equal(graded, 1, "the grader asked the same endpoint once");
  const { learning } = await savedOf(data, runId);
  assert.equal(learning.verdict.merge, true, JSON.stringify(learning));
  const repo = repoOf(data, id);
  assert.equal(learning.merged, git(repo, ["rev-parse", "main"]));
  assert.equal(`${git(repo, ["show", "main:check-units.md"])}\n`, UNITS);
  assert.equal(`${git(repo, ["show", "main:cite-sources.md"])}\n`, SOURCES);
  assert.deepEqual(git(repo, ["show", "main:MEMORY.md"]).split("\n").sort(), [
    "- [Check units](check-units.md) — Convert every amount to one unit before comparing",
    "- [Cite sources](cite-sources.md) — Name the page each figure came from",
  ]);
  assert.ok(!existsSync(join(data, "runs", runId, ".learning")) && !existsSync(join(data, "runs", runId, "harness", "work", ".learning")), "nothing was written beside the workspace");
});
