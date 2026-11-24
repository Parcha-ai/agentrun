// GET /v2/wrapped: a year of the work under this machine's home, as numbers (wrapped.ts over the import package's
// wrappedHome, read on the import worker), answered only by one owner's server on their own machine. It holds no prompt,
// path or project. Each server here reads the fixture home it is handed (`sessionsHome`), never the runner's HOME.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { keptReads } from "../dist/wrapped.js";
import { agent, follow, serve } from "./support.mjs";

const WORDS = "Fixture prompt, never reported.";
const stamp = (iso) => ({ timestamp: iso, sessionId: "00000000-0000-4000-8000-000000000001", cwd: "/work/wrapped-fixture", isSidechain: false });
const answer = (n, iso, input, output) => ({ ...stamp(iso), type: "assistant", uuid: `a${n}`, requestId: `r${n}`, message: { id: `m${n}`, role: "assistant", model: "claude-fixture-1", content: [{ type: "text", text: "Done." }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } } });

async function homeWith(t) {
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wrapped-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, ".claude", "projects", "-work-wrapped-fixture", "00000000-0000-4000-8000-000000000001.jsonl");
  await mkdir(join(file, ".."), { recursive: true });
  const records = [{ ...stamp("2026-03-02T09:00:00.000Z"), type: "user", uuid: "u1", message: { role: "user", content: WORDS } }, answer(1, "2026-03-02T09:00:10.000Z", 100, 10), answer(2, "2026-03-02T09:00:40.000Z", 200, 20), answer(3, "2025-12-31T23:00:00.000Z", 7, 1)];
  await writeFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return home;
}

test("GET /wrapped reads the year under the home: tokens, days, hours, models, harnesses, sources; nothing of the text", { timeout: 120_000 }, async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  t.after(() => (tz === undefined ? delete process.env.TZ : (process.env.TZ = tz)));
  const home = await homeWith(t);
  const { api, store } = await serve(t, { sessionsHome: { home } });
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

test("a year that is not four digits, or is after this one, is 400; no year is the current one", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api } = await serve(t, { sessionsHome: { home } });
  for (const year of ["26", "2026x", "-2026", "20260", "", "0050", "0000", String(new Date().getFullYear() + 1)]) {
    const refused = await api("GET", `/wrapped?year=${year}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${year}: ${JSON.stringify(refused.body)}`);
  }
  const now = await api("GET", "/wrapped");
  assert.equal(now.status, 200);
  assert.equal(now.body.year, new Date().getFullYear());
});

test("a server with a public URL does not read the machine's files: 403", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api } = await serve(t, { publicUrl: "https://agentrun.example.test", sessionsHome: { home } });
  const refused = await api("GET", "/wrapped");
  assert.deepEqual([refused.status, refused.body.error?.code], [403, "forbidden"], JSON.stringify(refused.body));
});

