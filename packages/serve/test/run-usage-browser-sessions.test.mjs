// A run's browser sessions on GET /runs/{run_id}/usage (browser-sessions.ts): one record per session, its provider's id,
// when this server opened and let it go, the seconds charged for it, and the provider's own record of it read once at
// its release (BrowserComputerProvider.sessionUsage). The writer and the reader over synthetic records, then the real
// server and runner with the faux browser (test/fixtures/faux-browser.mjs); no network, no vendor account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_SESSION_OPEN, BROWSER_CHARGED } from "../dist/browser-cost.js";
import { BROWSER_SESSION_ENDED, browserSessionsOf, sessionEnds } from "../dist/browser-sessions.js";
import { agent, follow, serve, withEnv } from "./support.mjs";

let id = 0;
const e = (kind, data) => ({ id: String(++id), conversationId: 1, kind, data });
const released = (tag, resourceId) => ({ tag, resourceId, createdAt: "2026-11-19T10:00:00.000Z", endedAt: "2026-11-19T10:01:31.000Z", releaseReason: "close", provider: "browserbase" });
/** The writer's commits, as the root's entries they append. */
function journal() {
  const entries = [];
  const commit = async (change) => change({ appendEntry: async (conversationId, entry) => void entries.push({ id: String(++id), conversationId, ...entry }) });
  return { entries, commit };
}

test("a session's end is written once, with the provider's record read at its release", async () => {
  const { entries, commit } = journal();
  const asked = [];
  const write = sessionEnds({ usage: async (sid) => (asked.push(sid), { startedAt: "2026-11-19T10:00:01.000Z", endedAt: "2026-11-19T10:01:29.000Z", proxyBytes: 2048 }), commit });
  await write(released("s1", "sess_9"), 4);
  await write(released("s1", "sess_9"), 4); // pi-browser tells a release at least once
  assert.deepEqual(asked, ["sess_9"], "read once");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, BROWSER_SESSION_ENDED);
  assert.deepEqual(entries[0].data, {
    tag: "s1", conversation: 4, provider: "browserbase", provider_session_id: "sess_9", started_at: "2026-11-19T10:00:00.000Z", ended_at: "2026-11-19T10:01:31.000Z", release_reason: "close",
    provider_record: { started_at: "2026-11-19T10:00:01.000Z", ended_at: "2026-11-19T10:01:29.000Z", proxy_bytes: 2048 }, provider_record_status: "read",
  });
});

test("no record from the provider is said, never a record of zeros: none offered, unknown session, a failed or late read, no session made", async () => {
  const cases = [
    [{ usage: undefined }, "sess_1", "not_offered"],
    [{ usage: async () => undefined }, "sess_1", "not_found"],
    [{ usage: async () => { throw new Error("503"); } }, "sess_1", "failed"],
    [{ usage: () => new Promise(() => {}), timeoutMs: 20 }, "sess_1", "failed"],
    [{ usage: async () => assert.fail("no session to read") }, null, "no_session"],
  ];
  for (const [options, resourceId, status] of cases) {
    const { entries, commit } = journal();
    await sessionEnds({ ...options, commit })(released("s", resourceId), 1);
    assert.deepEqual([entries[0].data.provider_record, entries[0].data.provider_record_status], [null, status], status);
  }
});

test("an end the journal could not take is said in the log and tried again at the next telling", async () => {
  const lines = [];
  let fail = true;
  const { entries, commit } = journal();
  const write = sessionEnds({ usage: undefined, commit: async (change) => { if (fail) throw new Error("store closed"); return commit(change); }, log: (line) => lines.push(line) });
  await write(released("s", "sess_1"), 1);
  assert.equal(entries.length, 0);
  assert.match(lines[0], /not recorded/);
  fail = false;
  await write(released("s", "sess_1"), 1);
  assert.equal(entries.length, 1);
});

