// One harness table (harness-table.ts): a harness is one entry, and everything that lists harnesses reads the table, so
// an entry a server's harness modules add (the owner's `harnessModules`, AGENTRUN_HARNESS_MODULES) shows up in
// capabilities, a save's check and the runner, never in a list of names kept elsewhere. A module adds a harness and never
// replaces a built-in one: claude-agent's id, label and facts stay its package's (grep pins it).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { agent, scratch, serve } from "./support.mjs";

const NATIVE = { resume: "exact", tool_gate: "every_call", billing: "proxy" };

/** A harness module adding `acme`: a whole entry of its own, which runs nothing here (its refusal says why), and its runner. */
function acmeModule(dir, extra = "") {
  const path = join(dir, "acme-harness.mjs");
  writeFileSync(path, `export const entries = () => ({ acme: {
  label: "Acme", steer: false, runMib: 64, oneAlwaysFits: false,
  promises: { resume: "restart", tool_gate: "permission", billing: "plan" },
  runs: () => true, onWire: () => true, model: async () => undefined, priceModel: (_env, model) => model,
  refusal: async () => ({ reason: "Acme stands in here: nothing runs it." }),
  runner: { record: "loop", adapter: async () => { throw new Error("acme's adapter is the module's"); } },
  ${extra}
} });\n`);
  return path;
}

test("the built-in table is the one list: HARNESSES and ADAPTER_FACTS are its ids and its entries' facts, in its order", async (t) => {
  const [{ HARNESSES }, { ADAPTER_FACTS }, { factsOf, harnessIds, harnessTable }] = await Promise.all([import("../dist/harness.js"), import("../dist/adapter-facts.js"), import("../dist/harness-table.js")]);
  // A data directory with no Goose or Cursor installed: both are in the table, and not listed (harness-goose.test.mjs,
  // harness-cursor.test.mjs).
  const env = { AGENTRUN_SERVE_DATA: await scratch(t) };
  assert.deepEqual([...harnessIds(env)], ["pi", "claude-agent", "codex", "opencode"]);
  assert.deepEqual([...HARNESSES], [...harnessIds(env)], "HARNESSES is the built-in table's ids, listed wherever the table is");
  assert.deepEqual(Object.keys(harnessTable(env)), [...HARNESSES, "goose", "cursor"], "and goose and cursor after them, each listed once it is installed");
  assert.deepEqual([...ADAPTER_FACTS], HARNESSES.flatMap((id) => (harnessTable(env)[id].facts ? [harnessTable(env)[id].facts] : [])), "ADAPTER_FACTS is their entries' facts");
  for (const entry of Object.values(harnessTable(env))) assert.equal(factsOf(env, entry.id), entry.facts, `${entry.id}'s facts, by its id, are its entry's`);
});

test("guard: claude-agent keeps its id, label and its package's facts, and a harness module that names it, or any built-in, is refused by name", async (t) => {
  const [{ facts: claudeFacts }, { HARNESS_MODULES_ENV, harnessOf, harnessTable }] = await Promise.all([import("@parcha/agentrun-harness-claude/facts"), import("../dist/harness-table.js")]);
  assert.equal(HARNESS_MODULES_ENV, "AGENTRUN_HARNESS_MODULES");
  const claude = harnessOf({}, "claude-agent");
  assert.deepEqual([claude.id, claude.label, claude.facts], ["claude-agent", "Claude", claudeFacts]);
  assert.equal(claudeFacts.id, "claude-agent");
  const dir = await scratch(t);
  for (const id of ["claude-agent", "pi", "codex", "opencode"]) {
    const path = join(dir, `${id}.mjs`);
    writeFileSync(path, `export const entries = () => ({ ${JSON.stringify(id)}: { runs: () => false } });\n`);
    assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), new RegExp(`${id}.*built-in`), id);
  }
});

