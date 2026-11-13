// A stand-in harness (a test's fake OpenCode, Codex app-server or Claude CLI) runs only under a test runner: node --test's
// NODE_TEST_CONTEXT, never NODE_ENV=test alone, which a production server can carry.
import assert from "node:assert/strict";
import { test } from "node:test";

/** `fn` with NODE_ENV=test and no test runner in this process's environment, then both put back. */
async function noRunner(extra, fn) {
  const saved = { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, NODE_ENV: process.env.NODE_ENV, ...Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]])) };
  delete process.env.NODE_TEST_CONTEXT;
  Object.assign(process.env, { NODE_ENV: "test" }, extra);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("NODE_ENV=test without a test runner leaves OpenCode's stand-in off", async () => {
  const { openCodeAdapter } = await import("../dist/harness-opencode/adapter.js");
  await noRunner({ AGENTRUN_OPENCODE_STANDIN: "1" }, () => assert.throws(() => openCodeAdapter({ standIn: { command: process.execPath } }), /runs only under a test runner/));
});

test("NODE_ENV=test without a test runner leaves Codex's stand-in app-server off", async () => {
  const { codexHarness } = await import(new URL("../../run-adapters-codex/dist/harness.js", import.meta.url).href);
  await noRunner({ AGENTRUN_CODEX_STANDIN: "1" }, () => assert.throws(() => codexHarness({ test: { command: process.execPath } }), /runs only under a test runner/));
});

test("NODE_ENV=test without a test runner leaves the Claude CLI's stand-in off", async () => {
  const { claudeAgentAdapter } = await import("@parcha/agentrun-harness-claude");
  await noRunner({ AGENTRUN_CLAUDE_AGENT_STANDIN: "1" }, () => assert.throws(() => claudeAgentAdapter({ provider: { headers: {} }, standIn: { command: process.execPath } }), /stand-in CLI is for tests only/));
});
