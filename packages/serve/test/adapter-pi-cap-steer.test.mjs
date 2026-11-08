// pi through the adapter under the host's check: a person's steer that comes while the model is answering lets that
// answer finish, then reaches the model in the next request, and that steered request is admitted through the host's
// check (beforeRequest) like any other: asked twice, admitted twice, the first answer stored before the steer's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
// A lease no stall of a loaded machine outlasts: a claim lost mid-request would be retaken and the request asked again,
// which these money checks do not read. The runs end themselves, so nothing here waits on the lease.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const STEER = "and keep it short";
after(closeOpenSessions);

test("pi through the adapter: a steer mid-answer lets the answer finish, and the steered request is admitted through the host's check", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  // The first answer is held until the steer is sent, so the steer arrives while the model is answering.
  let answering = () => {};
  const midAnswer = new Promise((resolve) => (answering = resolve));
  let letFinish = () => {};
  const finish = new Promise((resolve) => (letFinish = resolve));
  const origin = scriptedOrigin([{ say: "first answer" }, { sayLastSteer: true }]);
  let requests = 0;
  const fetch = async (url, init) => {
    requests += 1;
    if (requests === 1) {
      answering();
      await finish;
    }
    return origin(url, init);
  };
  const asked = [];
  const beforeRequest = async (request) => {
    asked.push(request.turn);
    return undefined;
  };
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet }, { fetch });
  const createLoop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), beforeRequest }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await midAnswer;
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: STEER } });
  // The steer is placed (its row taken) while the first answer is still out.
  await until(async () => (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id)?.takenAt !== null, "the steer placed mid-answer");
  letFinish();
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended", 15_000);
  assert.equal(requests, 2, "the answer finished, then one request carried the steer");
  assert.equal(asked.length, 2, `the host's check was asked for both requests: ${JSON.stringify(asked)}`);
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const texts = messagesOf({ entries, tasks: [] }).map((message) => `${message.role}:${message.text}`);
  const first = texts.indexOf("model:first answer");
  const steered = texts.findIndex((text) => text.endsWith(STEER) && !text.startsWith("model:"));
  assert.ok(first >= 0 && steered > first, `the first answer is stored before the steer: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes(`model:${STEER}`), `the steered request was answered: ${JSON.stringify(texts)}`);
});
