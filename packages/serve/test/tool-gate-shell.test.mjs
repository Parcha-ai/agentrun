// The background tools (background.ts) run commands in the run's box as bash does, so bash's permission holds them:
// each maps to bash's settings key (tool-gate.ts settingsKeyOf), on every harness and under claude-agent's
// mcp__hands__ names; bash: deny refuses each of them, saying it follows bash's setting; bash: ask parks one under its
// own name (an approval runs it, never bash); bash: allow runs it; and capabilities and an agent's tools show bash's permission for each of the five, so
// what the console shows is what the gate enforces. None of them is a settings key of its own.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_TOOLS } from "../dist/background.js";
import { RunGate, settingsKeyOf, waitingText } from "../dist/tool-gate.js";
import { settingsIssues } from "../dist/tool-plane.js";
import { agent, scratch, serve } from "./support.mjs";

/** pi's registration `name`, wrapped by a run's gate on `data`'s settings: what its call answers, whether it ran, and
 *  the requests the gate kept. */
async function onPi(t, settings, name) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  if (settings) await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const runGate = new RunGate({ root, work, data, runId: "r1", harness: "pi" });
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { content: [{ type: "text", text: "ran" }] }) };
  const wrapped = runGate.extension([registration]).wraps.find((wrap) => wrap.tool === name)?.wrap(registration) ?? registration;
  const kept = [];
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const result = await wrapped.execute({ command: "sleep 1" }, api, {});
  return { text: (result.content ?? result.output ?? []).map((block) => block.text ?? "").join(""), isError: result.isError === true, ran, kept };
}

test("each background tool is held to bash's settings key, on every harness and as claude-agent's mcp__hands__ host tool, and is no settings key of its own", () => {
  assert.equal(BACKGROUND_TOOLS.length, 5);
  for (const name of BACKGROUND_TOOLS) {
    for (const harness of ["pi", "claude-agent", "codex", "opencode"]) assert.equal(settingsKeyOf(harness, name), "bash", `${harness} ${name}`);
    assert.equal(settingsKeyOf("claude-agent", `mcp__hands__${name}`), "bash", `mcp__hands__${name}`);
    assert.deepEqual(settingsIssues({ [name]: { permission: "deny" } }).map((issue) => [issue.field, issue.reason]), [[name, "not_allowed"]], `${name} is set by bash`);
  }
});

test("bash: deny refuses each background tool, saying it follows bash's setting; bash: ask parks bash_background under its own name; bash: allow runs it", async (t) => {
  for (const name of BACKGROUND_TOOLS) {
    const denied = await onPi(t, { bash: { permission: "deny" } }, name);
    assert.deepEqual([denied.text, denied.isError, denied.ran], [`Permission denied: ${name} follows bash's setting, which is deny on this server. Don't retry it.`, true, 0], name);
  }
  const asked = await onPi(t, { bash: { permission: "ask" } }, "bash_background");
  // Its request keeps its own name, so the call an approval runs is bash_background's, never bash's.
  assert.deepEqual([asked.text, asked.ran, asked.kept.map((entry) => entry.data?.tool)], [waitingText("bash_background"), 0, ["bash_background"]]);
  const allowed = await onPi(t, { bash: { permission: "allow" } }, "bash_background");
  assert.deepEqual([allowed.text, allowed.ran], ["ran", 1]);
});

test("with bash: ask, capabilities and an agent's tools show ask for bash and each background tool, with bash's choices", async (t) => {
  const { api } = await serve(t);
  const byName = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal((await api("PUT", "/settings/tools", { bash: { permission: "ask" } })).status, 200);
  const caps = byName((await api("GET", "/capabilities")).body.tools);
  for (const name of ["bash", ...BACKGROUND_TOOLS]) assert.deepEqual([caps[name].permission, caps[name].permissions], ["ask", caps.bash.permissions], `capabilities ${name}`);
  assert.ok(caps.bash.permissions.includes("ask"));
  const made = await api("POST", "/agents", agent("boxed", { place: { mode: "sandbox", box: "docker" }, tools: ["bash", ...BACKGROUND_TOOLS], tool_settings: { bash: { permission: "deny" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const own = byName((await api("GET", "/agents/boxed")).body.tools);
  for (const name of ["bash", ...BACKGROUND_TOOLS]) assert.deepEqual([own[name]?.permission, own[name]?.permission_from], ["deny", "agent"], `agent ${name}`);
});
