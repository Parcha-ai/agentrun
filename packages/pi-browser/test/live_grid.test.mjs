import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startLiveGrid } from "../examples/live-grid/live-grid.mjs";
import { watchedProvider } from "../examples/live-grid/tiles.mjs";
const FAUX_KEY = "not-a-key"; // a fake value, named so the source export's credential scan reads it as one

async function startGrid(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "live-grid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const core = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
  core.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Nothing to open.")));
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("faux", {
    api: "faux-api", apiKey: FAUX_KEY, baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
    models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
  });
  const model = modelRuntime.getModel("faux", "faux-1");
  const grid = await startLiveGrid({ makeProvider: () => { throw new Error("no browser here"); }, models: { modelRuntime, parent: model, child: model }, maxChildren: 2, root: path.join(root, "work"), env: {} });
  t.after(() => grid.close());
  return grid;
}

const request = (url, { method = "GET", headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; if (res.headers["content-type"] === "text/event-stream" && text.includes("\n\n")) { req.destroy(); resolve({ status: res.statusCode, text }); } });
    res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject);
  if (body !== null) req.write(body);
  req.end();
});

async function stream(url, headers, until) {
  const events = [];
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (const end = Date.now() + 10_000; Date.now() < end && !until(events);) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let cut; (cut = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(cut + 2)) {
      const fields = Object.fromEntries(buffer.slice(0, cut).split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
      if (fields.data) events.push({ id: fields.id ? Number(fields.id) : null, ...JSON.parse(fields.data) });
    }
  }
  controller.abort();
  return events;
}

test("only the grid's own page can read it, stream it or start a task: another origin, a rebound host name or a missing token is refused", async (t) => {
  const grid = await startGrid(t);
  const { host } = new URL(grid.url);
  const page = await request(grid.url);
  assert.equal(page.status, 200);
  const token = /<meta name="live-grid-token" content="([0-9a-f]{32})">/.exec(page.text)?.[1];
  assert.ok(token, "the page carries its launch token");
  const json = JSON.stringify({ text: "Open nothing." });

  const refused = {
    "a page on another origin, as a simple request": { method: "POST", headers: { "content-type": "text/plain", origin: "https://other.test" }, body: json },
    "another origin with the token": { method: "POST", headers: { "content-type": "application/json", origin: "https://other.test", "x-live-grid-token": token }, body: json },
    "no token": { method: "POST", headers: { "content-type": "application/json", origin: `http://${host}` }, body: json },
    "a wrong token": { method: "POST", headers: { "content-type": "application/json", "x-live-grid-token": "0".repeat(32) }, body: json },
    "a rebound host name": { method: "POST", headers: { "content-type": "application/json", host: `rebound.test:${new URL(grid.url).port}`, "x-live-grid-token": token }, body: json },
  };
  for (const [name, options] of Object.entries(refused)) assert.equal((await request(`${grid.url}prompt`, options)).status, 403, name);
  assert.equal((await request(`${grid.url}prompt`, { method: "POST", headers: { "content-type": "text/plain", "x-live-grid-token": token }, body: json })).status, 415, "not JSON");
  assert.equal((await request(grid.url, { headers: { host: `rebound.test:${new URL(grid.url).port}` } })).status, 403, "the page is not served under a rebound host name");
  assert.equal((await request(`${grid.url}events`)).status, 403, "the stream needs the token");
  assert.equal((await request(`${grid.url}events?token=${token}`, { headers: { host: `rebound.test:${new URL(grid.url).port}` } })).status, 403, "the stream under a rebound host name");
  const wide = encodeURIComponent("\u00e9".repeat(32));
  assert.equal((await request(`${grid.url}events?token=${wide}`)).status, 403, "a token of the right length in characters but not in bytes");
  assert.equal((await request(`${grid.url}prompt`, { method: "POST", headers: { "content-type": "application/json", "x-live-grid-token": "\u00e9".repeat(32) }, body: json })).status, 403, "the same in the header");
  assert.equal((await request(grid.url)).status, 200, "the server still answers");
  const quiet = await stream(`${grid.url}events?token=${token}`, {}, (events) => events.some((event) => event.type === "hello"));
  assert.deepEqual(quiet.filter((event) => event.type === "chat"), [], "no refused request started a task");

  assert.equal((await request(`${grid.url}prompt`, { method: "POST", headers: { "content-type": "application/json", origin: `http://${host}`, "x-live-grid-token": token }, body: json })).status, 202);
});

test("a stream that reconnects with Last-Event-ID gets only the chat it missed", async (t) => {
  const grid = await startGrid(t);
  const token = /<meta name="live-grid-token" content="([0-9a-f]{32})">/.exec((await request(grid.url)).text)[1];
  await grid.prompt("First task.");
  const first = await stream(`${grid.url}events?token=${token}`, {}, (events) => events.some((event) => event.type === "chat" && event.kind === "done"));
  const chat = first.filter((event) => event.type === "chat");
  assert.ok(chat.length >= 3 && chat.every((event) => Number.isInteger(event.id)), "every chat event carries an id");
  const last = chat.at(-1).id;
  await grid.prompt("Second task.");
  const resumed = await stream(`${grid.url}events?token=${token}`, { "last-event-id": String(last) }, (events) => events.filter((event) => event.type === "chat" && event.kind === "done").length >= 1);
  const replayed = resumed.filter((event) => event.type === "chat");
  assert.deepEqual(replayed.filter((event) => event.kind === "user").map((event) => event.text), ["Second task."], "the first task's chat is not sent again");
  assert.ok(replayed.every((event) => event.id > last));
});

test("a live view that answers after its browser was released or replaced never reaches the tile", async () => {
  const late = {};
  const provider = {
    name: "fake", caps: {},
    async create(spec) { return { id: spec.tag, tag: spec.tag }; },
    liveView(ref) { return new Promise((resolve) => { late[ref.id] = () => resolve({ fullscreen: `https://live.test/${ref.id}`, framed: null, pages: [] }); }); },
    async attach() { return { sdkCdpUrl: "ws://127.0.0.1:9/devtools/browser/x" }; },
    async release() {},
  };
  const shown = [];
  const tile = { launched() {}, live: (url) => shown.push(url), screencast() {}, stopScreencast() {}, released() {} };
  const watched = watchedProvider(provider, tile);
  const one = await watched.create({ tag: "one" });
  await watched.release(one);
  const two = await watched.create({ tag: "two" });
  const three = await watched.create({ tag: "three" });
  for (const id of ["one", "two", "three"]) late[id]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, ["https://live.test/three"]);
  assert.ok(two && three);
});
