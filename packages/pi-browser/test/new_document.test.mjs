import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_GONE, documentReads, readOnNewDocument } from "../dist/driver/new-document.js";
import { StagehandFacadeTools } from "../dist/vendor/stagehand-facade/tools.js";

// Chrome's answer to an evaluate in a document a navigation has replaced, as Stagehand's extension relays it; the
// facade's code runs rebuild it as a plain Error with the same text and no cause.
const relayed = () => Object.assign(new Error(CONTEXT_GONE), { cause: { code: -32603, message: CONTEXT_GONE, data: { name: "Error" } } });
const rebuilt = () => new Error(CONTEXT_GONE);

test("a read that lands in a document a navigation has replaced waits for the new document, then reads once more", async () => {
  for (const gone of [relayed, rebuilt]) {
    const steps = [];
    let reads = 0;
    const value = await readOnNewDocument(async () => { reads += 1; steps.push(`read ${reads}`); if (reads === 1) throw gone(); return "the new page"; }, async () => { steps.push("waited"); });
    assert.equal(value, "the new page");
    assert.deepEqual(steps, ["read 1", "waited", "read 2"], gone.name);
  }
});

test("it reads once more only once: a second lost document is the caller's", async () => {
  let waits = 0;
  await assert.rejects(readOnNewDocument(async () => { throw relayed(); }, async () => { waits += 1; }), (error) => error.cause?.message === CONTEXT_GONE);
  assert.equal(waits, 1);
});

test("any other failure is thrown at once, with no wait: other text, a cause with other text, a value that is not an Error", async () => {
  for (const failure of [new Error("Execution context was destroyed"), Object.assign(new Error(CONTEXT_GONE), { cause: { code: -32603, message: "something else" } }), Object.assign(new Error("x"), { cause: { code: -32603, message: "something else" } }), CONTEXT_GONE]) {
    let waits = 0;
    await assert.rejects(readOnNewDocument(async () => { throw failure; }, async () => { waits += 1; }), (error) => error === failure);
    assert.equal(waits, 0, String(failure?.message ?? failure));
  }
});

test("a wait that fails still reads once more, so the read's own answer is what comes back", async () => {
  let reads = 0;
  const value = await readOnNewDocument(async () => { reads += 1; if (reads === 1) throw relayed(); return "read"; }, async () => { throw new Error("the wait timed out"); });
  assert.equal(value, "read");
});

// The driver's reads, through the real facade: a stand-in Stagehand answers each batch and snapshot in turn.
function facadeOver({ batches = [], snapshots = [] }) {
  const page = { pageId: "page-1", url: async () => "https://example.test/", snapshot: async () => { const next = snapshots.shift(); if (next instanceof Error) throw next; return next; } };
  const stagehand = { browser: { context: { activePage: async () => page } }, experimentalBatch: async () => { const next = batches.shift(); if (next instanceof Error) throw next; return next; } };
  return new StagehandFacadeTools(stagehand);
}
const envelope = (value) => ({ __stagehandPlaywrightCompat: true, value });
const failedIn = (message) => ({ __stagehandPlaywrightCompat: true, executionError: { name: "Error", message } });
const PAGE = { url: "https://example.test/", title: "T", text: "body", html: "<html></html>" };

test("the driver's page read retries a lost document the facade's code run reports, in either shape", async () => {
  for (const first of [failedIn(CONTEXT_GONE), relayed()]) {
    let waits = 0;
    const reads = documentReads(facadeOver({ batches: [first, envelope(PAGE)] }), async () => { waits += 1; });
    assert.deepEqual(await reads.page(), PAGE);
    assert.equal(waits, 1);
  }
});

test("the driver's snapshot retries a lost document once, and a second one is the caller's", async () => {
  let waits = 0;
  const once = documentReads(facadeOver({ snapshots: [relayed(), { formattedTree: "[0-1] RootWebArea: T", xpathMap: {} }] }), async () => { waits += 1; });
  assert.equal(await once.snapshot(), "[0-1] RootWebArea: T");
  assert.equal(waits, 1);
  const twice = documentReads(facadeOver({ snapshots: [relayed(), relayed()] }), async () => {});
  await assert.rejects(twice.snapshot(), (error) => error.cause?.message === CONTEXT_GONE);
});

test("the driver's page read throws any other failure of the code run at once, with no wait", async () => {
  let waits = 0;
  const reads = documentReads(facadeOver({ batches: [failedIn("page.evaluate: boom")] }), async () => { waits += 1; });
  await assert.rejects(reads.page(), /boom/);
  assert.equal(waits, 0);
});
