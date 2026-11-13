// A command whose delivery fails (the loop's command() rejects, or the refusal could not be written) is not skipped for
// the rest of the claim: the runner reads a row as delivered only once its delivery went through, so the next poll hands
// it on again (Greptile on #1969, runner.ts:192).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 40 };

test("a command whose loop.command() rejects once is handed on again at the next poll, not skipped", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const handed = [];
  let end;
  const createLoop = () => ({
    start: () => new Promise((resolve) => (end = () => resolve({ state: "ended" }))),
    command: async (row) => {
      handed.push(row.id);
      if (handed.length === 1) throw new Error("the loop was busy for a moment");
      return { refused: "seen" };
    },
    stop: async () => {},
  });
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(async () => {
    end?.();
    await runner.close();
  });
  await until(() => end !== undefined, "the loop runs");
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "once more" } });
  await until(() => handed.length >= 2, "the steer handed on again after a failed delivery", 2_000).catch(() => {});
  assert.deepEqual(handed.slice(0, 2), [steer.id, steer.id], "handed on again at the next poll");
});
