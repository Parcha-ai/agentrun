// Goose in serve's harness table (harness-table.ts): one entry, on the ACP adapter (gooseAdapter), its binary the one
// `agentrun harness install goose` puts in `<data>/harnesses/goose/goose` (harness-archive.ts), its model the host's
// Anthropic Messages provider, the origin and key claude-agent's proxy takes, priced by the same hooks.
//   - It is listed (capabilities, a save's harnesses, a tool's) only while its pinned binary is installed and verified.
//   - Not installed, an agent on it saves with a warning, and its run is refused: each names the code
//     (HARNESS_NOT_INSTALLED) and the command that installs it. Nothing on a run's path downloads anything.
// The tests that need the real Goose 1.59.2 binary read it from AGENTRUN_TEST_GOOSE and skip, saying why, without it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const [{ harnessIds, harnessOf }, { harnessOffers }, { DATA_ENV }, { HarnessUnavailable }] = await Promise.all([
  import("../dist/harness-table.js"), import("../dist/harness.js"), import("../dist/files.js"), import("../dist/provider.js"),
]);

const GOOSE = process.env.AGENTRUN_TEST_GOOSE;
const needsGoose = GOOSE ? false : "AGENTRUN_TEST_GOOSE is not set: it names the Goose 1.59.2 binary this test runs";
const BUILTINS = ["pi", "claude-agent", "codex", "opencode"];
const PROMISES = { resume: "load", tool_gate: "permission", billing: "proxy" };
const MODEL = "claude-sonnet-5-5";

/** A data directory, with Goose's binary at `<data>/harnesses/goose/goose` when `binary` names one (linked to it). */
async function dataWith(t, binary) {
  const data = join(await scratch(t), "agents");
  if (binary) {
    mkdirSync(join(data, "harnesses", "goose"), { recursive: true });
    symlinkSync(binary, join(data, "harnesses", "goose", "goose"));
  }
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

/** Says the code a missing Goose is refused with and the command that installs it into `data`. */
const namesInstall = (data) => (text) => /HARNESS_NOT_INSTALLED/.test(text) && text.includes(`agentrun harness install goose --data ${data}`);

test("goose is one entry of the table: Goose, on Anthropic's Messages, its promises; listed only while its pinned binary is installed", async (t) => {
  const data = await dataWith(t);
  const env = { [DATA_ENV]: data };
  const goose = harnessOf(env, "goose");
  assert.deepEqual([goose?.id, goose?.label, goose?.steer, goose?.promises, goose?.facts?.wire, goose?.facts?.id], ["goose", "Goose", false, PROMISES, "anthropic-messages", "goose"]);
  assert.equal(goose.installs, undefined, "never installed on first use");
  assert.deepEqual([...harnessIds(env)], BUILTINS, "not installed: not listed");
  assert.ok(namesInstall(data)(goose.hidden(env)), goose.hidden(env));
  assert.deepEqual((await harnessOffers(env)).map((offer) => offer.id), BUILTINS, "nor offered");

  // A binary that is not the pinned one is not installed either: refused by its digest, never run.
  mkdirSync(join(data, "harnesses", "goose"), { recursive: true });
  writeFileSync(join(data, "harnesses", "goose", "goose"), "#!/bin/sh\necho not goose\n", { mode: 0o755 });
  const mismatched = { [DATA_ENV]: data };
  assert.deepEqual([...harnessIds(mismatched)], BUILTINS);
  assert.match(goose.hidden(mismatched), /ACP_BINARY_MISMATCH/);
  assert.ok(goose.hidden(mismatched).includes(`agentrun harness install goose --data ${data}`), goose.hidden(mismatched));
});

test("on the default data directory the command names no --data", async (t) => {
  const home = await scratch(t);
  const env = { HOME: home, XDG_DATA_HOME: "" };
  const reason = harnessOf(env, "goose").hidden(env);
  assert.match(reason, /HARNESS_NOT_INSTALLED/);
  assert.match(reason, /agentrun harness install goose(?! --data)/);
});

test("a harness module may not name goose: a built-in harness", async (t) => {
  const { HARNESS_MODULES_ENV, harnessTable } = await import("../dist/harness-table.js");
  const path = join(await scratch(t), "goose.mjs");
  writeFileSync(path, "export const entries = () => ({ goose: { runs: () => false } });\n");
  assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), /goose.*built-in/);
});

