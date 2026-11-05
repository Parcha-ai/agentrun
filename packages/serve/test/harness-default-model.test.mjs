// The demo: capabilities name each harness's default model, as a save and a run resolve it (runnable.ts harnessModel),
// never a second copy of the rule. On a server with serve's gateway (AGENT_MODEL_BASE_URL) and Anthropic's endpoint
// both set, pi and codex run the gateway's default when a definition names none, and claude-agent never takes the
// gateway's model: it takes its own key's default (model.ts hostModel). A save agrees: a claude-agent agent naming no
// model saves with no warning on its model.
import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, scratch, serve } from "./support.mjs";

const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));

test("on a gateway server, codex shows the gateway's default model and claude-agent its own key's default; a save says the same", { timeout: 60_000 }, async (t) => {
  const anthropic = await fakeAnthropic({ reply: () => ({ text: "unused" }) });
  t.after(() => anthropic.close());
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  // No request leaves the test: capabilities and saves check the harnesses, they never call a model.
  Object.assign(process.env, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }),
    AGENT_MODEL_BASE_URL: "http://127.0.0.1:9",
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`,
    ANTHROPIC_BASE_URL: anthropic.url,
  });
  const { api } = await serve(t, { faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.harnesses.map((h) => [h.id, h.available, h.default_model]), [
    ["pi", true, "agent-model/gpt-test"],
    ["claude-agent", true, "anthropic/claude-sonnet-5-5"],
    ["codex", true, "agent-model/gpt-test"],
    ["opencode", true, "agent-model/gpt-test"],
  ]);
  assert.equal(caps.models.default, "agent-model/gpt-test", "pi's is the server's default");
  const claude = await api("POST", "/agents", agent("claude", { harness: "claude-agent" }));
  assert.equal(claude.status, 201, JSON.stringify(claude.body));
  assert.deepEqual((claude.body.warnings ?? []).filter((w) => w.field === "definition.model"), [], "it runs on its key's default");
  const codex = await api("POST", "/agents", agent("coder", { harness: "codex" }));
  assert.equal(codex.status, 201, JSON.stringify(codex.body));
  assert.deepEqual(codex.body.warnings ?? [], [], "it runs on the default capabilities name");
});

test("a harness this server does not run has no default model", async (t) => {
  const { api } = await serve(t);
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  for (const h of harnesses.filter((h) => !h.available)) assert.equal(h.default_model, null, h.id);
  assert.equal(harnesses.find((h) => h.id === "pi").default_model, "faux/faux-1");
});
