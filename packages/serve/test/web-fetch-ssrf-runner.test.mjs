// web_fetch's public-host guard on the runner's path: an agentic run claimed by the runner (the test support's in-process
// runner, as the CLI start runs one beside the server) calls web_fetch through bindNonHandTools → webFetchTool → fetchFor →
// readDirect → pi-browser's publicFetch. Every hostile target is refused (ok false, "refused: …") and never dialled: the
// fake network's dial log holds only public hosts, and a real listener on each loopback family accepts no connection, so a
// fetch that slipped past the guard onto the real network would show here too. The public page is answered, so the run
// can't pass by fetching nothing.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve } from "./support.mjs";

const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;

/** A TCP listener on `host` (a loopback of one family) at a free port, counting each connection it accepts. */
async function listener(t, host) {
  const accepted = [];
  const server = createServer((socket) => {
    accepted.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, host, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, accepted };
}

/** Each web_fetch result the run's timeline holds, in order, as the Page the model read. */
async function pagesOf(api, runId) {
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];
  return rows
    .filter((row) => row.kind === "tool_result" && row.tool_name === "web_fetch")
    .sort((a, b) => a.seq - b.seq)
    .map((row) => {
      const text = row.text || row.tool_result_preview || "";
      try {
        return JSON.parse(text);
      } catch {
        return { unparsed: text };
      }
    });
}

test("on the runner, web_fetch refuses every hostile target and dials none of them (loopback of both families, the metadata address, private ranges, a mapped address, names that resolve inside, redirects inward, other schemes), and still reads the public page", { timeout: 180_000 }, async (t) => {
  const log = join(await scratch(t), "dialled.txt");
  const saved = process.env.FAUX_WEB_LOG;
  process.env.FAUX_WEB_LOG = log;
  t.after(() => (saved === undefined ? delete process.env.FAUX_WEB_LOG : (process.env.FAUX_WEB_LOG = saved)));
  const v4 = await listener(t, "127.0.0.1");
  const v6 = await listener(t, "::1");
  const hostile = [
    `http://127.0.0.1:${v4.port}/`,
    "http://127.0.0.1/",
    "http://localhost/",
    "http://app.localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    `http://[::1]:${v6.port}/`,
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    `http://[::ffff:127.0.0.1]:${v4.port}/`,
    "http://evil.example/",
    "http://mixed.example/",
    "http://redirect.example/",
    "http://renamed.example/",
    "file:///etc/passwd",
  ];
  const { api } = await serve(t, { fauxWeb: FAUX_WEB });
  assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["web_fetch"] } })).status, 201);
  const urls = [...hostile, "http://public.example/"];
  const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages: ${JSON.stringify(urls)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 150_000 });
  const pages = await pagesOf(api, started.body.run_id);
  // First what was dialled: a guard that let one hostile target through shows here, as a dial to an inside address or a
  // connection a loopback listener counted, before any answer's words are read.
  const dialled = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(dialled, ["http://redirect.example/", "http://renamed.example/", "http://public.example/"], "only public addresses were dialled: the two redirecting hosts (their inward hop refused) and the public page");
  assert.deepEqual([v4.accepted, v6.accepted], [[], []], "no connection reached either loopback");
  // Then what the model read: each hostile target refused in the guard's words, and the public page.
  assert.equal(pages.length, urls.length, `one result per fetch: ${JSON.stringify(pages).slice(0, 2000)}`);
  hostile.forEach((url, i) => {
    assert.equal(pages[i].ok, false, `${url}: ${JSON.stringify(pages[i])}`);
    assert.match(pages[i].refused ?? "", /^refused: /, `${url} is refused in the guard's words: ${JSON.stringify(pages[i])}`);
  });
  assert.equal(pages.at(-1).ok, true, `the public page is read: ${JSON.stringify(pages.at(-1)).slice(0, 500)}`);
});
