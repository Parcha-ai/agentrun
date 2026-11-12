// The computer's tools on the fake ui driver (packages/computer fake-ui-driver.ts): a scripted app over the wire, its ui
// group run through UiEngine, so refs survive, an act settles before it answers and an expect is polled until it holds.
// The per-step tools, computer_script and the claim's MCP server answer the same values from one surface: observe, then
// act by ref with an expect; the same steps as one script; a point read against a state that moved, refused as stale.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fakeUiConnection, UI_FIXTURE } from "@parcha/agentrun-computer/fake-ui-driver";
import { computerMcp, localWorkspace, runTools } from "../dist/workspace/index.js";

const dirs = [];
const closing = [];
after(async () => {
  for (const close of closing) await close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const call = (tools, name, args) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${name}-${Math.random()}`, signal: new AbortController().signal });

/** A run on a fresh fake ui desktop: its tools, bound to it, the fixture's app opened by a script (the tools open no
 *  app: a script's computer.apps.open does, as the kind skills teach). */
async function fakeRun() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-fake-ui-"));
  dirs.push(dir);
  const connection = await fakeUiConnection();
  closing.push(() => connection.close());
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: connection.client }, groups: connection.hello.groups }, { mode: 1, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const opened = await call(tools, "computer_script", { code: `await computer.apps.open(${JSON.stringify(UI_FIXTURE.id)});` });
  assert.equal(opened.isError, false, opened.text);
  return { run, tools };
}
const refOf = (observed, name) => observed.structured.elements.find((node) => node.name === name)?.ref;
/** An observation's words and value with its state's id left out: each observe names a new state. */
const stateless = (text, value) => ({ text: text.replace(/^state s\d+/, "state"), value: JSON.stringify({ ...value, id: "", outline: value.outline.replace(/^state s\d+/, "state") }) });

test("observe, then press by ref with an expect: the act settles, the expect is met, and the window's new state is named", async () => {
  const { run, tools } = await fakeRun();
  assert.ok(run.kindTools.includes("computer_observe") && run.kindTools.includes("computer_act") && run.kindTools.includes("computer_script"), JSON.stringify(run.kindTools));
  assert.ok(!run.kindTools.includes("computer_screenshot"), "no screen group: no screenshot tool");
  const observed = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
  assert.equal(observed.isError, false, observed.text);
  assert.match(observed.text, /button "Save"/);
  const save = refOf(observed, "Save");
  assert.ok(save, JSON.stringify(observed.structured));
  const acted = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ press: save }], expect: { text: "Saved" } });
  assert.equal(acted.isError, false, acted.text);
  assert.equal(acted.structured.expect, "met", acted.text);
  assert.equal(acted.structured.steps[0].route, "semantic");
  assert.notEqual(acted.structured.state, observed.structured.id, "the window's state moved");
});

test("the same steps as one script answer what the tools answer, and return only what the next decision needs", async () => {
  const { tools } = await fakeRun();
  const code = [
    `const app = computer.app(${JSON.stringify(UI_FIXTURE.id)});`,
    "await app.observe();",
    "const save = app.find({ role: 'button', text: 'Save' })[0];",
    "const done = await app.press(save.ref, { expect: { text: 'Saved' } });",
    "return { met: done.expect, route: done.steps[0].route };",
  ].join("\n");
  const scripted = await call(tools, "computer_script", { code });
  assert.equal(scripted.isError, false, scripted.text);
  assert.deepEqual(scripted.structured, { met: "met", route: "semantic" });
});

test("a point read against a state the window has left is refused as stale, in the computer's words", async () => {
  const { tools } = await fakeRun();
  const first = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
  const next = refOf(first, "Next");
  await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ press: next }], expect: { text: "Second page" } });
  const stale = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ click: [40, 150] }], state: first.structured.id });
  assert.match(JSON.stringify(stale.structured ?? stale.text), /stale/, stale.text);
});

test("a step the computer can't read is refused in words, by the tool and by a script alike: computer_act's schema types no step", async () => {
  const { tools } = await fakeRun();
  const act = tools.find((tool) => tool.name === "computer_act");
  assert.deepEqual(act.inputSchema.properties.steps.items, { type: "object" }, "the steps are declared in the description, once");
  assert.match(act.description, /type UiStep = \{ press: UiRef; \}/);
  const byTool = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ tap: "@e1" }] });
  const byScript = await call(tools, "computer_script", { code: `return await computer.app(${JSON.stringify(UI_FIXTURE.id)}).act([{ tap: "@e1" }]);` });
  for (const [how, answer] of [["tool", byTool], ["script", byScript]]) {
    const words = `${answer.text} ${JSON.stringify(answer.structured ?? null)}`;
    assert.equal(answer.isError, true, `${how}: ${words}`);
    assert.match(words, /steps\[0\] names no step: a step is exactly one of press, set/, `${how}: ${words}`);
    assert.doesNotMatch(words, /"route":"semantic"/, `${how}: nothing ran`);
  }
});

test("the claim's MCP server on the fake ui driver answers the per-step tool's value as structuredContent", async () => {
  const { tools } = await fakeRun();
  const mcp = computerMcp(tools);
  const client = new Client({ name: "fake-ui-mcp-test", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://claim.test/mcp"), { fetch: (url, init) => mcp.fetch(new Request(url, init)) }));
  try {
    const byTool = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
    const byMcp = await client.callTool({ name: "computer_observe", arguments: { app: UI_FIXTURE.id } });
    assert.deepEqual(stateless(byMcp.content[0].text, byMcp.structuredContent), stateless(byTool.text, byTool.structured), "the same words and value, but for the new state's id");
  } finally {
    await client.close();
  }
});