test("the route is under the token: no Bearer is 401, a wrong one is 401", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api, baseUrl } = await serve(t, { sessionsHome: { home } });
  assert.equal((await fetch(`${baseUrl}/wrapped`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/wrapped`, { headers: { authorization: "Bearer not-the-token" } })).status, 401);
  assert.equal((await api("GET", "/wrapped")).status, 200);
});

test("a Host that is not a loopback name is 403 here even where the server's own Host check lets it through (an allowed name)", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { baseUrl, token, api } = await serve(t, { allowHosts: ["tunnel.example.test"], sessionsHome: { home } });
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

test("the API-only profile refuses it in its own words: 403, not an unknown address", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api } = await serve(t, { apiOnly: true, runner: false, sessionsHome: { home } });
  const refused = await api("GET", "/wrapped");
  assert.deepEqual([refused.status, refused.body.error?.code], [403, "forbidden"], JSON.stringify(refused.body));
});

test("a session file that cannot be read is counted, as a number and no path, not dropped silently and not a failure of the year", { timeout: 120_000, skip: process.getuid?.() === 0 ? "root reads any file" : false }, async (t) => {
  const home = await homeWith(t);
  const clean = (await (await serve(t, { sessionsHome: { home } })).api("GET", "/wrapped?year=2026")).body;
  assert.equal(clean.unread_files, 0);
  const locked = join(home, ".claude", "projects", "-work-wrapped-fixture", "00000000-0000-4000-8000-000000000002.jsonl");
  await writeFile(locked, `${JSON.stringify({ type: "user", uuid: "x", timestamp: "2026-03-02T09:00:00.000Z", sessionId: "00000000-0000-4000-8000-000000000002", cwd: "/work/wrapped-fixture", message: { role: "user", content: "hi" } })}\n`);
  await chmod(locked, 0);
  t.after(() => chmod(locked, 0o600).catch(() => {}));
  const { api } = await serve(t, { sessionsHome: { home } });
  const { status, body } = await api("GET", "/wrapped?year=2026");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.unread_files, 1);
  assert.equal(body.requests, 2, "the rest of the year is read");
  assert.equal(JSON.stringify(body).includes("00000000-0000-4000-8000-000000000002"), false, "no path or id");
});

test("a server that takes two API tokens does not read the machine's files for either holder: 403", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api } = await serve(t, { token: "a".repeat(40), tokens: [{ id: "second", token: "b".repeat(40) }], runner: false, sessionsHome: { home } });
  const refused = await api("GET", "/wrapped");
  assert.deepEqual([refused.status, refused.body.error?.code], [403, "forbidden"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /takes 2 API tokens/);
});

test("a test's server never reads the runner's HOME: support hands it an empty home, so a sweep of every GET route stays short", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const was = process.env.HOME;
  process.env.HOME = home;
  t.after(() => (process.env.HOME = was));
  const { api } = await serve(t);
  const { status, body } = await api("GET", "/wrapped?year=2026");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual([body.requests, body.sessions], [0, 0], "the fixture under HOME is not read");
});

test("a read past the wait answers 503 with a retry while it goes on; its year then comes at once, kept", { timeout: 120_000 }, async (t) => {
  const home = await homeWith(t);
  const { api } = await serve(t, { sessionsHome: { home }, wrappedWaitMs: 0 });
  // No wait: the worker has not even started when the answer is due.
  const early = await api("GET", "/wrapped?year=2026");
  assert.deepEqual([early.status, early.body.error?.code, early.body.error?.retry_after_ms], [503, "unavailable", 5_000], JSON.stringify(early.body));
  let body;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) {
    const asked = await api("GET", "/wrapped?year=2026");
    if (asked.status === 200) {
      body = asked.body;
      break;
    }
    assert.equal(asked.status, 503, JSON.stringify(asked.body));
  }
  assert.equal(body?.requests, 2, "the read went on and ended");
  // Kept: with no wait at all, only a read already done can answer 200.
  assert.equal((await api("GET", "/wrapped?year=2026")).status, 200);
});

test("Wrapped prices at serve's catalog: a model serve lists and pi-ai's built-in list does not is priced, not unpriced", { timeout: 120_000 }, async (t) => {
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wrapped-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, ".pi", "agent", "sessions", "--work-fixture--", "2026-03-02T09-00-00_pi-free.jsonl");
  await mkdir(join(file, ".."), { recursive: true });
  const stampAt = (s) => `2026-03-02T09:00:0${s}.000Z`;
  const records = [
    { type: "session", id: "pi-free", cwd: "/work/fixture", timestamp: stampAt(0) },
    { type: "message", timestamp: stampAt(1), message: { role: "user", content: "hi", timestamp: Date.parse(stampAt(1)) } },
    // serve's ADDED_MODELS (local-models.ts): an OpenRouter model at $0 that pi-ai's built-in catalog does not list.
    { type: "message", timestamp: stampAt(2), message: { role: "assistant", provider: "openrouter", model: "inclusionai/ling-3.2-flash:free", content: [{ type: "text", text: "Done." }], stopReason: "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, timestamp: Date.parse(stampAt(2)) } },
  ];
  await writeFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const { api } = await serve(t, { sessionsHome: { home } });
  const { status, body } = await api("GET", "/wrapped?year=2026");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.models.map((m) => [m.model, m.requests]), [["openrouter/inclusionai/ling-3.2-flash:free", 1]]);
  assert.deepEqual([body.unpriced_requests, body.cost_usd], [0, 0], "priced at its $0 entry");
});

// keptReads over reads the test settles by hand, on a mocked clock (Date only: setImmediate stays real).
function keptOver() {
  const calls = [];
  const kept = keptReads((year) => new Promise((resolve, reject) => void calls.push({ year, resolve, reject })));
  return { calls, kept };
}
const READ = { wrapped: {}, unread: 0 };
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("keptReads shares a read still going however long it takes, keeps the current year a minute after it ends, then reads again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 5, 1).getTime() });
  const { calls, kept } = keptOver();
  const first = kept(2026);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(kept(2026), first, "a read still going is shared, past any minute");
  assert.equal(calls.length, 1);
  calls[0].resolve(READ);
  await first;
  await settled();
  t.mock.timers.tick(59_000);
  assert.equal(kept(2026), first, "kept within the minute after it ended");
  t.mock.timers.tick(2_000);
  assert.notEqual(kept(2026), first, "read again past the minute");
  assert.deepEqual(calls.map((call) => call.year), [2026, 2026]);
});

test("keptReads keeps a year already over until the server stops, and reads each year once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 5, 1).getTime() });
  const { calls, kept } = keptOver();
  const past = kept(2025);
  calls[0].resolve(READ);
  await past;
  await settled();
  t.mock.timers.tick(30 * 24 * 3_600_000);
  assert.equal(kept(2025), past);
  kept(2024);
  assert.deepEqual(calls.map((call) => call.year), [2025, 2024]);
});

test("keptReads drops a read that failed: the next ask reads again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 5, 1).getTime() });
  const { calls, kept } = keptOver();
  const failed = kept(2025);
  calls[0].reject(new Error("the worker ended"));
  await assert.rejects(failed, /the worker ended/);
  await settled();
  const again = kept(2025);
  assert.notEqual(again, failed);
  assert.equal(calls.length, 2);
  calls[1].resolve(READ);
  assert.equal(await again, READ);
});
