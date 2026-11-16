// A keys pin under approvals never, on pi, claude-agent and codex: a template fences an MCP tool's object argument to the
// one key its parameter names, and the agent runs unattended. The run's scripted model writes an extra key: the call is
// refused, never parked on anyone and never sent (the fake MCP server sees no call). A write of the pinned key alone
// runs with no one asked. The same holds for a call made through tools_call (on the harnesses that offer it, past the
// deferral threshold: an agent with idle tools beside it) and through a codemode script (on each harness but Codex, which
// keeps its own code mode): the gate asks about each as the MCP tool it calls, with its own arguments. No socket leaves
// this machine and no real key is used.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, HARNESSES, harnessSetup, IDLE_TOOLS, TOOLS_CALL_HARNESSES } from "./fixtures/mcp-harness-setup.mjs";
import { follow, scratch, whenFree } from "./support.mjs";

const UPDATE = "mcp:fake/update_record";
/** A tool that takes an object argument, `fields`, and writes each of its keys to a record. */
const UPDATE_RECORD = {
  description: "Set fields on a record.",
  input: { type: "object", properties: { id: { type: "string" }, fields: { type: "object", additionalProperties: true } }, required: ["id", "fields"], additionalProperties: false },
  run: ({ id, fields }) => ({ content: [{ type: "text", text: `updated ${id}: ${Object.keys(fields).sort().join(",")}` }] }),
};

const IDLE = Object.keys(IDLE_TOOLS);

/** A package that writes one field of a record, the field its `field` parameter names, unattended; `idle` tools of the
 *  fake's beside it. */
function scorePackage(dir, name, harness, idle = []) {
  mkdirSync(join(dir, name), { recursive: true });
  const tools = ["update_record", ...idle].join(", ");
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Writes one field of a record and runs unattended.\nharness: [${harness}]\nparameters:\n  field: { type: string, required: true, description: the one field it may write }\nmcp:\n  - source: url\n    toolkit: fake\n    tools: [${tools}]\n    required: true\n    allow: [${tools}]\n    pin: { update_record: { fields: { keys: ["\${parameters.field}"] } } }\napprovals: never\n---\nCall the tool you are asked to call.\n`);
}

for (const harness of HARNESSES) {
  test(`${harness}: a keys pin under never: a call with an extra key is refused and never sent; the pinned key alone runs with no one asked`, { timeout: 240_000 }, async (t) => {
    const dir = join(await scratch(t), "templates");
    scorePackage(dir, `score-${harness}`, harness);
    scorePackage(dir, `score-many-${harness}`, harness, IDLE);
    const { api, fake, prompt, host } = await harnessSetup(t, harness, dir, { tools: { update_record: UPDATE_RECORD, ...IDLE_TOOLS } });
    const applied = await whenFree(() => api("POST", `/templates/score-${harness}/apply`, { grants: [UPDATE], parameters: { field: "score" } }));
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const id = applied.body.agent_id;
    const agent = (await api("GET", `/agents/${id}`)).body;
    assert.deepEqual([agent.definition.harness, agent.definition.approvals], [harness, "never"]);
    // The tick writes no permission (approvals never runs it unasked); the pin is written filled.
    assert.deepEqual(agent.definition.tool_settings[UPDATE], { pin: { fields: { keys: ["score"] } } });

    // An extra key beside the pinned one: refused, never parked on anyone, never sent.
    const extra = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("update_record", { id: "r1", fields: { score: 5, owner: "mallory" } }) } }));
    assert.equal(extra.status, 202, JSON.stringify(extra.body));
    const { last } = await follow(api, extra.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed", `nothing asks and nothing fails: the call is refused outright, ${JSON.stringify(last)}`);
    assert.deepEqual(callsOf(fake, "update_record"), [], "the call with an extra key never reached the MCP server");
    assert.match((await api("GET", `/runs/${extra.body.run_id}`)).body.result?.final_answer ?? "", /fields keys in \(score\)/, "the model read the pin's words");

    // The pinned key alone: it runs, unasked.
    const ran = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("update_record", { id: "r1", fields: { score: 5 } }) } }));
    assert.equal(ran.status, 202, JSON.stringify(ran.body));
    const done = await follow(api, ran.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(done.last.status, "completed", JSON.stringify(done.last));
    assert.equal(callsOf(fake, "update_record").length, 1, "the pinned call ran once, with no one asked");
    assert.match((await api("GET", `/runs/${ran.body.run_id}`)).body.result?.final_answer ?? "", /updated r1: score/);

    // Through tools_call and a codemode script: the inner call is held to the pin by its own arguments. tools_call is
    // offered only past the deferral threshold, so to the agent with the idle tools too.
    const INNER = "mcp__fake__update_record";
    let many;
    if (TOOLS_CALL_HARNESSES.has(harness)) {
      const made = await whenFree(() => api("POST", `/templates/score-many-${harness}/apply`, { grants: [UPDATE, ...IDLE.map((tool) => `mcp:fake/${tool}`)], parameters: { field: "score" } }));
      assert.equal(made.status, 201, JSON.stringify(made.body));
      many = made.body.agent_id;
    }
    const through = [
      ...(many ? [["tools_call", many, (fields) => host("tools_call", { name: INNER, args: { id: "r1", fields } })]] : []),
      ...(harness === "codex" ? [] : [["codemode", id, (fields) => host("codemode", { script: `return await tools.${INNER}(${JSON.stringify({ id: "r1", fields })});` })]]),
    ];
    for (const [via, runner, input] of through) {
      const before = callsOf(fake, "update_record").length;
      const refused = await whenFree(() => api("POST", `/agents/${runner}/runs`, { input: { content: input({ score: 5, owner: "mallory" }) } }));
      assert.equal(refused.status, 202, JSON.stringify(refused.body));
      const end = await follow(api, refused.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
      assert.equal(end.last.status, "completed", `${via}: nothing asks and nothing fails, ${JSON.stringify(end.last)}`);
      assert.equal(callsOf(fake, "update_record").length, before, `${via}: the call with an extra key never reached the MCP server`);
      assert.match((await api("GET", `/runs/${refused.body.run_id}`)).body.result?.final_answer ?? "", /fields keys in \(score\)/, `${via}: the model read the pin's words`);
      const pinned = await whenFree(() => api("POST", `/agents/${runner}/runs`, { input: { content: input({ score: 6 }) } }));
      assert.equal(pinned.status, 202, JSON.stringify(pinned.body));
      const ok = await follow(api, pinned.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
      assert.equal(ok.last.status, "completed", `${via}: ${JSON.stringify(ok.last)}`);
      assert.equal(callsOf(fake, "update_record").length, before + 1, `${via}: the pinned key alone ran once, unasked`);
      assert.match((await api("GET", `/runs/${pinned.body.run_id}`)).body.result?.final_answer ?? "", /updated r1: score/, via);
    }
  });
}
