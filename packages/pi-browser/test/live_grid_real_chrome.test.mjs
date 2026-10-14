import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cdpProvider } from "../dist/providers/cdp.js";
import { startLiveGrid } from "../examples/live-grid/live-grid.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";
const FAUX_KEY = "not-a-key"; // a fake value, named so the source export's credential scan reads it as one

const LOOPBACK_ONLY = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${Math.random().toString(36).slice(2, 8)}` })], { stopReason: "toolUse" });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const until = async (check, ms, what) => {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > end) throw new Error(`${what} within ${ms} ms`);
};

async function listen(url, token) {
  const events = [];
  const res = await fetch(`${url}events?token=${token}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let cut; (cut = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(cut + 2)) {
        const data = buffer.slice(0, cut).split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => undefined);
  return events;
}

test("the live grid fans one task out to three child agents, streams each one's browser to its tile, and releases every browser", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "live-grid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sites = [`${site.base}/a`, `${site.base}/b`, `${site.base}/a?third`];

  const core = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("faux", {
    api: "faux-api", apiKey: FAUX_KEY, baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
    models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
  });
  const model = modelRuntime.getModel("faux", "faux-1");
  let grid;
  // One script answers every model call, parent or child, in whatever order the children run: a child's prompt names
  // its site; a child holds its last turn until its tile has shown a frame, so the frames are seen while it works.
  core.setResponses(Array.from({ length: 40 }, () => async (context) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const last = context.messages.at(-1);
    const mine = /^Site: (.+)$/m.exec(asked)?.[1];
    if (!mine) return last.role === "toolResult" ? fauxAssistantMessage(`All three checked.\n${textOf(last)}`) : call("open_browsers", { tasks: sites.map((url) => ({ site: url, task: "Report the page title." })) });
    if (last.role !== "toolResult") return call("run", { code: `await page.goto(${JSON.stringify(mine)}); return await page.title();` });
    const index = sites.indexOf(mine);
    await until(() => (grid.tiles().find((tile) => tile.index === index)?.frames ?? 0) > 0, 20_000, `tile ${index + 1} shows a frame`);
    return fauxAssistantMessage(`Title: ${/Page [AB]/.exec(textOf(last))?.[0] ?? "unknown"}`);
  }));

  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "profiles"), args: [LOOPBACK_ONLY] } });
  grid = await startLiveGrid({ makeProvider: () => provider, models: { modelRuntime, parent: model, child: model }, maxChildren: 3, root: path.join(root, "work"), env: {} });
  let closed = false;
  t.after(async () => { if (!closed) await grid.close(); });

  const page = await fetch(grid.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>pi-browser live grid<\/title>/);
  const token = /<meta name="live-grid-token" content="([0-9a-f]{32})">/.exec(html)[1];
  const post = (text) => fetch(`${grid.url}prompt`, { method: "POST", headers: { "content-type": "application/json", "x-live-grid-token": token }, body: JSON.stringify({ text }) });
  const events = await listen(grid.url, token);
  await until(() => events.some((event) => event.type === "hello"), 5_000, "the page's stream opened");
  assert.deepEqual(events[0], { type: "hello", maxChildren: 3, busy: false });

  assert.equal((await post("What are the titles of these three pages?")).status, 202);
  assert.equal((await post("and again")).status, 409, "one task at a time");
  await until(() => events.some((event) => event.type === "chat" && event.kind === "done"), 120_000, "the parent finished");

  const tiles = grid.tiles();
  assert.deepEqual(tiles.map(({ index, site: url, state, created, released }) => ({ index, site: url, state, created, released })),
    sites.map((url, index) => ({ index, site: url, state: "done", created: 1, released: 1 })));
  for (const tile of tiles) assert.ok(tile.frames > 0, `tile ${tile.index + 1} streamed frames`);
  for (const index of [0, 1, 2]) {
    assert.ok(events.some((event) => event.type === "frame" && event.index === index && event.data.startsWith("/9j/")), `tile ${index + 1}'s JPEG frames reached the page`);
    const last = events.filter((event) => event.type === "tile" && event.index === index).at(-1);
    assert.deepEqual([last.status, last.released], [`Title: ${index === 1 ? "Page B" : "Page A"}`, true]);
  }
  assert.equal(events.some((event) => event.type === "live"), false, "a local Chrome has no live-view URL");
  const chat = events.filter((event) => event.type === "chat");
  assert.deepEqual(chat.filter((event) => ["user", "tool", "tool_end"].includes(event.kind)), [
    { type: "chat", kind: "user", text: "What are the titles of these three pages?" },
    { type: "chat", kind: "tool", name: "open_browsers", sites },
    { type: "chat", kind: "tool_end", name: "open_browsers", isError: false },
  ]);
  assert.match(chat.filter((event) => event.kind === "delta").map((event) => event.text).join(""), /^All three checked\.\n1\. .*\/a\nTitle: Page A\n\n2\. .*\/b\nTitle: Page B\n\n3\. .*\/a\?third\nTitle: Page A$/);

  const pids = tiles.flatMap((tile) => tile.refs).map((ref) => Number(ref.id.split(":")[1]));
  assert.equal(pids.length, 3);
  await until(() => pids.every((pid) => !alive(pid)), 10_000, "every child's Chrome exited");
  closed = true;
  await grid.close();
});
