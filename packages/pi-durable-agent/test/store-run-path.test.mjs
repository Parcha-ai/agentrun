// The run path of the agent store: a run pinned to a revision's verified body, and the home row that records it.
// The records, the index and `store.startRun` are the store's; these are the home-side halves they call.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { AgentHomeError, carryBack, createAgentHome, readAgentHome, startRun } from "../dist/index.js";
import { startPinnedRun } from "../dist/runs.js";
import { DEFINITION, scratch, sha256 } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;
const file = (content) => ({ content, sha256: sha256(content) });
const PIN = { revision: "rev-b", kind: "agentic", instructions: "Answer in one line.", tools: ["web_search"], skills: { "brief/SKILL.md": file("# Brief\n") } };

test("a pinned start seeds the run from the revision's body, never from the home's definition", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" } });
  const run = await startPinnedRun(home, PIN, { runId: "pinned-1", host: "test" });
  assert.deepEqual(run.agent, { instructions: "Answer in one line.", tools: ["web_search"] });
  assert.equal(await readFile(path.join(run.workspace, ".agents/skills/brief/SKILL.md"), "utf8"), "# Brief\n");
  assert.equal(existsSync(path.join(run.workspace, ".agents/skills/cite/SKILL.md")), false, "the definition's skill is not in a pinned run");
  const state = await readAgentHome(home);
  assert.equal(state.definition.instructions, DEFINITION.instructions, "the home's definition is untouched");
  assert.equal(state.runs["pinned-1"].revision, "rev-b");
  assert.equal(state.runs["pinned-1"].kind, "agentic");
});

test("a free start of the same home is unchanged: it seeds from the definition and records no revision", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" } });
  await startPinnedRun(home, PIN, { runId: "pinned-1", host: "test" });
  const run = await startRun(home, { runId: "free-1", host: "test" });
  assert.deepEqual(run.agent, { instructions: DEFINITION.instructions, tools: DEFINITION.tools });
  assert.equal(await readFile(path.join(run.workspace, ".agents/skills/cite/SKILL.md"), "utf8"), "# Cite\n");
  const state = await readAgentHome(home);
  assert.equal("revision" in state.runs["free-1"], false);
  assert.equal("kind" in state.runs["free-1"], false);
});

test("a pinned skill whose bytes do not match its sha256 is refused (format), and nothing is written", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const bad = { ...PIN, skills: { "brief/SKILL.md": { content: "# Brief\n", sha256: sha256("something else") } } };
  await assert.rejects(startPinnedRun(home, bad, { runId: "bad-1", host: "test" }), refused("format"));
  assert.equal(existsSync(path.join(home.dir, "runs", "bad-1")), false);
  assert.equal(Object.hasOwn((await readAgentHome(home)).runs, "bad-1"), false);
});

test("a pin that is not a revision pin is refused (invalid) before anything is touched", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  for (const pin of [{ ...PIN, revision: "" }, { ...PIN, kind: "other" }, { ...PIN, instructions: 3 }, { ...PIN, tools: "web_search" }, { ...PIN, skills: { "../escape": file("x") } }]) {
    await assert.rejects(startPinnedRun(home, pin, { runId: "inv-1", host: "test" }), refused("invalid"));
  }
  assert.equal(existsSync(path.join(home.dir, "runs", "inv-1")), false);
  assert.equal(Object.hasOwn((await readAgentHome(home)).runs, "inv-1"), false);
});

test("a pinned start whose seed fails after the record is written is undone: no record, no directory, the first run untouched", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  await startPinnedRun(home, PIN, { runId: "kept-1", host: "test" });
  // `runs` becomes a file, so the next run's directory cannot be made: the failure comes AFTER prepareRun committed the record.
  await rm(path.join(home.dir, "runs"), { recursive: true, force: true });
  await writeFile(path.join(home.dir, "runs"), "not a directory");
  await assert.rejects(startPinnedRun(home, PIN, { runId: "undone-1", host: "test" }));
  assert.equal(Object.hasOwn((await readAgentHome(home)).runs, "undone-1"), false, "the record is undone");
  assert.equal(Object.hasOwn((await readAgentHome(home)).runs, "kept-1"), true, "another run's record is not touched");
});

test("a taken run id is refused (exists) and the first run's record keeps its revision", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  await startPinnedRun(home, PIN, { runId: "dup-1", host: "test" });
  await assert.rejects(startPinnedRun(home, { ...PIN, revision: "rev-c" }, { runId: "dup-1", host: "test" }), refused("exists"));
  assert.equal((await readAgentHome(home)).runs["dup-1"].revision, "rev-b");
});

test("carryBack stores a summary on the home row, ends it once, and a second call changes nothing", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startPinnedRun(home, PIN, { runId: "sum-1", host: "test" });
  const first = await carryBack(home, run, { outcome: "completed", finalAnswer: "42", summary: "42", cost: 0.01 });
  assert.equal(first.changed, true);
  const second = await carryBack(home, run, { outcome: "failed", summary: "overwritten?" });
  assert.equal(second.changed, false);
  const row = (await readAgentHome(home)).runs["sum-1"];
  assert.deepEqual({ outcome: row.outcome, summary: row.summary, cost: row.cost, revision: row.revision }, { outcome: "completed", summary: "42", cost: 0.01, revision: "rev-b" });
});

test("a free carryBack with no summary writes none (the free callers' rows are unchanged)", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { runId: "free-sum", host: "test" });
  await carryBack(home, run, { outcome: "completed" });
  assert.equal("summary" in (await readAgentHome(home)).runs["free-sum"], false);
});

test("an invalid summary is refused (invalid): not a non-empty string of bounded length", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { runId: "bad-sum", host: "test" });
  for (const summary of ["", 3, "x".repeat(5_000)]) await assert.rejects(carryBack(home, run, { outcome: "completed", summary }), refused("invalid"));
  assert.equal((await readAgentHome(home)).runs["bad-sum"].endedAt, undefined);
});