test("a harness module adds a harness as one entry, outside a test runner too: the table, its label and promises, a save's check and the runner read it", async (t) => {
  const [{ HARNESS_MODULES_ENV, harnessIds, harnessOf }, { harnessOffers }, { definitionIssues }, { resolveHarness, RUNNER_HARNESSES }] = await Promise.all([
    import("../dist/harness-table.js"), import("../dist/harness.js"), import("../dist/validate.js"), import("../dist/runner/adapters/index.js"),
  ]);
  const dir = await scratch(t);
  // No NODE_TEST_CONTEXT in the environment given: the modules list loads where the test table never would.
  const env = { [HARNESS_MODULES_ENV]: JSON.stringify([acmeModule(dir)]) };
  assert.deepEqual([...harnessIds(env)], ["pi", "claude-agent", "codex", "opencode", "acme"], "built-ins first, then the module's");
  assert.equal(harnessOf(env, "claude-agent"), harnessOf({}, "claude-agent"), "the built-ins are untouched");
  assert.equal(harnessOf(env, "acme").id, "acme");

  const offers = await harnessOffers(env);
  const acme = offers.find((offer) => offer.id === "acme");
  assert.deepEqual([acme?.label, acme?.available, acme?.reason, acme?.promises], ["Acme", false, "Acme stands in here: nothing runs it.", { resume: "restart", tool_gate: "permission", billing: "plan" }]);
  assert.deepEqual(offers.filter((offer) => offer.id !== "acme").map((offer) => [offer.id, offer.label, offer.promises]), [["pi", "Pi", NATIVE], ["claude-agent", "Claude", NATIVE], ["codex", "Codex", NATIVE], ["opencode", "OpenCode", NATIVE]]);

  const named = { version: 1, name: "a", instructions: "Answer.", skills: [], tools: [], harness: "acme" };
  assert.deepEqual(definitionIssues(named, { harnesses: harnessIds(env) }), [], "a save on this server takes the id");
  assert.deepEqual(definitionIssues(named).map((issue) => [issue.field, issue.reason]), [["definition.harness", "not_an_option"]], "one the table has not is still refused");

  assert.equal(resolveHarness("acme", env).record, "loop", "the module's runner");
  assert.equal(resolveHarness("acme", {}), undefined, "a server without the module runs none");
  assert.equal(resolveHarness("codex", env), RUNNER_HARNESSES.codex, "a built-in's runner is its own");
  assert.equal(resolveHarness("codex", {}), RUNNER_HARNESSES.codex);
});

test("a harness module's new entry is whole: one missing a member the table reads is refused, naming the module, the id and the members", async (t) => {
  const { HARNESS_MODULES_ENV, harnessTable } = await import("../dist/harness-table.js");
  const dir = await scratch(t);
  const path = join(dir, "half.mjs");
  writeFileSync(path, "export const entries = () => ({ half: { label: \"Half\", steer: false } });\n");
  assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), (error) => /half\.mjs/.test(error.message) && /\bhalf\b/.test(error.message) && /runMib/.test(error.message) && /refusal/.test(error.message));
});

test("the modules list is the server's to set, from its harnessModules option alone: an operator's environment never loads one", async () => {
  const [{ HARNESS_MODULES_ENV }, { withoutFaux }, { besideRunEnv }] = await Promise.all([import("../dist/harness-table.js"), import("../dist/model.js"), import("../dist/runner/main.js")]);
  assert.deepEqual(Object.keys(withoutFaux({ [HARNESS_MODULES_ENV]: "[]", KEEP: "1" })), ["KEEP"]);
  assert.deepEqual(Object.keys(besideRunEnv({ [HARNESS_MODULES_ENV]: "[]", KEEP: "1" }, {})).filter((name) => name === HARNESS_MODULES_ENV), []);
});

test("a server started with harnessModules lists the module's harness in capabilities, and a revision naming it saves with the not-runnable warning", async (t) => {
  const dir = await scratch(t);
  const { api } = await serve(t, { harnessModules: [acmeModule(dir)], runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  const acme = caps.harnesses.find((offer) => offer.id === "acme");
  assert.deepEqual([acme?.label, acme?.available, acme?.promises?.billing], ["Acme", false, "plan"], JSON.stringify(caps.harnesses.map((offer) => offer.id)));
  assert.equal(caps.harnesses.find((offer) => offer.id === "claude-agent")?.label, "Claude");
  const saved = await api("POST", "/agents", agent("acme-agent", { harness: "acme" }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings, [{ field: "definition.harness", reason: "not_set_up_here", message: "Acme stands in here: nothing runs it." }], "saved, warned with the harness's own reason");
});
