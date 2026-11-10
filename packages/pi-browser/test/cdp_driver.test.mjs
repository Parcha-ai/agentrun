// The local browser's raw-CDP driver (src/driver/cdp.ts, Browser Use Pi's AX-id scheme) over a fake page
// (fixtures/fake-ax-page.mjs): a snapshot's "frame-node" ids, a cross-origin frame named and not read, click (scrolled
// into view, then pressed and released at the element's centre), fill, type, select, goto, each answered with its one
// line of what changed; a stale id and a navigated page fail as a stale snapshot; and through pageTools' run, actions
// work and code is refused in words.
import assert from "node:assert/strict";
import test from "node:test";
import { cdpDriver, LOCAL_CODE_REFUSED } from "../dist/driver/cdp.js";
import { BROWSER_TOOLS, NAVIGATED_SNAPSHOT_ERROR, pageTools } from "../dist/index.js";
import { fakeAxPage } from "./fixtures/fake-ax-page.mjs";

async function open(t) {
  const page = await fakeAxPage();
  const driver = await cdpDriver()({ sdkCdpUrl: page.url });
  t.after(async () => { await driver.close(); await page.close(); });
  return { page, driver };
}

test("a snapshot lists the page in order with frame-node ids, and names the cross-origin frame it could not read", async (t) => {
  const { driver } = await open(t);
  const shot = await driver.snapshot();
  const lines = shot.split("\n");
  assert.equal(lines[0], "[page] The form | https://example.test/form");
  assert.ok(lines.includes("## Plan a trip"));
  assert.ok(lines.includes("[0-10] textbox \"City\""));
  assert.ok(lines.includes("[0-11] button \"Add\""));
  assert.ok(lines.includes("[0-12] select \"Country\" = \"France\"  options: France | Canada"));
  assert.ok(lines.includes("[0-13] link \"Next page\""));
  assert.match(shot, /not in this snapshot: the cross-origin frame https:\/\/ads\.other\.test\/frame/);
  assert.match((await driver.snapshot({ includeIframes: false })), /1 frame left out: includeIframes is false/);
});

test("click scrolls the element into view, then presses and releases at its centre, and says what changed", async (t) => {
  const { page, driver } = await open(t);
  await driver.snapshot();
  const line = await driver.run({ actions: [{ op: "click", id: "0-11" }] });
  assert.equal(line, '[ok] click [0-11] button "Add" -> page changed');
  const mouse = page.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.x, c.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 100, 200], ["mousePressed", 100, 200], ["mouseReleased", 100, 200]]);
  const methods = page.calls.map((c) => c.method);
  assert.ok(methods.indexOf("DOM.scrollIntoViewIfNeeded") < methods.indexOf("Input.dispatchMouseEvent"), "scrolled, then clicked");
  // A link far down the page is scrolled to before it is clicked at its new centre, and the line says where it went.
  const went = await driver.run({ actions: [{ op: "click", id: "0-13" }] });
  assert.equal(went, '[ok] click [0-13] link "Next page" -> navigated to https://example.test/next');
  assert.ok(page.state.scrolled.has(13));
});

