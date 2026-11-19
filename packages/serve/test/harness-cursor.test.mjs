// Cursor in serve's harness table (harness-table.ts): one entry, on the ACP adapter (cursorAdapter), its release the one
// `agentrun harness install cursor` puts in `<data>/harnesses/cursor` (harness-archive.ts: its launcher at
// ./dist-package/cursor-agent and every file beside it checked against the pin), on its owner's CURSOR_API_KEY, billed to
// the owner's Cursor plan (wire `plan`): no proxy, key, catalog or cap of ours is its.
//   - It is listed only while its pinned release is installed and verified, and its card says who bills it, what stops
//     it, that it edits no file and whose terms it runs under.
//   - Its key is handed to its runs alone (run-secrets.ts keysFor): no other harness's run gets CURSOR_API_KEY.
//   - Its model is `cursor/<model-id>` (`cursor/default`: Cursor's own), capped by the plan rule (planCapModel).
// The tests that need the pinned release read the folder holding its dist-package from AGENTRUN_TEST_CURSOR and skip,
// saying why, without it. No test here runs Cursor or holds a real key: the keys are fake.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, scratch, serve } from "./support.mjs";

const [{ harnessIds, harnessOf }, { harnessOffers }, { DATA_ENV }, { HarnessUnavailable, openRouterOnly, providerFor, viaOpenRouter }, { keysFor, RUN_SECRETS }, { cliCapModel }, { runKeyOf }] = await Promise.all([
  import("../dist/harness-table.js"), import("../dist/harness.js"), import("../dist/files.js"), import("../dist/provider.js"), import("../dist/run-secrets.js"), import("../dist/runner/cli-run-spec.js"), import("../dist/key-refusal.js"),
]);

const { CURSOR_PIN, cursorRelease } = await import("@parcha/agentrun-harness-acp");
/** Whether Cursor has a release pinned for this host (cursorRelease, the one test serve's lookup makes). CURSOR_PIN pins
 *  linux-x86_64 alone: on any other host (a Mac) Cursor is refused ACP_BINARY_UNPINNED before its install is looked at,
 *  and the tests here that look at one assert that refusal instead (refusedHere). */
const PINNED = cursorRelease() !== undefined;
const CURSOR = process.env.AGENTRUN_TEST_CURSOR;
const needsCursor = !PINNED ? `Cursor ${CURSOR_PIN.version} is pinned for ${Object.keys(CURSOR_PIN.archives).join(", ")} alone; here it is refused ACP_BINARY_UNPINNED`
  : CURSOR ? false : "AGENTRUN_TEST_CURSOR is not set: it names the folder holding Cursor 2026.11.13-eacade1's dist-package";
const BUILTINS = ["pi", "claude-agent", "codex", "opencode"];
const PROMISES = { resume: "load", tool_gate: "permission", billing: "plan" };
const KEY = "CURSOR_API_KEY";

/** A data directory, with Cursor's release at `<data>/harnesses/cursor` when `release` names one (linked to it). */
async function dataWith(t, release) {
  const data = join(await scratch(t), "agents");
  mkdirSync(join(data, "harnesses"), { recursive: true });
  if (release) symlinkSync(release, join(data, "harnesses", "cursor"));
  return data;
}

/** The environment the variables `vars` set, restored after the test. */
function withEnv(t, vars) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, vars);
}

/** Whether `text` refuses Cursor here as it must: where it is pinned for this host, by `code` (default
 *  HARNESS_NOT_INSTALLED: an install missing) and the command that installs it into `data`; where it is not, by
 *  ACP_BINARY_UNPINNED, which comes before any install is looked at. */
const refusedHere = (data, code = "HARNESS_NOT_INSTALLED") => (text) => (PINNED ? text.includes(code) && text.includes(`agentrun harness install cursor --data ${data}`) : text.includes("ACP_BINARY_UNPINNED"));

test("cursor is one entry of the table: Cursor, billed to its plan on its own key, its promises; listed only while its pinned release is installed", async (t) => {
  const data = await dataWith(t);
  const env = { [DATA_ENV]: data };
  const cursor = harnessOf(env, "cursor");
  assert.deepEqual([cursor?.id, cursor?.label, cursor?.steer, cursor?.promises, cursor?.facts?.wire, cursor?.facts?.ownModel], ["cursor", "Cursor", false, PROMISES, "plan", true]);
  assert.deepEqual(cursor.ownKeys, [KEY]);
  assert.equal(cursor.installs, undefined, "never installed on first use");
  assert.deepEqual([...harnessIds(env)], BUILTINS, "not installed: not listed");
  assert.ok(refusedHere(data)(cursor.hidden(env)), cursor.hidden(env));
  assert.deepEqual((await harnessOffers(env)).map((offer) => offer.id), BUILTINS, "nor offered");

  // A launcher that is not the pinned one is not installed either: refused by its digest, never run.
  mkdirSync(join(data, "harnesses", "cursor", "dist-package"), { recursive: true });
  writeFileSync(join(data, "harnesses", "cursor", "dist-package", "cursor-agent"), "#!/bin/sh\necho not cursor\n", { mode: 0o755 });
  const mismatched = { [DATA_ENV]: data };
  assert.deepEqual([...harnessIds(mismatched)], BUILTINS);
  assert.ok(refusedHere(data, "ACP_BINARY_MISMATCH")(cursor.hidden(mismatched)), cursor.hidden(mismatched));
});

