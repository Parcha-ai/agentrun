// A follow-up whose `content` is a host's scaffolding around the person's words (a preamble, the previous report, the
// question, turn instructions, a language line), sent with `said`: the person's own words. The model gets `content`
// exactly; learning keeps `said` as the correction (runner/learning-end.ts ownerWords), so corrections.md holds the
// person's short lines, never the host's text, and the agent's next run is told each under # Learned. A message with no
// `said` keeps its whole `content`, as before. A `said` that is not a string, is empty after trimming, or is past 4,000
// characters is refused, 422 input_invalid on the field `said`, and nothing is written. GET /capabilities says the server
// takes it: features.messages.said.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { ended, LEARN, learner, learningAt, made, started } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-5-5";
const FIRST = "Correction for every later run: the codeword for the learning walk is KESTREL-840583, always.";
const SECOND = "Correction for every later run: the backup codeword for the walk is OSPREY-112358, never another.";
const ASK = "What is the codeword for the learning walk? If you do not know it, answer exactly: UNKNOWN.";
// The host's scaffolding, about 1.9 KB around the person's ~100 bytes.
const PREAMBLE = "You are continuing a research session for the person below. Keep the structure and tone of the earlier report.";
const REPORT = Array.from({ length: 20 }, (_, i) => `Finding ${i + 1}: the walk's log lists step ${i + 1} as done, with nothing left open on it.`).join("\n");
const host = (question) => [PREAMBLE, `## Previous report\n${REPORT}`, `**Follow-up question**: ${question}`, "## Turn instructions\nAnswer the follow-up question only. Cite the earlier report where it applies.", "Reply in English."].join("\n\n");
const line = (text) => `- ${text.replace(/\s+/g, " ").trim()}\n`;
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n"));
const systemOf = ({ body }) => (typeof body.system === "string" ? body.system : textOf(body.system));
const userTexts = ({ body }) => (body.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
const SKIP = { timeout: 300_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" };

/** An agent that learns on claude-agent behind a fake Anthropic (compile_after 3: no round here compiles, each
 *  follow-up's round is a correction alone), its first run ended. */
async function learning(t) {
  const requests = [];
  const fake = await fakeAnthropic({
    reply: async (request) => {
      if (request.path !== "/v1/messages") return { text: "" };
      requests.push(request);
      return { text: "UNKNOWN" };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG"]);
  const { api, store } = await serve(t, { learning: "on", faux: undefined });
  await made(api, learner("walk", { harness: "claude-agent", model: `anthropic/${MODEL}`, learning: { compile_after: 3 } }));
  const runId = await started(api, "walk", ASK);
  await ended(api, runId);
  return { api, store, runId, requests };
}

test("two follow-ups whose content wraps the person's words in ~1.9 KB of host text, each sent with said: corrections.md holds the two short lines, the model got each content whole, and the next run's # Learned holds both and no host text", SKIP, async (t) => {
  const { api, store, runId, requests } = await learning(t);
  for (const said of [FIRST, SECOND]) {
    const content = host(said);
    assert.ok(content.length > 1800 && content.length < 2048, `the host's text is about 1.9 KB (${content.length})`);
    const sent = await api("POST", `/runs/${runId}/messages`, { content, said });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const { view } = await ended(api, runId);
    assert.equal(view.learning?.state, "merged", `the round merged: ${JSON.stringify(view.learning)}`);
    assert.ok(requests.some((request) => userTexts(request).some((text) => text.includes(content))), "the model got the message's content whole");
  }
  assert.equal((await learningAt(store, "walk")).text("corrections.md"), `${line(FIRST)}${line(SECOND)}`, "the person's two lines, no host text");

  const asked = requests.length;
  const next = await started(api, "walk", ASK);
  await ended(api, next);
  const laid = requests.slice(asked).map(systemOf);
  assert.ok(laid.length, "the next run asked its model");
  for (const system of laid) {
    const learned = system.slice(system.indexOf("# Learned"));
    assert.ok(system.includes("# Learned") && learned.includes(FIRST) && learned.includes(SECOND), `# Learned holds both corrections: ${learned.slice(0, 800)}`);
    for (const scaffold of [PREAMBLE, "Follow-up question", "Previous report", "Turn instructions", "Finding 1:"]) assert.ok(!system.includes(scaffold), `no host text under # Learned: ${scaffold}`);
  }
});

// A host's real follow-up is longer than a Timeline row shows (CAPS.text, 2,000 characters): ~3.5 KB here, the person's
// words at its end, past the row's cut. The row is cut; learning reads the message whole from the run's commands and
// pairs it with its row by the row's own rule, so `said` is still the line.
const LONG_REPORT = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: the walk's log lists step ${i + 1} as done, with nothing left open on it.`).join("\n");
const longHost = (question) => [PREAMBLE, `## Previous report\n${LONG_REPORT}`, `**Follow-up question**: ${question}`, "## Turn instructions\nAnswer the follow-up question only. Cite the earlier report where it applies.", "Reply in English."].join("\n\n");

test("two follow-ups whose content is ~3.5 KB of host text (past the row's 2,000-character cut), each sent with said: corrections.md holds the two said lines, no host text", SKIP, async (t) => {
  const { api, store, runId, requests } = await learning(t);
  for (const said of [FIRST, SECOND]) {
    const content = longHost(said);
    assert.ok(content.length > 3_000 && content.length < 4_000, `the host's text is about 3.5 KB (${content.length})`);
    const sent = await api("POST", `/runs/${runId}/messages`, { content, said });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const { view } = await ended(api, runId);
    assert.equal(view.learning?.state, "merged", `the round merged: ${JSON.stringify(view.learning)}`);
    assert.ok(requests.some((request) => userTexts(request).some((text) => text.includes(content))), "the model got the message's content whole");
  }
  assert.equal((await learningAt(store, "walk")).text("corrections.md"), `${line(FIRST)}${line(SECOND)}`, "the person's two lines, no host text");
});

test("a follow-up with no said: its whole content is the correction, as before", SKIP, async (t) => {
  const { api, store, runId } = await learning(t);
  const content = host(FIRST);
  const sent = await api("POST", `/runs/${runId}/messages`, { content });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const { view } = await ended(api, runId);
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  assert.equal((await learningAt(store, "walk")).text("corrections.md"), line(content), "the whole content, folded to one line");
});

test("the server says it takes said (features.messages.said); a said that is not a string, empty after trimming or past 4,000 characters is refused, 422 input_invalid on said, nothing written; one of 4,000 that content does not hold is taken", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { learning: "on", faux: LEARN });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.messages, { steer: true, answer: true, follow_up: true, steer_workflow_runs: false, said: true }, JSON.stringify(caps.features.messages));
  await made(api, learner("refused"));
  const runId = await started(api, "refused", "Classify Acme Diner.");
  await ended(api, runId);
  const steers = async () => (await store.commands(runId, 0)).filter((command) => command.kind === "steer").length;
  const before = await steers();
  for (const [said, reason] of [["", "empty"], ["  \n ", "empty"], [42, "wrong_type"], [null, "wrong_type"], [["words"], "wrong_type"], ["x".repeat(4_001), "too_long"]]) {
    const sent = await api("POST", `/runs/${runId}/messages`, { content: host(FIRST), said });
    assert.equal(sent.status, 422, `${JSON.stringify(said).slice(0, 40)}: ${JSON.stringify(sent.body).slice(0, 300)}`);
    assert.equal(sent.body.error?.code, "input_invalid", JSON.stringify(sent.body).slice(0, 300));
    assert.deepEqual(sent.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["said", reason]], JSON.stringify(sent.body).slice(0, 300));
  }
  assert.equal(await steers(), before, "no refused message was written");
  const taken = await api("POST", `/runs/${runId}/messages`, { content: host(FIRST), said: "y".repeat(4_000) });
  assert.equal(taken.status, 202, JSON.stringify(taken.body).slice(0, 300));
  assert.equal(await steers(), before + 1, "the message was written");
  // Counted in code points, as a host's len() and the schema's maxLength count: 4,000 emoji are 8,000 UTF-16 units.
  const emoji = "\u{1F600}".repeat(4_000);
  assert.equal(emoji.length, 8_000);
  const wide = await api("POST", `/runs/${runId}/messages`, { content: host(FIRST), said: emoji });
  assert.equal(wide.status, 202, JSON.stringify(wide.body).slice(0, 300));
  assert.equal(await steers(), before + 2, "the 4,000-code-point message was written");
  const over = await api("POST", `/runs/${runId}/messages`, { content: host(FIRST), said: `${emoji}x` });
  assert.equal(over.status, 422, JSON.stringify(over.body).slice(0, 300));
  assert.deepEqual(over.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["said", "too_long"]], JSON.stringify(over.body).slice(0, 300));
  assert.equal(await steers(), before + 2, "the 4,001-code-point message was not written");
});
