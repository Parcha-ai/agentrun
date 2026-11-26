// An agent corrected by follow-up more than once, each correction wrapped as the host wraps a follow-up turn (its
// preamble, the previous turn's report, "**Follow-up question**: <the owner's words>", a language line): about 2 KB a
// correction, which is the line corrections.md keeps whole. The newest correction is kept, and the next run's # Learned
// holds its words: an earlier correction never makes the file refuse a later one.
//   - unit: two such corrections appended on the agent's learning (learn/commit.ts appendCorrection), the second checked
//     first as a run's end checks it (correctionRefused);
//   - end to end: two runs of an inline claude-agent agent (a fake model), each corrected by a wrapped follow-up, then a
//     third run whose system prompt carries the second correction under # Learned.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { appendCorrection, correctionRefused } from "../dist/learn/commit.js";
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

const CODES = ["HARBOR-1A7C0E", "HARBOR-2B8D1F"];
const WORDS = CODES.map((code) => `Correction for every later run: the harbor code is ${code}`);
const MESSAGES = WORDS.map(wrapped);

test("setup: each wrapped correction is about 2 KB as corrections.md keeps it, one fits alone and two do not under 2048 bytes", () => {
  for (const message of MESSAGES) {
    const bytes = Buffer.byteLength(correctionLine(message));
    assert.ok(bytes > 1900 && bytes <= 2048, `a wrapped correction's line is ${bytes} bytes`);
  }
});

test("two wrapped follow-up corrections on an agent's learning: the second is taken, not refused, and the next run's seed holds its words", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-corrections-cap-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Harbor" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  await seedOf(dir, store, "agent-1");
  const learning = learningOf(store, "agent-1");

  const first = await appendCorrection(learning, { runId: "run-1", round: 2, text: MESSAGES[0] });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(await correctionRefused(learning, MESSAGES[1], [], { runId: "run-2", round: 2 }), [], "the second correction would be taken");
  const second = await appendCorrection(learning, { runId: "run-2", round: 2, text: MESSAGES[1] });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.refusedCorrection, undefined, JSON.stringify(second));

  const corrections = (await learningAt(store, "agent-1")).text("corrections.md") ?? "";
  assert.ok(corrections.includes(CODES[1]), `corrections.md holds the newest correction: ${corrections.length} chars`);
  const seed = await seedOf(dir, store, "agent-1");
  assert.ok(seed.corrections.includes(WORDS[1]), "the next run's seed holds the newest correction's words");
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
  for (const [i, message] of MESSAGES.entries()) {
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