test("its model is one Cursor lists, named cursor/<model-id>; none named is Cursor's own default; another vendor's is refused in words", async (t) => {
  const env = { [DATA_ENV]: await dataWith(t) };
  const cursor = harnessOf(env, "cursor");
  assert.deepEqual(await cursor.model(env, undefined, true), { model: { provider: "cursor", modelId: "default" } });
  assert.deepEqual(await cursor.model(env, "cursor/gpt-5.4-nano", true), { model: { provider: "cursor", modelId: "gpt-5.4-nano" } });
  assert.deepEqual(await cursor.model(env, "cursor/gpt-5.4-nano[reasoning=medium]", true), { model: { provider: "cursor", modelId: "gpt-5.4-nano[reasoning=medium]" } });
  for (const ref of ["anthropic/claude-sonnet-5-5", "openrouter/openai/gpt-6.1-sol", "cursor/", "cursor/two words"]) {
    const refused = await cursor.model(env, ref, true);
    assert.ok("why" in refused && refused.why.includes("cursor/<model-id>") && refused.why.includes(ref), JSON.stringify(refused));
  }
  assert.equal(await cursor.model(env, "cursor/gpt-5.4-nano", false), undefined, "its model is its own: none where it does not run");
  assert.equal(cursor.runs(env, "cursor/gpt-5.4-nano"), true);
  assert.equal(cursor.runs(env, "openai/gpt-6.1-sol"), false);
  assert.equal(cursor.onWire(env), true);
});

test("its wire is no route of ours: providerFor refuses it, OpenRouter never carries it, and no model key is its", async (t) => {
  const env = { [DATA_ENV]: await dataWith(t), OPENROUTER_API_KEY: "fake-test-key", ANTHROPIC_API_KEY: "fake-test-key", OPENAI_API_KEY: "fake-test-key" };
  assert.throws(() => providerFor("plan", env, { provider: "cursor", modelId: "gpt-5.4-nano" }, "cursor"), (error) => error instanceof HarnessUnavailable && /own plan/.test(error.message));
  assert.equal(openRouterOnly("plan", env), false);
  assert.equal(viaOpenRouter("plan", env, "openrouter//x"), false);
  assert.equal(runKeyOf(env, "cursor", "cursor/gpt-5.4-nano"), undefined);
});

test("CURSOR_API_KEY goes to a run of Cursor and to no run of any other harness", async (t) => {
  assert.ok(RUN_SECRETS.includes(KEY), "the launcher hands the server Cursor's key (its SECRETS line)");
  const env = { [DATA_ENV]: await dataWith(t) };
  const needs = (harness) => ({ harness, tools: [], decisionProviders: [] });
  assert.ok(keysFor(needs("cursor"), env).includes(KEY));
  for (const harness of [...BUILTINS, "goose"]) assert.ok(!keysFor(needs(harness), env).includes(KEY), `${harness} is not handed ${KEY}`);
});

test("a run of Cursor is capped by the plan rule: billed to the owner's plan, never priced here", async (t) => {
  const env = { [DATA_ENV]: await dataWith(t) };
  const capModel = await cliCapModel(harnessOf(env, "cursor"), env, "cursor/gpt-5.4-nano");
  assert.deepEqual([capModel.id, capModel.api, capModel.price, capModel.plan], ["gpt-5.4-nano", "plan", null, true]);
});

test("not installed, a run's adapter is refused naming the code and the command, and nothing is downloaded", async (t) => {
  const data = await dataWith(t);
  const env = { [DATA_ENV]: data, [KEY]: "fake-test-key" };
  const cursor = harnessOf(env, "cursor");
  const needs = { model: { provider: "cursor", modelId: "gpt-5.4-nano" }, models: { getModel: () => undefined } };
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => (fetched.push(String(args[0])), realFetch(...args));
  t.after(() => (globalThis.fetch = realFetch));
  // Where no release is pinned for this host, installing fixes nothing: the refusal names no fix.
  await assert.rejects(cursor.adapter(env, needs), (error) => error instanceof HarnessUnavailable && error.fix === (PINNED ? "install" : undefined) && refusedHere(data)(error.message));
  const refused = await cursor.refusal(env, needs, { atStart: false });
  assert.ok(refusedHere(data)(refused?.reason ?? ""), refused?.reason);
  assert.deepEqual(fetched, [], "nothing on a run's path downloads");
  assert.equal(existsSync(join(data, "harnesses", "cursor")), false, "nor installs");
});

