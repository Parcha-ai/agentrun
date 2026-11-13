// What a tool call leaves behind in the OpenCode adapter's MCP server once its client is gone and the server has closed:
// nothing. A call's progress timer stops when its client goes away, and nothing more is written to the response it
// left; the call still runs until it settles, so the drive's settle waits for it; close() lets go of any call still
// running after its window. A call that settles after that writes nothing.
import assert from "node:assert/strict";
import { request, ServerResponse } from "node:http";
import { test } from "node:test";
import { CLOSE_SETTLE_MS, startMcpServer } from "../dist/harness-opencode/host/mcp.js";

const KEY = "session-key-not-a-secret";
const TOOLS = [{ name: "echo", description: "Echo the text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
const PROGRESS_MS = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The live timers in this process (setTimeout and setInterval alike). */
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

/** Every write to an MCP response from now on, with whether the server had closed by then. */
function writes(t) {
  const seen = [];
  let closed = false;
  const write = ServerResponse.prototype.write;
  ServerResponse.prototype.write = function (chunk, ...rest) {
    seen.push({ closed, text: String(chunk) });
    return write.call(this, chunk, ...rest);
  };
  t.after(() => void (ServerResponse.prototype.write = write));
  return { seen, closing: () => void (closed = true), afterClose: () => seen.filter((w) => w.closed) };
}

/** A tools/call with a progress token, as OpenCode's client sends it, on a connection of its own (no client pool, whose
 *  timers would count): settles with its body, or undefined once `client` aborts it. */
function call(url, client) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "x" }, _meta: { progressToken: "p1" } } });
  return new Promise((resolve) => {
    const req = request(url, { method: "POST", agent: false, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => (text += chunk)).on("end", () => resolve(text)).on("error", () => resolve(undefined));
    });
    req.on("error", () => resolve(undefined));
    client.signal.addEventListener("abort", () => (req.destroy(), resolve(undefined)), { once: true });
    req.end(body);
  });
}

for (const [how, settleWith] of [["completes", (resolve) => resolve({ text: "done", isError: false })], ["fails", (_resolve, reject) => reject(new Error("the tool failed"))]]) {
  test(`a call that ${how} leaves no timer and no call running once the server closes`, async (t) => {
    const mcp = await startMcpServer({ tools: TOOLS, key: KEY, progressMs: PROGRESS_MS, call: () => new Promise((resolve, reject) => setTimeout(() => settleWith(resolve, reject), 3 * PROGRESS_MS)) });
    t.after(() => mcp.close());
    const baseline = timers();
    await call(mcp.url, new AbortController());
    await mcp.close();
    assert.equal(await mcp.settle(10), true, "no call running");
    assert.equal(timers(), baseline, "no timer left");
  });
}

test("a call whose client goes away is still running, so the drive's settle waits for it; its progress stops at once", async (t) => {
  const seen = writes(t);
  const started = Promise.withResolvers();
  let finish;
  const mcp = await startMcpServer({ tools: TOOLS, key: KEY, progressMs: PROGRESS_MS, call: () => new Promise((resolve) => (started.resolve(), (finish = resolve))) });
  t.after(() => (finish?.({ text: "late", isError: false }), mcp.close()));
  const client = new AbortController();
  const asked = call(mcp.url, client);
  await started.promise;
  await sleep(3 * PROGRESS_MS);
  client.abort();
  await asked;
  await sleep(PROGRESS_MS);
  const before = seen.seen.length;
  // The host tool's own run goes on (it ignores its abort here): the drive's settle must still see it.
  assert.equal(await mcp.settle(5 * PROGRESS_MS), false, "the call still runs after its client went away");
  assert.equal(seen.seen.length, before, `no progress written to a response its client left: ${seen.seen.length - before} writes`);
});

test("a call that never settles, its client gone and the server closed: no timer, no call running, nothing written after, and its late answer writes nothing", async (t) => {
  const seen = writes(t);
  const started = Promise.withResolvers();
  let finish;
  const mcp = await startMcpServer({ tools: TOOLS, key: KEY, progressMs: PROGRESS_MS, call: () => new Promise((resolve) => (started.resolve(), (finish = resolve))) });
  t.after(() => mcp.close());
  const baseline = timers();
  const client = new AbortController();
  const asked = call(mcp.url, client);
  await started.promise;
  client.abort();
  await asked;
  await mcp.close();
  seen.closing();
  const leftAfterClose = { timers: timers() - baseline, settled: await mcp.settle(10) };
  await sleep(5 * PROGRESS_MS);
  const progressAfterClose = seen.afterClose().length;
  // Its answer, long after the drive let it go.
  finish({ text: "too late", isError: false });
  await sleep(PROGRESS_MS);
  assert.deepEqual({ ...leftAfterClose, progressAfterClose, writesAfterLateAnswer: seen.afterClose().length }, { timers: 0, settled: true, progressAfterClose: 0, writesAfterLateAnswer: 0 }, `after close (window ${CLOSE_SETTLE_MS} ms)`);
});
