// An agent corrected by follow-up more than once, each correction wrapped as the host wraps a follow-up turn (its
// preamble, the previous turn's report, "**Follow-up question**: <the owner's words>", a language line): about 2 KB a
// correction, which is the line corrections.md keeps whole. The newest correction is kept, and the next run's # Learned
// holds its words: an earlier correction never makes the file refuse a later one. Past the cap (8 KB), the file's oldest
// lines are dropped to fit, and the merge says how many; a line past the cap alone is still refused.
//   - unit: such corrections appended on the agent's learning (learn/commit.ts appendCorrection), each checked first as
//     a run's end checks it (correctionRefused);
//   - end to end: two runs of an inline claude-agent agent (a fake model), each corrected by a wrapped follow-up, then a
//     third run whose system prompt carries the second correction under # Learned.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { appendCorrection, correctionRefused, learningCommit } from "../dist/learn/commit.js";
import { correctionLine } from "../dist/learn/corrections.js";
import { learningOf } from "../dist/learn/rows.js";
import { seedOf } from "../dist/learning.js";
import { openSqliteStore } from "../dist/store/index.js";
import { ended, learningAt } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const PREAMBLE = "Follow-up on this job. Your workspace and this conversation hold the earlier turns' work: read what you wrote before and build on it rather than repeating it. The instructions you were given at the start still apply, except where those below change them.";
/** The previous turn's report, as the host quotes it back: about 1.6 KB. */
const REPORT = [
  "# Harbor traffic report",
  "## Summary",
  "The north quay handled most of last week's container traffic; the south quay was closed two days for dredging. Pilot logs, the port notices and the tide tables agree on every figure below unless a line says otherwise. Figures are for the seven days ending Sunday at midnight, harbor time.",
  "## Findings",
  ...Array.from({ length: 8 }, (_, i) => `- Berth ${i + 1}: ${1200 + 37 * i} containers moved, ${3 + (i % 4)} vessels berthed, no tide window conflict; the pilot log and the port notice for the day agree.`),
  "## Open questions",
  "- The harbor code printed on the port notice differs from the one in the pilot log; this report used the pilot log's.",
  "- Two vessels on the south quay list have no berth recorded for the dredging days.",
].join("\n");
/** The owner's words as the host wraps a follow-up turn. */
const wrapped = (words) => [PREAMBLE, REPORT, `**Follow-up question**: ${words}`, "Write in language code: en."].join("\n\n");

const CODES = ["HARBOR-1A7C0E", "HARBOR-2B8D1F", "HARBOR-3C9E2A", "HARBOR-4DAF3B", "HARBOR-5EB04C", "HARBOR-6FC15D"];
const WORDS = CODES.map((code) => `Correction for every later run: the harbor code is ${code}`);
const MESSAGES = WORDS.map(wrapped);
const CAP = 8192;

test("setup: each wrapped correction is about 2 KB as corrections.md keeps it: four fit under the cap, five do not", () => {
  const sizes = MESSAGES.map((message) => Buffer.byteLength(correctionLine(message)));
  for (const bytes of sizes) assert.ok(bytes > 1900 && bytes <= 2048, `a wrapped correction's line is ${bytes} bytes`);
  const sum = (n) => sizes.slice(0, n).reduce((a, b) => a + b, 0);
  assert.ok(sum(4) <= CAP && sum(5) > CAP, `four take ${sum(4)} bytes, five ${sum(5)}`);
});

/** A fresh store with agent-1, which learns; its learning and the store, closed at the test's end. */
async function harborLearning(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-corrections-cap-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Harbor" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  await seedOf(dir, store, "agent-1");
  return { dir, store, learning: learningOf(store, "agent-1") };
}

test("two wrapped follow-up corrections on an agent's learning: the second is taken, not refused, and the next run's seed holds its words", async (t) => {
  const { dir, store, learning } = await harborLearning(t);
  const first = await appendCorrection(learning, { runId: "run-1", round: 2, text: MESSAGES[0] });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(correctionRefused(MESSAGES[1], []), [], "the second correction would be taken");
  const second = await appendCorrection(learning, { runId: "run-2", round: 2, text: MESSAGES[1] });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual([second.refusedCorrection, second.droppedLines], [undefined, undefined], JSON.stringify(second));

  const corrections = (await learningAt(store, "agent-1")).text("corrections.md") ?? "";
  assert.ok(corrections.includes(CODES[0]) && corrections.includes(CODES[1]), `corrections.md holds both: ${corrections.length} chars`);
  const seed = await seedOf(dir, store, "agent-1");
  assert.ok(seed.corrections.includes(WORDS[1]), "the next run's seed holds the newest correction's words");
});

