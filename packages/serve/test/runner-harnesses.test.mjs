// The harnesses the runner's loop factory runs, by the launch's harness name (runner/adapters/index.ts): each gives its
// adapter for one claim from what the launch says (its model, its provider, its price, a private directory per session)
// and who keeps the run's visible record. pi keeps its own; a CLI's is the loop's (record: "loop").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { RUNNER_HARNESSES, resolveHarness } = await import("../dist/runner/adapters/index.js");
// The one table-run runner: a harness module's entry's, and Goose's and Cursor's.
const { ON_TABLE } = await import("../dist/harness-table.js");
const { heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");

const dir = mkdtempSync(join(tmpdir(), "runner-harnesses-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const launch = (extra = {}) => ({
  run: { harness: {}, registry: { install() {} }, setModels() {} },
  model: "claude-sonnet-5-5",
  provider: { origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` },
  price: () => 0,
  sessionsDir: dir,
  ...extra,
});

test("runner harnesses: pi keeps its own record; each CLI's (claude-agent, codex, opencode, goose, cursor) is the loop's; an unknown harness has none", () => {
  assert.equal(resolveHarness("pi").record, undefined);
  assert.equal(resolveHarness("claude-agent").record, "loop");
  assert.equal(resolveHarness("codex").record, "loop");
  assert.equal(resolveHarness("opencode").record, "loop");
  // Goose and Cursor run from their table entries (facts and adapter): one shared runner, whose adapter is never asked.
  assert.equal(resolveHarness("goose"), ON_TABLE);
  assert.equal(resolveHarness("cursor"), ON_TABLE);
  assert.equal(ON_TABLE.record, "loop");
  assert.equal(resolveHarness("no-such-harness"), undefined);
  assert.equal(resolveHarness("__proto__"), undefined, "a name is looked up as data, never through the prototype");
  // The runner's static table: the built-ins whose runner adapter builds their run.
  assert.deepEqual(Object.keys(RUNNER_HARNESSES).sort(), ["claude-agent", "codex", "opencode", "pi"]);
});

test("runner harnesses: the shared runner of a table-run entry refuses to build an adapter, in words", async () => {
  await assert.rejects(ON_TABLE.adapter(launch()), /runs from its table entry/);
});

test("runner harnesses: each builds its adapter from the launch", async () => {
  // pi's redactor is its own option, as the run's spec gives it (adapter-run-spec.ts: run.redact, the runner's held one).
  assert.equal((await resolveHarness("pi").adapter(launch(), { redact: heldRedactor(secretRedactor([])) })).id, "pi");
  await assert.rejects(async () => resolveHarness("pi").adapter(launch()), /was given no redactor that holds keys/, "pi given no redactor builds no adapter");
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";
  try {
    // A stand-in CLI and a scripted SDK are a test's own options, passed on as given.
    const claude = await resolveHarness("claude-agent").adapter(launch(), { standIn: { command: process.execPath }, sdk: { query() {} } });
    assert.equal(claude.id, "claude-agent");
  } finally {
    delete process.env.AGENTRUN_CLAUDE_AGENT_STANDIN;
  }
  // A stand-in app-server is a test's own option too: no Codex binary is looked for.
  const codex = await resolveHarness("codex").adapter(launch({ model: "gpt-test" }), { standIn: { command: process.execPath } });
  assert.equal(codex.id, "codex");
  process.env.AGENTRUN_OPENCODE_STANDIN = "1";
  try {
    // OpenCode's stand-in for `opencode serve` is a test's own option, passed on as given.
    const opencode = await resolveHarness("opencode").adapter({ ...launch(), model: "gpt-test" }, { standIn: { command: process.execPath } });
    assert.equal(opencode.id, "opencode");
  } finally {
    delete process.env.AGENTRUN_OPENCODE_STANDIN;
  }
});

test("runner harnesses: OpenCode's facts say it never reruns a call it started, takes no steer mid-turn, and ends its turn at a cut answer", async () => {
  const { facts } = await import("../dist/harness-opencode/facts.js");
  assert.equal(facts.rerunsStarted, false);
  assert.equal(facts.steer, false);
  assert.equal(facts.recoversCutAnswers, 0, "an answer cut at the output limit ends OpenCode's turn, as pi's does");
});
