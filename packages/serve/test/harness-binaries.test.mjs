// Each harness's binary is checked against its pins (its sha256, then its --version) once per binary per process: the
// start's probe of the harnesses, then a save and a run check of a codex revision, share one check of codex's binary and
// one of claude-agent's. Counted at the one call every check makes, `<binary> --version`: Node's own execFileSync,
// wrapped here (syncBuiltinESMExports carries the wrap to every module's named import of it).
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";

test("the start's probe of the harnesses, a save and a run check of a codex revision check each harness's binary once", { timeout: 120_000 }, async (t) => {
  // A gateway's model for codex (nothing is sent to it) and an Anthropic key for claude-agent: no real key.
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, ["AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "OPENAI_API_KEY", "CODEX_BIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE", "MONID_API_KEY"]);
  const asked = new Map();
  const real = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, ...rest) {
    if (Array.isArray(args) && args[0] === "--version" && ["codex", "claude"].includes(basename(String(file)))) asked.set(basename(String(file)), (asked.get(basename(String(file))) ?? 0) + 1);
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = real;
    syncBuiltinESMExports();
  });
  const { api } = await serve(t, { faux: undefined });
  const offers = (await api("GET", "/capabilities")).body.harnesses;
  const codex = offers.find((offer) => offer.id === "codex");
  if (!codex.available) return t.skip(`codex does not run here: ${codex.reason}`);
  // A save checks the revision's model on codex; its run is refused after the same check, for a tool this server lacks.
  const saved = await api("POST", "/agents", agent("coder", { harness: "codex", tools: ["monid.run"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", "/agents/coder/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error?.code, run.body.error?.details?.missing], [409, "agent_not_runnable", { "monid.run": ["MONID_API_KEY"] }]);
  const claude = offers.find((offer) => offer.id === "claude-agent");
  assert.deepEqual(Object.fromEntries(asked), { codex: 1, ...(claude.available || asked.has("claude") ? { claude: 1 } : {}) }, `each binary checked once (${JSON.stringify(offers.map((offer) => [offer.id, offer.available, offer.reason ?? null]))})`);
});
