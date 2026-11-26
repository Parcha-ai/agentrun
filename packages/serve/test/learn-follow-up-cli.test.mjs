// A follow-up to a finished claude-agent run of an agent that learns, as a host sends one (POST /runs/{id}/messages):
// what the person said in that round is their correction, appended to corrections.md, and the agent's next run is told
// it under # Learned. learn-follow-up.test.mjs proves the save on pi; this is the same round on a CLI harness's record,
// and the next run's system prompt as its model receives it. Each case also runs on Postgres in CI's store job (this
// file reads store-target.mjs, so test-pg-files.mjs lists it).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { ended, learner, learningAt, made, started } from "./learn-support.mjs";
import { onPostgres } from "./store-target.mjs";
import { serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-5-5";
const CODE = "KESTREL-840583";
const CORRECTION = `Correction for every later run: the codeword for the learning walk is ${CODE}.`;
const ASK = "What is the codeword for the learning walk? If you do not know it, answer exactly: UNKNOWN.";
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n"));
const systemOf = ({ body }) => (typeof body.system === "string" ? body.system : textOf(body.system));
const corrects = ({ body }) => (body.messages ?? []).some((m) => m.role === "user" && textOf(m.content).includes(CORRECTION));
const SKIP = { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" };

/** One run of an agent that learns (compile_after 3, so neither run here compiles and the follow-up's round is a
 *  correction alone), the correction sent to it as a follow-up, then the agent's next run.
 *  `split`: each run a process of its own (the runner's held end-of-run step). `keyed`: the model behind a gateway, each
 *  start and message with a model key of its own and a spend cap. `unscanned`: every end's census left out (the launch
 *  reads "unscanned"). `revoked`: the follow-up's key refused from its answer until the next run starts with a new one,
 *  as a host that revokes a run's key when its turn ends. */
async function followUp(t, { split = false, keyed = false, unscanned = false, revoked = false } = {}) {
  const systems = [];
  let refusing = false;
  let refused = 0;
  const fake = await fakeAnthropic({
    reply: async (request) => {
      if (request.path !== "/v1/messages") return { text: "" };
      if (refusing) {
        refused += 1;
        return { error: { status: 401, type: "authentication_error", message: "the key was revoked" } };
      }
      systems.push(systemOf(request));
      if (revoked && corrects(request)) refusing = true;
      return { text: corrects(request) ? `The codeword is ${CODE}.` : "UNKNOWN" };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}`, ...(keyed ? { AGENT_MODEL_BASE_URL: fake.url } : {}) }, keyed ? ["AGENT_MODEL_STRONG"] : ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG"]);
  const { api, store } = await serve(t, { learning: "on", faux: undefined, ...(split ? { childRuns: {} } : {}), ...(unscanned ? { runnerTiming: { censusMs: 1 } } : {}) });
  const extra = keyed ? { max_cost_usd: 5, model_key: "fake-test-key-run" } : {};
  await made(api, learner("walk", { harness: "claude-agent", model: `anthropic/${MODEL}`, learning: { compile_after: 3 } }));

  const runId = await started(api, "walk", ASK, extra);
  await ended(api, runId);
  if (unscanned) assert.equal((await store.runs.launch(runId)).census, JSON.stringify("unscanned"), "the first end wrote no census");
  const sent = await api("POST", `/runs/${runId}/messages`, { content: CORRECTION, ...(keyed ? { model_key: "fake-test-key-message" } : {}) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const second = await ended(api, runId);
  assert.equal(second.view.status, "completed");
  assert.equal(second.view.learning?.state, "merged", `the follow-up's round merged${onPostgres ? " (Postgres)" : ""}: ${JSON.stringify(second.view.learning)}`);
  assert.equal((await learningAt(store, "walk")).text("corrections.md"), `- ${CORRECTION}\n`, "the correction is a line of corrections.md");
  if (revoked) assert.equal(refused, 0, "the correction's round asked no model after its answer: a key revoked then never touches its save");

  refusing = false;
  const asked = systems.length;
  const next = await started(api, "walk", ASK, extra);
  const { view } = await ended(api, next);
  const laid = systems.slice(asked);
  assert.ok(laid.length, "the next run asked its model");
  assert.ok(laid.every((system) => system.includes("# Learned") && system.includes(CODE)), `the next run's system prompt carries the correction under # Learned: ${JSON.stringify({ learning: view.learning, system: laid[0]?.slice(-600) })}`);
}

test("on claude-agent, a follow-up's correction is saved to corrections.md and the agent's next run is told it under # Learned", SKIP, (t) => followUp(t));

test("the same with each run in a process of its own, a spend cap and a model key on the start and the message", SKIP, (t) => followUp(t, { split: true, keyed: true }));

test("the same when each end's census is not made: every end writes \"unscanned\"", SKIP, (t) => followUp(t, { split: true, keyed: true, unscanned: true }));

test("the same when the follow-up's key is revoked once it answered, and the next run brings a new one", SKIP, (t) => followUp(t, { split: true, keyed: true, revoked: true }));
