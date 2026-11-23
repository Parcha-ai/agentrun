// GET /v2/wrapped: a year of the work under this machine's home, as numbers (wrapped.ts over the import package's
// wrappedHome), answered only by a server on loopback with no public URL. It holds no prompt, path or project.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { agent, follow, serve } from "./support.mjs";

const WORDS = "Fixture prompt, never reported.";
const stamp = (iso) => ({ timestamp: iso, sessionId: "00000000-0000-4000-8000-000000000001", cwd: "/work/wrapped-fixture", isSidechain: false });
const answer = (n, iso, input, output) => ({ ...stamp(iso), type: "assistant", uuid: `a${n}`, requestId: `r${n}`, message: { id: `m${n}`, role: "assistant", model: "claude-fixture-1", content: [{ type: "text", text: "Done." }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } } });

async function homeWith(t) {
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wrapped-"));
  const was = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = was;
    await rm(home, { recursive: true, force: true });
  });
  const file = join(home, ".claude", "projects", "-work-wrapped-fixture", "00000000-0000-4000-8000-000000000001.jsonl");
  await mkdir(join(file, ".."), { recursive: true });
  const records = [{ ...stamp("2026-03-02T09:00:00.000Z"), type: "user", uuid: "u1", message: { role: "user", content: WORDS } }, answer(1, "2026-03-02T09:00:10.000Z", 100, 10), answer(2, "2026-03-02T09:00:40.000Z", 200, 20), answer(3, "2025-12-31T23:00:00.000Z", 7, 1)];
  await writeFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return home;
}

test("GET /wrapped reads the year under the home: tokens, days, hours, models, harnesses, sources; nothing of the text", { timeout: 120_000 }, async (t) => {
  process.env.TZ = "UTC";
  const home = await homeWith(t);
  const { api, store } = await serve(t);
  // The runs imported here, by source: a run made here is never one of them, and a run of another year is not counted.
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const live = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, live.body.run_id, ["completed"]);
  const { agentId, revisionId } = await store.runs.get(live.body.run_id);
  const imported = (id, source, startedAt) => store.importRun({ id, agentId, revisionId, importedFrom: { source, session: id }, launch: { body: { input: { content: "hi" }, title: id, place: { mode: "runner" } } }, startedAt: Date.parse(startedAt), transcript: [] });
  await imported("imp-1", "claude-code", "2026-03-02T10:00:00Z");
  await imported("imp-2", "claude-code", "2026-03-03T10:00:00Z");
  await imported("imp-3", "codex", "2026-03-04T10:00:00Z");
  await imported("imp-old", "codex", "2025-03-04T10:00:00Z");
  const { status, body } = await api("GET", "/wrapped?year=2026");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.year, 2026);
  assert.deepEqual([body.requests, body.sessions, body.turns], [2, 0, 0], "the session began in 2025: it counts there, its requests where they were made");
  assert.deepEqual(body.tokens, { input: 300, output: 30, cache_read: 100, cache_write: 10 });
  assert.deepEqual(body.days, [{ day: "2026-03-02", requests: 2, tokens: 440 }]);
  assert.equal(body.hours[9], 2);
  assert.equal(body.weekdays[1], 2);
  assert.equal(body.active_ms, 30_000);
  assert.deepEqual(body.models.map((m) => [m.model, m.requests, m.tokens]), [["anthropic/claude-fixture-1", 2, 440]]);
  assert.deepEqual(body.sources, [{ source: "claude-code", sessions: 0, requests: 2 }]);
  assert.deepEqual(body.imported.map((g) => [g.source, g.runs]).sort(), [["claude-code", 2], ["codex", 1]]);
  const was = (await api("GET", "/wrapped?year=2025")).body;
  assert.deepEqual([was.sessions, was.turns, was.requests], [1, 1, 1]);
  const text = JSON.stringify(body) + JSON.stringify(was);
  for (const leak of [WORDS, "/work/wrapped-fixture", "wrapped-fixture", home, "00000000-0000-4000"]) assert.equal(text.includes(leak), false, leak);
});

test("a year that is not four digits is 400; no year is the current one", { timeout: 120_000 }, async (t) => {
  await homeWith(t);
  const { api } = await serve(t);
  for (const year of ["26", "2026x", "-2026", "20260", ""]) {
    const refused = await api("GET", `/wrapped?year=${year}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${year}: ${JSON.stringify(refused.body)}`);
  }
  const now = await api("GET", "/wrapped");
  assert.equal(now.status, 200);
  assert.equal(now.body.year, new Date().getFullYear());
});

test("a server with a public URL does not read the machine's files: 403", { timeout: 120_000 }, async (t) => {
  await homeWith(t);
  const { api } = await serve(t, { publicUrl: "https://agentrun.example.test" });
  const refused = await api("GET", "/wrapped");
  assert.deepEqual([refused.status, refused.body.error?.code], [403, "forbidden"], JSON.stringify(refused.body));
});

test("the route is under the token: no Bearer is 401, a wrong one is 401", { timeout: 120_000 }, async (t) => {
  await homeWith(t);
  const { api, baseUrl } = await serve(t);
  assert.equal((await fetch(`${baseUrl}/wrapped`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/wrapped`, { headers: { authorization: "Bearer not-the-token" } })).status, 401);
  assert.equal((await api("GET", "/wrapped")).status, 200);
});

test("a Host that is not a loopback name is 403 here even where the server's own Host check lets it through (an allowed name)", { timeout: 120_000 }, async (t) => {
  await homeWith(t);
  const { baseUrl, token, api } = await serve(t, { allowHosts: ["tunnel.example.test"] });
  const asked = (hostHeader) => new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/wrapped`, { agent: false, headers: { authorization: `Bearer ${token}`, host: hostHeader } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
  const port = new URL(baseUrl).port;
  const rebound = await asked(`tunnel.example.test:${port}`);
  assert.deepEqual([rebound.status, rebound.body.error?.code], [403, "forbidden"], JSON.stringify(rebound.body));
  // Another route answers the same Host: it is this one's check, not the server's.
  const other = await asked(`127.0.0.1:${port}`);
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal((await api("GET", "/wrapped")).status, 200);
});