test("not installed, a run's adapter is refused naming the code and the command, and nothing is downloaded", async (t) => {
  const data = await dataWith(t);
  const env = { [DATA_ENV]: data, ANTHROPIC_API_KEY: "fake-test-key" };
  const goose = harnessOf(env, "goose");
  const needs = { model: { provider: "anthropic", modelId: MODEL }, models: { getModel: () => undefined } };
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => (fetched.push(String(args[0])), realFetch(...args));
  t.after(() => (globalThis.fetch = realFetch));
  await assert.rejects(goose.adapter(env, needs), (error) => error instanceof HarnessUnavailable && error.fix === "install" && namesInstall(data)(error.message));
  const refused = await goose.refusal(env, needs, { atStart: false });
  assert.ok(namesInstall(data)(refused?.reason ?? ""), refused?.reason);
  assert.deepEqual(fetched, [], "nothing on a run's path downloads");
  assert.equal(existsSync(join(data, "harnesses", "goose")), false, "nor installs");
});

test("a server whose data has no Goose lists none, saves an agent on it with a warning, and refuses its run naming the code and the command", async (t) => {
  const { api, data } = await serve(t, { runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.harnesses.map((offer) => offer.id), BUILTINS);
  assert.ok(!caps.features.mcp_client.harnesses.includes("goose"));
  const saved = await api("POST", "/agents", agent("gosling", { harness: "goose" }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.harness", "not_set_up_here"]]);
  assert.ok(namesInstall(data)(saved.body.warnings[0].message), saved.body.warnings[0].message);
  const run = await api("POST", "/agents/gosling/runs", { input: { content: "hi" } });
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal(run.body.error.code, "agent_not_runnable");
  assert.ok(namesInstall(data)(run.body.error.message), run.body.error.message);
});

test("installed and verified, capabilities list Goose with its label and its three promises", { skip: needsGoose, timeout: 60_000 }, async (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", AGENT_MODEL: `anthropic/${MODEL}` });
  const data = await dataWith(t, GOOSE);
  assert.deepEqual([...harnessIds({ [DATA_ENV]: data })], [...BUILTINS, "goose"]);
  assert.equal(harnessOf({ [DATA_ENV]: data }, "goose").hidden({ [DATA_ENV]: data }), undefined);
  const { api } = await serve(t, { runner: false, data, faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  const goose = caps.harnesses.find((offer) => offer.id === "goose");
  assert.deepEqual([goose?.label, goose?.promises, goose?.available, goose?.steer, goose?.default_model], ["Goose", PROMISES, true, false, `anthropic/${MODEL}`], JSON.stringify(goose));
  assert.ok(goose.models.every((id) => id.startsWith("anthropic/")), `Anthropic's models alone: ${goose.models.join(", ")}`);
  assert.ok(caps.features.mcp_client.harnesses.includes("goose"));
});

test("a run on the real Goose through serve's runner: its model's requests reach the fake origin with the host's key and the native id, each booked once", { skip: needsGoose || (!existsSync("/usr/bin/setpriv") && "no setpriv here"), timeout: 180_000 }, async (t) => {
  const { fakeAnthropic } = await import(new URL("../../run-adapters-acp/test/fake-anthropic.mjs", import.meta.url).href);
  const fake = await fakeAnthropic();
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` });
  const data = await dataWith(t, GOOSE);
  const { api } = await serve(t, { data, faux: undefined });
  assert.equal((await api("POST", "/agents", agent("gosling", { harness: "goose", model: `anthropic/${MODEL}` }))).status, 201);
  const run = await api("POST", "/agents/gosling/runs", { input: { content: "SAY GOOSE_RAN" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 150_000 });
  const asked = fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
  assert.ok(asked.length >= 1, "Goose's model was asked");
  assert.ok(asked.every((r) => r.headers["x-api-key"] === "fake-test-key" && r.body.model === MODEL), "the host's key, the native id");
  assert.deepEqual(fake.requests.filter((r) => r.path !== "/v1/messages").map((r) => `${r.method} ${r.path}`), [], "no other request reached the origin");
  assert.ok(rows.some((r) => r.kind === "message" && /GOOSE_RAN/.test(JSON.stringify(r))), "the run's answer is the model's");
  assert.equal(rows.findLast((r) => r.kind === "usage")?.usage?.requests, asked.length, "each request booked once");
});
