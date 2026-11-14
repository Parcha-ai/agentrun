// A template applied under approvals never, the owner ticking one of a saved MCP server's two tools: the tool left
// unticked is never offered to the model nor run, on pi, claude-agent and codex. The run's scripted model calls it
// anyway: the call is refused and the fake MCP server never sees it. The ticked tool runs with no one asked. Never only
// skips asking for a tool its owner ticked; it grants nothing. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, HARNESSES, harnessSetup as setup } from "./fixtures/mcp-harness-setup.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { follow, scratch, whenFree } from "./support.mjs";

const TICKED = "mcp:fake/add";
const UNTICKED = "mcp:fake/delete_thing";

for (const harness of HARNESSES) {
  test(`${harness}: a template applied under never with one of two MCP tools ticked: the unticked one is never offered, a call of it is refused and never sent; the ticked one runs with no one asked`, { timeout: 240_000 }, async (t) => {
    const dir = join(await scratch(t), "templates");
    twoToolPackage(dir, `two-tools-${harness}`, harness);
    const { api, fake, prompt, offered, wire } = await setup(t, harness, dir);
    const applied = await whenFree(() => api("POST", `/templates/two-tools-${harness}/apply`, { grants: [TICKED] }));
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const id = applied.body.agent_id;
    const agent = (await api("GET", `/agents/${id}`)).body;
    assert.deepEqual([agent.definition.harness, agent.definition.approvals], [harness, "never"]);

    // The model calls the unticked tool: refused, never parked on anyone, never sent.
    const refused = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("delete_thing", { id: "x1" }) } }));
    assert.equal(refused.status, 202, JSON.stringify(refused.body));
    const { last } = await follow(api, refused.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.notEqual(last.status, "input_required", "nothing asks: the call is refused outright");
    assert.deepEqual(callsOf(fake, "delete_thing"), [], "the unticked tool never reached the MCP server");
    for (const tools of offered()) assert.ok(!tools.includes(wire("delete_thing")), `the unticked tool was offered: ${JSON.stringify(tools)}`);

    // The ticked tool runs, unasked.
    const ran = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("add", { a: 2, b: 3 }) } }));
    assert.equal(ran.status, 202, JSON.stringify(ran.body));
    const done = await follow(api, ran.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(done.last.status, "completed", JSON.stringify(done.last));
    assert.equal(callsOf(fake, "add").length, 1, "the ticked tool ran once, with no one asked");
    assert.match((await api("GET", `/runs/${ran.body.run_id}`)).body.result?.final_answer ?? "", /5/);
    if (harness !== "codex") assert.ok(offered().some((tools) => tools.includes(wire("add"))), `the ticked tool was offered: ${JSON.stringify(offered())}`);
    // At the source: the apply never granted it.
    assert.ok(!agent.definition.tools.includes(UNTICKED), `the unticked tool is not the agent's: ${JSON.stringify(agent.definition.tools)}`);
  });
}
