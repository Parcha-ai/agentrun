// A pi run's system prompt through the dispatch is the one main's per-run process builds: the environment line first (as
// pi installs it, environment.ts EnvironmentLine), then the revision's instructions with its skills and what the agent
// learned folded in (skills.ts promptOf over learning.ts withLearned), then the effort guidance (effort-guidance.ts), each
// non-empty part in that order. The runner builds it from the launch and the revision, never from this process's
// environment: the effort is the launch's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

const { environmentLine } = await import("../dist/environment.js");
const { effortGuidance } = await import("../dist/effort-guidance.js");

test("the system prompt is the environment line, the revision's instructions, then the effort guidance (the launch's)", async (t) => {
  const { spec } = await specFor(t, { body: { instructions: "Follow the plan.", tools: ["web_search"] }, launch: { effort: "high" } });
  assert.deepEqual(spec.session.system, [environmentLine(), "Follow the plan.", effortGuidance("high")]);
});

test("with no effort the system prompt is the environment line and the instructions alone", async (t) => {
  const { spec } = await specFor(t, { body: { instructions: "Do it." } });
  assert.deepEqual(spec.session.system, [environmentLine(), "Do it."]);
});