test("fill replaces a field's text with insertText and a real last key; type appends; select picks an option; each says what changed", async (t) => {
  const { page, driver } = await open(t);
  await driver.snapshot();
  page.state.nodes[10].value = "Old";
  assert.equal(await driver.run({ actions: [{ op: "fill", id: "0-10", value: "Zurich" }] }), '[ok] fill [0-10] textbox "City" = "Zurich" -> page changed');
  assert.equal(page.state.nodes[10].value, "Zurich");
  const sent = page.calls.filter((c) => c.method === "Input.insertText" || (c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown"));
  assert.deepEqual(sent.map((c) => c.params.text), ["Zuric", "h"], "all but the last as inserted text, the last as a key");
  assert.equal(await driver.run({ actions: [{ op: "type", id: "0-10", text: " West" }] }), '[ok] type [0-10] textbox "City" = " West" -> page changed');
  assert.equal(page.state.nodes[10].value, "Zurich West");
  assert.equal(await driver.run({ actions: [{ op: "select", id: "0-12", values: "Canada" }] }), '[ok] select [0-12] select "Country" = "Canada" -> page changed');
  assert.equal(page.state.nodes[12].value, "ca");
  // A batch: each action's line, in order.
  const batch = await driver.run({ actions: [{ op: "fill", id: "0-10", value: "Bern" }, { op: "click", id: "0-11" }] });
  assert.deepEqual(batch.split("\n"), ['[ok] fill [0-10] textbox "City" = "Bern" -> page changed', '[ok] click [0-11] button "Add" -> page changed']);
  assert.match(await driver.snapshot(), /Added Bern/);
});

test("goto opens a web page and drops the old ids; a scheme other than http, https or about:blank is refused", async (t) => {
  const { page, driver } = await open(t);
  await driver.snapshot();
  assert.equal(await driver.run({ actions: [{ op: "goto", url: "https://example.test/next" }] }), "[ok] goto https://example.test/next -> navigated to https://example.test/next");
  assert.equal(await driver.url(), "https://example.test/next");
  await assert.rejects(driver.run({ actions: [{ op: "click", id: "0-11" }] }), /No hydrated snapshot exists/);
  await assert.rejects(driver.run({ actions: [{ op: "goto", url: "file:///etc/passwd" }] }), /goto takes an http or https URL/);
  assert.equal(page.calls.filter((c) => c.method === "Page.navigate").length, 1, "the file: URL never reached the browser");
});

test("an id the latest snapshot does not show, and a page that navigated since it, fail as a stale snapshot before anything is sent", async (t) => {
  const { page, driver } = await open(t);
  await assert.rejects(driver.run({ actions: [{ op: "click", id: "0-11" }] }), /No hydrated snapshot exists/);
  await driver.snapshot();
  await assert.rejects(driver.run({ actions: [{ op: "click", id: "0-99" }] }), /Snapshot ID "0-99" is stale/);
  page.state.doc += 1;
  await assert.rejects(driver.checkActions([{ op: "click", id: "0-11" }]), { message: NAVIGATED_SNAPSHOT_ERROR });
  assert.equal(page.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0, "no click was sent");
  driver.forgetSnapshots();
  await assert.rejects(driver.run({ actions: [{ op: "click", id: "0-11" }] }), /No hydrated snapshot exists/);
});

test("through pageTools' run: actions work, and code is refused in words that say what to send instead", async (t) => {
  const { driver } = await open(t);
  const session = { driver, tag: "ar-run-1-1", sessionId: "sess-1", record: { lastUrl: "https://example.test/form" }, notice: null, interrupted: null, recorded: false, effects: null, downloads: null };
  const port = { session: async () => session, dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, ended: async () => false, dropped: async () => {}, navigated: async () => {} };
  const call = { callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (value) => value, evidence: { file: async () => ({ path: "evidence/x.md" }) } };
  const tools = pageTools();
  const looked = await tools.snapshot({}, port, call);
  assert.match(looked.content[0].text, /\[0-11\] button "Add"/);
  const acted = await tools.run({ actions: [{ op: "click", id: "0-11" }] }, port, { ...call, callId: "c2" });
  assert.notEqual(acted.isError, true, acted.content[0].text);
  assert.match(acted.content[0].text, /\[ok\] click \[0-11\] button "Add" -> page changed/);
  const coded = await tools.run({ code: "return await page.title()" }, port, { ...call, callId: "c3" });
  assert.equal(coded.isError, true);
  const failure = JSON.parse(coded.content[0].text);
  assert.equal(failure.code, "refused");
  assert.equal(failure.message, LOCAL_CODE_REFUSED);
});

test("the contract offers goto and says, for both browsers, that the local one takes actions only", () => {
  const run = BROWSER_TOOLS.find((tool) => tool.name === "run");
  const goto = run.parameters.properties.actions.items.oneOf.find((one) => one.properties.op.const === "goto");
  assert.deepEqual(goto.required, ["op", "url"]);
  assert.match(run.description, /The local browser \(this machine's Chrome\) takes actions only: code is refused there/);
  assert.match(run.description, /Stagehand Playwright facade/, "the vendor browsers keep run code");
  const snapshot = BROWSER_TOOLS.find((tool) => tool.name === "snapshot");
  assert.match(snapshot.description, /the snapshot names each frame it left out/);
});