test("the reader: a session per tag in the order opened, its charged seconds summed, its first end its end; one with no end yet has nulls", () => {
  const entries = [
    e(BROWSER_SESSION_OPEN, { tag: "a", conversation: 2, provider: "browserbase", held_usd: null }),
    e(BROWSER_CHARGED, { tool: "browser", charged_by: "browserbase", seconds: 12.5, tag: "a" }),
    e(BROWSER_SESSION_OPEN, { tag: "b", conversation: 3, provider: "browserbase", held_usd: null }),
    e(BROWSER_CHARGED, { tool: "browser", charged_by: "browserbase", seconds: 47.5, tag: "a" }),
    e(BROWSER_SESSION_ENDED, { tag: "a", provider: "browserbase", provider_session_id: "sess_1", started_at: "2026-11-19T10:00:00.000Z", ended_at: "2026-11-19T10:01:00.000Z", release_reason: "tool", provider_record: { started_at: "2026-11-19T10:00:01.000Z", ended_at: "2026-11-19T10:00:59.000Z", proxy_bytes: 10 }, provider_record_status: "read" }),
    e(BROWSER_SESSION_ENDED, { tag: "a", provider: "browserbase", provider_session_id: "sess_other", provider_record_status: "failed" }),
  ];
  assert.deepEqual(browserSessionsOf(entries), [
    { provider: "browserbase", tag: "a", provider_session_id: "sess_1", started_at: "2026-11-19T10:00:00.000Z", ended_at: "2026-11-19T10:01:00.000Z", release_reason: "tool", charged_seconds: 60, provider_record: { started_at: "2026-11-19T10:00:01.000Z", ended_at: "2026-11-19T10:00:59.000Z", proxy_bytes: 10 }, provider_record_status: "read" },
    { provider: "browserbase", tag: "b", provider_session_id: null, started_at: null, ended_at: null, release_reason: null, charged_seconds: null, provider_record: null, provider_record_status: null },
  ]);
  assert.deepEqual(browserSessionsOf([]), []);
});

const KEYS = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const FAUX = new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname;
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;

async function browsed(t, record) {
  withEnv(t, { ...KEYS, FAUX_BROWSER_SESSION_USAGE: record }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER", "FAUX_BROWSER_SESSION_USAGE"]);
  const { api } = await serve(t, { faux: FAUX, fauxBrowser: FAUX_BROWSER });
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page 2 times." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 60_000 });
  const usage = await api("GET", `/runs/${started.body.run_id}/usage`);
  assert.equal(usage.status, 200, JSON.stringify(usage.body));
  return usage.body;
}

test("through the API: a provider that keeps a record of its sessions has it read at the release and given beside the server's own", { timeout: 120_000 }, async (t) => {
  const usage = await browsed(t, "record");
  assert.equal(usage.browser_sessions.length, 1, JSON.stringify(usage.browser_sessions));
  const [session] = usage.browser_sessions;
  assert.equal(session.provider_record_status, "read");
  assert.deepEqual(session.provider_record, { started_at: "2026-11-19T10:00:00.000Z", ended_at: "2026-11-19T10:01:30.000Z", proxy_bytes: 4096 });
  assert.equal(typeof session.provider_session_id, "string");
  // The server's own measure stays its own: the line's seconds are the session's charged seconds, not the provider's 90.
  const line = usage.lines.find((one) => one.meter === "browser_time");
  assert.equal(session.charged_seconds, line.quantity);
});

test("through the API: a provider record that can't be read is `failed`, and the run's lines are as they were", { timeout: 120_000 }, async (t) => {
  const usage = await browsed(t, "fail");
  const [session] = usage.browser_sessions;
  assert.deepEqual([session.provider_record, session.provider_record_status], [null, "failed"]);
  assert.ok(session.ended_at, "its end is still recorded");
  assert.equal(usage.lines.find((one) => one.meter === "browser_time").usd, 0.002);
});
