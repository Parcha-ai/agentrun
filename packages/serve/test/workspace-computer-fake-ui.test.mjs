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
import { AttachHub, attachedProvider } from "@parcha/agentrun-computer";
import { FakeUiDriver, fakeUiConnection, NEXT_ANIMATE_MS, NEXT_MS, serveUiSocket, UI_FIXTURE } from "@parcha/agentrun-computer/fake-ui-driver";
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
async function fakeRun(options = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-fake-ui-"));
  dirs.push(dir);
  const connection = await fakeUiConnection(options);
  closing.push(() => connection.close());
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: connection.client }, hello: connection.hello }, { mode: 1, context: ctx });
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

test("an act's state is the settled window after its expect: a point read against it is not stale, though the transition was still moving when the expect was met", async () => {
  const { tools } = await fakeRun();
  const first = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
  const acted = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ press: refOf(first, "Next") }], expect: { text: "Second page" } });
  assert.equal(acted.structured.expect, "met", acted.text);
  const onSecond = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ click: [300, 300] }], state: acted.structured.state });
  assert.equal(onSecond.isError, false, onSecond.text);
  assert.deepEqual(onSecond.structured.steps, [{ route: "background", verified: false }], "the state names the second page, not a frame of its transition");
});

test("with ui.tree off, a point goes stale when the frame changes, in the computer's words", async () => {
  const { tools } = await fakeRun({ features: { "ui.tree": { off: "Accessibility is not granted" } } });
  const home = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
  assert.equal(home.isError, false, home.text);
  const atNext = [150, 150];
  const pressed = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ click: atNext }], state: home.structured.id });
  assert.equal(pressed.isError, false, pressed.text);
  await new Promise((resolve) => setTimeout(resolve, NEXT_MS + NEXT_ANIMATE_MS + 100));
  const again = await call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [{ click: atNext }], state: home.structured.id });
  assert.match(JSON.stringify(again.structured ?? again.text), /stale/, again.text);
});

/** Two ends of one socket, delivering in order. */
function socketPair() {
  const ends = [{ text: [], closes: [] }, { text: [], closes: [] }];
  let closed;
  const side = (me, peer) => ({
    send(text) { if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text))); },
    close(code, reason) {
      if (closed) return;
      closed = { code, reason };
      queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
    },
    onText(listener) { me.text.push(listener); },
    onClose(listener) { me.closes.push(listener); },
    get closed() { return closed; },
  });
  return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}

test("a run's release closes its connection: the call in flight comes back aborted in the computer's words, and a later one is refused gone", async () => {
  const driver = new FakeUiDriver();
  const hub = new AttachHub();
  const paired = { id: "c-1", name: "Test Mac", hello: driver.hello(), labels: { owner: "test" } };
  const provider = attachedProvider(paired, hub);
  const [serve, computer] = socketPair();
  serveUiSocket(driver, computer);
  assert.equal((await hub.accept(paired, serve)).ok, true);
  closing.push(async () => driver.close());
  const held = (await provider.create({ image: "attached", lifetimeMs: 60_000, network: "open", labels: { run: "a" } })).value;
  const connected = (await provider.connect(held)).value;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-fake-ui-"));
  dirs.push(dir);
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: connected.client }, hello: connected.hello }, { mode: 1, context: ctx });
  const tools = run.hostTools(run.kindTools);
  assert.equal((await call(tools, "computer_script", { code: `await computer.apps.open(${JSON.stringify(UI_FIXTURE.id)});` })).isError, false);
  const waiting = call(tools, "computer_act", { app: UI_FIXTURE.id, steps: [], expect: { text: "never", timeoutMs: 30_000 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await provider.release(held, "delete")).ok, true);
  const aborted = await waiting;
  assert.equal(aborted.isError, true);
  assert.match(`${aborted.text} ${JSON.stringify(aborted.structured ?? null)}`, /abort/i, aborted.text);
  const later = await call(tools, "computer_observe", { app: UI_FIXTURE.id });
  assert.equal(later.isError, true);
  assert.match(`${later.text} ${JSON.stringify(later.structured ?? null)}`, /gone|closed/i, later.text);
});

test("a step the computer can't read is refused in words, by the tool and by a script alike", async () => {
  const { tools } = await fakeRun();
  const act = tools.find((tool) => tool.name === "computer_act");
  assert.equal(act.inputSchema.properties.steps.items.anyOf.length, 9, "the schema types each step shape");
  assert.match(act.description, /type UiStep = \{ press: UiRef; \}/, "and the description declares them as TypeScript");
  // A provider that doesn't constrain its calls to the schema can still send one: the computer refuses it.
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
