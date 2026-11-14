// A keys pin under approvals never, on pi, claude-agent and codex: a template fences an MCP tool's object argument to the
// one key its parameter names, and the agent runs unattended. The run's scripted model writes an extra key: the call is
// refused, never parked on anyone and never sent (the fake MCP server sees no call). A write of the pinned key alone
// runs with no one asked. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, HARNESSES, harnessSetup } from "./fixtures/mcp-harness-setup.mjs";
import { follow, scratch, whenFree } from "./support.mjs";

const UPDATE = "mcp:fake/update_record";
/** A tool that takes an object argument, `fields`, and writes each of its keys to a record. */
const UPDATE_RECORD = {
  description: "Set fields on a record.",
  input: { type: "object", properties: { id: { type: "string" }, fields: { type: "object", additionalProperties: true } }, required: ["id", "fields"], additionalProperties: false },
  run: ({ id, fields }) => ({ content: [{ type: "text", text: `updated ${id}: ${Object.keys(fields).sort().join(",")}` }] }),
};

/** A package that writes one field of a record, the field its `field` parameter names, unattended. */
function scorePackage(dir, name, harness) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Writes one field of a record and runs unattended.\nharness: [${harness}]\nparameters:\n  field: { type: string, required: true, description: the one field it may write }\nmcp:\n  - server: fake\n    tools: [update_record]\n    required: true\n    allow: [update_record]\n    pin: { update_record: { fields: { keys: ["\${parameters.field}"] } } }\napprovals: never\n---\nCall the tool you are asked to call.\n`);
}

for (const harness of HARNESSES) {
  test(`${harness}: a keys pin under never: a call with an extra key is refused and never sent; the pinned key alone runs with no one asked`, { timeout: 240_000 }, async (t) => {
    const dir = join(await scratch(t), "templates");
    scorePackage(dir, `score-${harness}`, harness);
    const { api, fake, prompt } = await harnessSetup(t, harness, dir, { tools: { update_record: UPDATE_RECORD } });
    const applied = await whenFree(() => api("POST", `/templates/score-${harness}/apply`, { grants: [UPDATE], parameters: { field: "score" } }));
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const id = applied.body.agent_id;
    const agent = (await api("GET", `/agents/${id}`)).body;
    assert.deepEqual([agent.definition.harness, agent.definition.approvals], [harness, "never"]);
    assert.deepEqual(agent.definition.tool_settings[UPDATE], { permission: "allow", pin: { fields: { keys: ["score"] } } });

    // An extra key beside the pinned one: refused, never parked on anyone, never sent.
    const extra = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("update_record", { id: "r1", fields: { score: 5, owner: "mallory" } }) } }));
    assert.equal(extra.status, 202, JSON.stringify(extra.body));
    const { last } = await follow(api, extra.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.notEqual(last.status, "input_required", "nothing asks: the call is refused outright");
    assert.deepEqual(callsOf(fake, "update_record"), [], "the call with an extra key never reached the MCP server");
    if (last.status === "completed") assert.match((await api("GET", `/runs/${extra.body.run_id}`)).body.result?.final_answer ?? "", /fields keys in \(score\)/, "the model read the pin's words");

    // The pinned key alone: it runs, unasked.
    const ran = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("update_record", { id: "r1", fields: { score: 5 } }) } }));
    assert.equal(ran.status, 202, JSON.stringify(ran.body));
    const done = await follow(api, ran.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(done.last.status, "completed", JSON.stringify(done.last));
    assert.equal(callsOf(fake, "update_record").length, 1, "the pinned call ran once, with no one asked");
    assert.match((await api("GET", `/runs/${ran.body.run_id}`)).body.result?.final_answer ?? "", /updated r1: score/);
  });
}