test("a server whose data has no Cursor lists none, saves an agent on it with a warning, and refuses its run naming the code and the command", async (t) => {
  const { api, data } = await serve(t, { runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.harnesses.map((offer) => offer.id), BUILTINS);
  const saved = await api("POST", "/agents", agent("cursory", { harness: "cursor", model: "cursor/gpt-5.4-nano" }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.harness", "not_set_up_here"]]);
  assert.ok(refusedHere(data)(saved.body.warnings[0].message), saved.body.warnings[0].message);
  const run = await api("POST", "/agents/cursory/runs", { input: { content: "hi" } });
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal(run.body.error.code, "agent_not_runnable");
  assert.ok(refusedHere(data)(run.body.error.message), run.body.error.message);
});

test("on a host no release is pinned for (process.arch said arm64), Cursor is refused ACP_BINARY_UNPINNED before its install is looked at, listed or run", async (t) => {
  const { cursorHidden, cursorMissing } = await import("../dist/harness-cursor.js");
  const env = { [DATA_ENV]: await dataWith(t) };
  const arch = process.arch;
  const own = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { value: "arm64", configurable: true, enumerable: true });
  try {
    assert.match(cursorHidden(env) ?? "", /^ACP_BINARY_UNPINNED: Cursor \S+ has no release pinned for \S+-aarch64/);
    const found = await cursorMissing(env);
    assert.equal(found.missing?.code, "ACP_BINARY_UNPINNED", JSON.stringify(found));
  } finally {
    if (own) Object.defineProperty(process, "arch", own);
    else delete process.arch;
  }
  assert.equal(process.arch, arch, "process.arch is put back");
});

test("installed and verified with no key, Cursor is listed and refused for want of CURSOR_API_KEY; with one, it runs here", { skip: needsCursor, timeout: 120_000 }, async (t) => {
  const data = await dataWith(t, CURSOR);
  const bare = { [DATA_ENV]: data };
  assert.deepEqual([...harnessIds(bare)], [...BUILTINS, "cursor"]);
  const cursor = harnessOf(bare, "cursor");
  assert.equal(cursor.hidden(bare), undefined);
  const refused = await cursor.refusal(bare, undefined, { atStart: false });
  assert.ok(refused?.reason.includes(KEY), refused?.reason);
  assert.equal(refused.keys, undefined, "no model key of ours would run it");
  const keyed = { [DATA_ENV]: data, [KEY]: "fake-test-key" };
  assert.equal(await cursor.refusal(keyed, undefined, { atStart: false }), undefined);
  // The owner's limits, set wrong, are refused by name.
  const wrong = await cursor.refusal({ ...keyed, AGENTRUN_CURSOR_MAX_TURNS: "lots" }, undefined, { atStart: false });
  assert.match(wrong?.reason ?? "", /AGENTRUN_CURSOR_MAX_TURNS/);
});

test("installed and keyed, capabilities list Cursor with its label, its promises, its default and its card", { skip: needsCursor, timeout: 120_000 }, async (t) => {
  withEnv(t, { [KEY]: "fake-test-key", AGENTRUN_CURSOR_MAX_TURNS: "3", AGENTRUN_CURSOR_MAX_TOOL_CALLS: "7" });
  const data = await dataWith(t, CURSOR);
  const { api } = await serve(t, { runner: false, data, faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  const cursor = caps.harnesses.find((offer) => offer.id === "cursor");
  assert.deepEqual([cursor?.label, cursor?.promises, cursor?.available, cursor?.steer, cursor?.default_model], ["Cursor", PROMISES, true, false, "cursor/default"], JSON.stringify(cursor));
  assert.match(cursor.card, /runs Cursor's CLI on your Cursor API key, under Cursor's terms/);
  assert.match(cursor.card, /billed to your Cursor plan/);
  assert.match(cursor.card, /stops after 3 turns or 7 tool calls/);
  assert.match(cursor.card, /makes no file edits/);
  for (const offer of caps.harnesses.filter((each) => each.id !== "cursor")) assert.equal(offer.card, undefined, `${offer.id} has no card`);
});

test("Cursor's own calls (its shell: acp_execute) are asked first and refused where no one can approve, on a computer or not; never held to bash's allow", async (t) => {
  const { runGate } = await import("../dist/tool-gate.js");
  const dir = await scratch(t);
  const revision = { kind: "agentic", body: { harness: "cursor", tools: ["read", "bash"] } };
  const settings = () => ({ settings: { bash: { permission: "allow" } }, problems: [] });
  for (const computer of [false, true]) {
    // Cursor's shell runs where Cursor runs (the runner's host), never on the run's computer: bash's allow is not its.
    assert.equal(await runGate({ root: dir, work: dir, computer }, "run-1", revision, settings, true).decide("acp_execute", { title: "echo hi", kind: "execute" }), "ask", `computer ${computer}: asked`);
    const refused = await runGate({ root: dir, work: dir, computer }, "run-2", revision, settings, false).decide("acp_execute", { title: "echo hi", kind: "execute" });
    assert.ok(typeof refused === "object" && "deny" in refused, `computer ${computer}: refused where no one can approve`);
  }
});
