// The harnesses the runner's loop factory runs, by the launch's harness name (runner/adapters/index.ts): each gives its
// adapter for one claim from what the launch says (its model, its provider, its price, a private directory per session)
// and who keeps the run's visible record. pi keeps its own; a CLI's is the loop's (record: "loop").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { RUNNER_HARNESSES, resolveHarness } = await import("../dist/runner/adapters/index.js");

const dir = mkdtempSync(join(tmpdir(), "runner-harnesses-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const launch = (extra = {}) => ({
  run: { harness: {}, registry: { install() {} }, setModels() {} },
  model: "claude-sonnet-4-5",
  provider: { origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` },
  price: () => 0,
  sessionsDir: dir,
  ...extra,
});

test("runner harnesses: pi keeps its own record; claude-agent's is the loop's; an unknown harness has none", () => {
  assert.equal(resolveHarness("pi").record, undefined);
  assert.equal(resolveHarness("claude-agent").record, "loop");
  assert.equal(resolveHarness("no-such-harness"), undefined);
  assert.equal(resolveHarness("__proto__"), undefined, "a name is looked up as data, never through the prototype");
  assert.deepEqual(Object.keys(RUNNER_HARNESSES).sort(), ["claude-agent", "pi"]);
});

test("runner harnesses: each builds its adapter from the launch", async () => {
  assert.equal((await resolveHarness("pi").adapter(launch())).id, "pi");
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";
  try {
    // A stand-in CLI and a scripted SDK are a test's own options, passed on as given.
    const claude = await resolveHarness("claude-agent").adapter(launch(), { standIn: { command: process.execPath }, sdk: { query() {} } });
    assert.equal(claude.id, "claude-agent");
  } finally {
    delete process.env.AGENTRUN_CLAUDE_AGENT_STANDIN;
  }
});
