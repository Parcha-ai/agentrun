// A template's keys pin (tool-gate.ts pinRefusal, `{keys: [...]}`): an mcp entry may fence an object argument to the
// keys a parameter names, so an apply under approvals never writes the one CRM field its owner chose and nothing else.
// Its keys fill from the apply's parameters as a pin's text does; one that fills empty denies the tool, as an empty
// scalar pin does, and a malformed one is refused when the package is read.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pinRefusal } from "../dist/tool-gate.js";
import { compiled, filledPins, PackageError, readPackage } from "../dist/templates.js";
import { scratch } from "./support.mjs";

const UPDATE = "mcp:hubspot/HUBSPOT_UPDATE_CONTACT";
/** A package's MCP needs served by a saved server named as its toolkit, as an apply maps them. */
const served = (p) => p.mcp.map((need) => ({ ...need, server: need.toolkit }));

/** The package of one CRM write whose `mcp` entry's pin is `pin` (YAML), read: `{p}`, or `{problems}` when it does not read. */
async function scorer(t, pin) {
  const dir = join(await scratch(t), "scorer");
  mkdirSync(dir);
  writeFileSync(join(dir, "agent.md"), `---\nname: scorer\nversion: 1.0.0\ndescription: Writes one CRM field.\nparameters:\n  crm_score_property: { type: string, description: the contact property the score goes in }\n  more_properties: { type: array, items: { type: string, minLength: 1 }, description: other properties it may write }\nmcp:\n  - source: composio\n    toolkit: hubspot\n    tools: [HUBSPOT_UPDATE_CONTACT]\n    allow: [HUBSPOT_UPDATE_CONTACT]\n    pin: ${pin}\napprovals: never\n---\nScore the lead.\n`);
  try {
    return { p: readPackage(dir), problems: [] };
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return { problems: error.problems };
  }
}

test("a template's keys pin fills from a parameter: apply writes it filled, the gate holds a call to that key; an empty parameter denies the tool", async (t) => {
  const { p } = await scorer(t, '{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: ["${parameters.crm_score_property}"] } } }');
  assert.deepEqual(p.mcp[0].pin, { HUBSPOT_UPDATE_CONTACT: { properties: { keys: ["${parameters.crm_score_property}"] } } });
  const made = compiled(p, { crm_score_property: "hs_lead_score" }, { mcp: served(p), defaultTools: [], grants: [UPDATE] });
  // The grant writes no permission; the pin is written filled.
  assert.deepEqual(made.agent.definition.tool_settings, { [UPDATE]: { pin: { properties: { keys: ["hs_lead_score"] } } } });
  assert.deepEqual(made.unpinned, []);
  assert.deepEqual(filledPins(served(p), { crm_score_property: "hs_lead_score" }), [{ tool: UPDATE, pin: { properties: { keys: ["hs_lead_score"] } }, empty: [] }]);
  // The agent's settings as written hold the one key and refuse any other.
  const settings = made.agent.definition.tool_settings;
  assert.equal(pinRefusal(UPDATE, { contact_id: "1", properties: { hs_lead_score: 80 } }, {}, settings), undefined);
  assert.match(pinRefusal(UPDATE, { contact_id: "1", properties: { hs_lead_score: 80, lifecyclestage: "customer" } }, {}, settings).text, /may only be called with properties keys in \(hs_lead_score\)/);
  // The parameter not given, or given "": no key the owner meant, so the tool is denied and named.
  for (const given of [{}, { crm_score_property: "" }]) {
    const empty = compiled(p, given, { mcp: served(p), defaultTools: [], grants: [UPDATE] });
    assert.deepEqual(empty.agent.definition.tool_settings, { [UPDATE]: { permission: "deny" } }, JSON.stringify(given));
    assert.deepEqual(empty.unpinned, [{ tool: UPDATE, parameters: ["crm_score_property"] }]);
  }
});

test("a keys pin's key that is a list parameter alone adds each of its items; text around a placeholder fills as text", async (t) => {
  const { p } = await scorer(t, '{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: ["${parameters.more_properties}", "${parameters.crm_score_property}", "x_${parameters.crm_score_property}"] } } }');
  const made = compiled(p, { crm_score_property: "hs_lead_score", more_properties: ["lifecyclestage", "hs_lead_score"] }, { mcp: served(p), defaultTools: [], grants: [] });
  assert.deepEqual(made.agent.definition.tool_settings, { [UPDATE]: { pin: { properties: { keys: ["hs_lead_score", "lifecyclestage", "x_hs_lead_score"] } } } }, "in its one form");
  assert.deepEqual(compiled(p, { crm_score_property: "hs_lead_score", more_properties: [] }, { mcp: served(p), defaultTools: [], grants: [] }).unpinned, [{ tool: UPDATE, parameters: ["more_properties"] }]);
});

test("a malformed keys pin is refused when the package is read, in words", async (t) => {
  const refused = async (pin, pattern) => {
    const { problems } = await scorer(t, pin);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern}: ${JSON.stringify(problems)}`);
  };
  const rule = /mcp\[0\]\.pin\.HUBSPOT_UPDATE_CONTACT\.properties is .*\{keys: \[/;
  await refused("{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: [] } } }", rule);
  await refused("{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: hs_lead_score } } }", rule);
  await refused("{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: [hs_lead_score], values: [1] } } }", rule);
  await refused("{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: [[hs_lead_score]] } } }", rule);
  await refused('{ HUBSPOT_UPDATE_CONTACT: { properties: { keys: ["${parameters.crm_score_propery}"] } } }', /\$\{parameters\.crm_score_propery\} names no parameter/);
});