test("past the cap the newest correction wins: the oldest lines are dropped to fit, the merge says how many, and the file stays within the cap", async (t) => {
  const { dir, store, learning } = await harborLearning(t);
  const dropped = [];
  for (const [i, text] of MESSAGES.entries()) {
    assert.deepEqual(correctionRefused(text, []), [], `correction ${i + 1} would be taken`);
    const done = await appendCorrection(learning, { runId: `run-${i + 1}`, round: 2, text });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.refusedCorrection, undefined, JSON.stringify(done));
    dropped.push(done.droppedLines ?? 0);
  }
  // Four fit; the fifth drops the first, the sixth the second.
  assert.deepEqual(dropped, [0, 0, 0, 0, 1, 1]);
  const corrections = (await learningAt(store, "agent-1")).text("corrections.md") ?? "";
  assert.ok(Buffer.byteLength(corrections) <= CAP, `within the cap: ${Buffer.byteLength(corrections)} bytes`);
  assert.deepEqual(CODES.map((code) => corrections.includes(code)), [false, false, true, true, true, true], "the two oldest out, the four newest in");
  assert.equal(corrections, MESSAGES.slice(2).map(correctionLine).join(""), "in order, oldest first");
  assert.ok((await seedOf(dir, store, "agent-1")).corrections.includes(WORDS[5]), "the next run's seed holds the newest");
});

test("a correction whose line alone is past the cap is refused whole, in the cap's words; the file stays as it was", async (t) => {
  const { store, learning } = await harborLearning(t);
  assert.equal((await appendCorrection(learning, { runId: "run-1", round: 2, text: MESSAGES[0] })).ok, true);
  const before = (await learningAt(store, "agent-1")).text("corrections.md");
  const huge = wrapped(`${WORDS[1]} ${"and every berth again ".repeat(320)}`);
  const refused = correctionRefused(huge, []);
  assert.deepEqual(refused.map(({ rule, path }) => [rule, path]), [["too_large", "corrections.md"]], JSON.stringify(refused));
  assert.match(refused[0].detail, /corrections\.md would hold \d+ bytes for this correction alone; the cap is 8192 bytes/);
  const done = await appendCorrection(learning, { runId: "run-2", round: 2, text: huge });
  assert.deepEqual([done.ok, done.reason, done.problems?.[0]?.detail], [false, "refused", refused[0].detail], JSON.stringify(done));
  assert.equal((await learningAt(store, "agent-1")).text("corrections.md"), before, "unchanged");
  // Beside a draft, the line alone is left out and the draft merges.
  const beside = await learningCommit(learning, { runId: "run-3", round: 2, reason: "a draft", files: [{ path: "workflows/answer/README.md", text: "A note.\n" }], correction: huge });
  assert.equal(beside.ok, true, JSON.stringify(beside));
  assert.deepEqual(beside.refusedCorrection?.map(({ rule }) => rule), ["too_large"], JSON.stringify(beside));
  const after = await learningAt(store, "agent-1");
  assert.deepEqual([after.text("workflows/answer/README.md"), after.text("corrections.md")], ["A note.\n", before], "the draft in, the file unchanged");
});

const MODEL = "claude-haiku-5-5";
const SKIP = { timeout: 300_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" };
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n"));
const systemOf = ({ body }) => (typeof body.system === "string" ? body.system : textOf(body.system));

/** The host's inline body: the agent's reference, its definition, the run's input. */
const inline = (prompt) => ({
  external: { source: "host", kind: "expert", id: "workspace-1:expert-1", version: "1.aaaaaaaaaaaaaaaa" },
  definition: {
    name: "Harbor expert",
    instructions: prompt,
    skills: [],
    tools: [],
    harness: "claude-agent",
    model: `anthropic/${MODEL}`,
    computer: { kind: "none" },
    learning: { compile_after: 3 },
  },
  input: { content: "What is the harbor code? If you do not know it, answer exactly: UNKNOWN." },
  max_cost_usd: 5,
});

test("claude-agent: two runs each corrected by a host-wrapped follow-up keep both rounds' corrections; the third run's # Learned holds the second", SKIP, async (t) => {
  const systems = [];
  const fake = await fakeAnthropic({
    reply: async (request) => {
      if (request.path !== "/v1/messages") return { text: "" };
      systems.push(systemOf(request));
      return { text: "UNKNOWN" };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG"]);
  const { api } = await serve(t, { learning: "on", faux: undefined });
  const prompt = "You are the harbor expert. Answer the user's question.";

  let agentId;
  for (const [i, message] of MESSAGES.slice(0, 2).entries()) {
    const run = await api("POST", "/runs", inline(prompt));
    assert.equal(run.status, 202, JSON.stringify(run.body));
    agentId ??= run.body.agent_id;
    assert.equal(run.body.agent_id, agentId, "the same agent");
    await ended(api, run.body.run_id);
    const sent = await api("POST", `/runs/${run.body.run_id}/messages`, { content: message });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const { view } = await ended(api, run.body.run_id);
    assert.equal(view.status, "completed");
    assert.equal(view.learning?.state, "merged", `correction ${i + 1}'s round kept it: ${JSON.stringify(view.learning)}`);
  }
  const corrections = String((await api("GET", `/agents/${agentId}/learning/corrections`)).body?.text ?? "");
  assert.ok(corrections.includes(CODES[1]), `the agent's corrections hold the second correction: ${corrections.length} chars`);

  const asked = systems.length;
  const next = await api("POST", "/runs", inline(prompt));
  assert.equal(next.status, 202, JSON.stringify(next.body));
  assert.equal(next.body.agent_id, agentId, "the same agent");
  await ended(api, next.body.run_id);
  const system = systems[asked] ?? "";
  assert.ok(system.includes("# Learned") && system.includes(CODES[1]), `the third run's system prompt carries the second correction under # Learned: ${system.slice(-600)}`);
});
