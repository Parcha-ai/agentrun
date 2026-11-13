// The tool table's decisions, pinned name by name: what each name is permitted, defaulted, keyed, shown and run as, for
// the table's names, the run's other known names, and names nothing registers. The names are kept in one table
// (tool-list.ts); this holds what they decide to the fixture, so folding or changing the table shows as a diff here. A
// name nothing registers keeps today's answers: allow by default unless it is a catalog tool, ask-or-deny only, and
// held to no key. Refresh the fixture only for a change meant to move a decision: PIN_WRITE=1 node --test <this file>.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { hostToolOf } from "../dist/host-tools.js";
import { openapiDocument } from "../dist/openapi.js";
import { agentTools, permissionsOf, serverGate, settingsIssues } from "../dist/tool-plane.js";
import { defaultPermission, permissionOf, settingsKeyOf } from "../dist/tool-gate.js";
import { toolsView } from "../dist/tools.js";

const FIXTURE = new URL("./fixtures/tool-table-pin.json", import.meta.url);
const NAMES = [
  "read", "write", "edit", "bash", "ask_person", "web_fetch", "web_search", "browser", "subagent", "pdf_pages", "llm",
  "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list", "learned_workflow",
  "monid.discover", "monid.inspect", "monid.run", "monid.other", "desktop", "phone", "jev", "parallel", "openrouter",
  "mcp:linear/create_issue", "mcp:linear/*", "monid_run", "mcp__hands__read", "read_skill_file", "codemode",
  "frobnicate", "toString", "constructor", "",
];
// A name nothing registers must never reach a host tool by the prototype chain, so hostToolOf is pinned without it.
const HOSTED = NAMES.filter((name) => name !== "constructor" && name !== "toString");
const REG = { name: "x", description: "x", parameters: {} };
const ENVS = { none: {}, keyed: { PARALLEL_API_KEY: "p", MONID_API_KEY: "m", BROWSERBASE_API_KEY: "b", BROWSERBASE_PROJECT_ID: "j" } };
const SETTINGS = { none: {}, set: { web_search: { provider: "parallel" }, read: { permission: "ask" }, bash: { permission: "deny" }, "mcp:linear/create_issue": { permission: "allow" } } };

// The views are held as the hash of their JSON: byte for byte, not one field.
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const issues = (name) => settingsIssues({ [name]: { permission: "ask" } }).map((issue) => `${issue.reason}`);
const snapshot = () => {
  const out = { names: {}, views: {}, agents: {} };
  for (const name of NAMES) {
    out.names[name] = {
      permissions: [...permissionsOf(name)],
      default: [defaultPermission(name), defaultPermission(name, { computer: false })],
      in_force: [permissionOf(name, {}), permissionOf(name, SETTINGS.set), permissionOf(name, {}, {}, "never")],
      gate: serverGate(name, SETTINGS.set),
      key: ["pi", "codex", "claude-agent", "opencode"].map((harness) => settingsKeyOf(harness, name) ?? null),
      setting_refused: issues(name),
    };
  }
  for (const name of HOSTED) out.names[name].replay = hostToolOf(name, REG, {})?.replay ?? null;
  for (const [envName, env] of Object.entries(ENVS)) for (const [setName, settings] of Object.entries(SETTINGS)) {
    out.views[`${envName}/${setName}`] = sha(toolsView(env, settings));
    for (const harness of ["pi", "codex", "claude-agent", "opencode"]) {
      out.agents[`${envName}/${setName}/${harness}`] = sha(agentTools(env, settings, { harness, tools: NAMES.filter(Boolean) }, NAMES));
    }
  }
  // The settings keys the API names (its tool-settings schemas' property names), not the whole document: other changes
  // move that.
  const enums = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const entry of node.propertyNames?.anyOf ?? []) if (Array.isArray(entry.enum)) enums.push(entry.enum);
    Object.values(node).forEach(walk);
  };
  walk(openapiDocument(() => undefined));
  out.openapi_tool_keys = enums;
  return JSON.parse(JSON.stringify(out));
};

test("the tool table decides each name as the fixture says, and the capabilities and agent-tools views are unchanged", () => {
  const now = snapshot();
  if (process.env.PIN_WRITE === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
  assert.deepEqual(now, JSON.parse(readFileSync(FIXTURE, "utf8")));
});

test("a name nothing registers is allowed by default, asks nothing of the owner, and is held to no key", () => {
  assert.equal(defaultPermission("frobnicate"), "allow");
  assert.deepEqual([...permissionsOf("frobnicate")], ["allow", "deny"]);
  assert.equal(settingsKeyOf("pi", "frobnicate"), undefined);
  assert.deepEqual(issues("frobnicate"), ["not_allowed"]);
});
