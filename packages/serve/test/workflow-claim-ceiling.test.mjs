// A workflow run's claim under the server's ceiling (runner/harness-loops.ts loopOn hands the capped plane to the
// workflow loop, which runner/workflow-spec.ts readClaim takes over the launch's own). A workflow whose call node reads a
// page with web_fetch, saved on keyless Firecrawl, and claimed after the server is set to kernel for web_fetch: the
// call node's URL goes to no keyless service, the guarded direct fetch reads it, and nothing reaches Firecrawl.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { FAUX, follow, scratch, serve, startInProcessRunner, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const PAGE = "http://public.example/";
const flow = {
  v: 2, name: "read-site",
  schemas: {
    In: { type: "object", required: ["website"], properties: { website: { type: "string" } } },
    Page: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Page", path: "home" },
  root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "web_fetch", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
};

test("a workflow run saved on keyless Firecrawl for web_fetch, claimed after the server is set to kernel: its call node's fetch is the guarded direct one and nothing reaches Firecrawl", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "dialled.txt");
  withEnv(t, { FAUX_WEB_LOG: log });
  const dialled = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const firecrawl = await firecrawlServer(t);
  const options = { fauxWeb: fixture("faux-web.mjs"), fauxFirecrawl: firecrawl.url };
  // No runner yet: the run is saved before the server's setting changes, and claimed only after.
  const server = await serve(t, { ...options, runner: false });
  const { api, store } = server;
  const saved = await api("POST", "/agents", { definition: { id: "site", name: "site", workflow: flow, tools: ["web_fetch"], tool_settings: { web_fetch: { provider: "firecrawl-keyless" } } } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const started = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  assert.equal((await store.runs.launch(runId))?.body?.plane?.web_fetch, "firecrawl-keyless", "saved on keyless Firecrawl");
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { provider: "kernel" } })).status, 200);
  const close = await startInProcessRunner(server.data, { ...options, faux: FAUX, mcpOwn: server.own });
  t.after(close);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(firecrawl.got, [], "nothing reached Firecrawl");
  assert.deepEqual((await dialled()).filter((url) => url.startsWith(PAGE)), [PAGE], "the page was dialled directly, once");
});
