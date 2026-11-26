// The import's cache section: each Claude Code, Codex or pi run is analyzed as it is imported (the import package's
// fileCache and sessionBreaks, the same join cacheHome makes), and its run row's metrics keep the numbers alone: the
// cache read and the prompt its hit rate is made of, its breaks by cause, their extra cost and how many are unpriced.
// GET /v2/wrapped sums the year's runs from the store, so no session file is read again for it.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_CAUSES } from "@parcha/agentrun-import";
import { planImport, runImport } from "../dist/import.js";
import { openSqliteStore } from "../dist/store/index.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { at, claudeSession, piSession, sessionId, writeSession } from "./fixtures/import-sessions.mjs";
import { scratch } from "./support.mjs";

const usage = (input, cacheRead, cacheWrite, output) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, service_tier: "standard" });
const zero = () => Object.fromEntries(CACHE_CAUSES.map((cause) => [cause, 0]));

/** A Claude Code session whose second request comes ten minutes after the first (past the 5-minute cache) and reads 95%
 *  less of the cache: one break, idle. */
function brokenSession(home, cwd, n) {
  const base = { sessionId: sessionId(n), cwd, gitBranch: "main", version: "2.1.0", isSidechain: false, userType: "external" };
  const asked = (uuid, parentUuid, minute, content) => ({ ...base, type: "user", uuid, parentUuid, timestamp: at(minute), message: { role: "user", content } });
  const answered = (uuid, parentUuid, minute, id, u) => ({ ...base, type: "assistant", uuid, parentUuid, timestamp: at(minute), message: { id, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done." }], usage: u } });
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return writeSession(join(home, ".claude", "projects", slug, `${sessionId(n)}.jsonl`), [
    asked(`u1-${n}`, null, 0, "Read the file."),
    answered(`a1-${n}`, `u1-${n}`, 1, `msg_1_${n}`, usage(3, 1000, 200, 10)),
    asked(`u2-${n}`, `a1-${n}`, 11, "Now the next one."),
    answered(`a2-${n}`, `u2-${n}`, 11, `msg_2_${n}`, usage(3, 50, 1100, 10)),
  ]);
}

/** A Claude Code session, and a subagent of it, each compacted between two requests a minute apart whose cache read
 *  drops 95%: two breaks, compaction, a cause only the chain the import reads names. */
function compactedSession(home, cwd, n) {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const records = (side, prefix, read) => {
    const base = { sessionId: sessionId(n), cwd, gitBranch: "main", version: "2.1.0", isSidechain: side, userType: "external", ...(side ? { agentId: "a1" } : {}) };
    const u = (uuid, parentUuid, minute, content, extra = {}) => ({ ...base, type: "user", uuid: `${prefix}${uuid}`, parentUuid: parentUuid && `${prefix}${parentUuid}`, timestamp: at(minute), message: { role: "user", content }, ...extra });
    const a = (uuid, parentUuid, minute, k, cacheRead, cacheWrite) => ({ ...base, type: "assistant", uuid: `${prefix}${uuid}`, parentUuid: `${prefix}${parentUuid}`, timestamp: at(minute), message: { id: `msg_${prefix}${k}_${n}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done." }], usage: usage(3, cacheRead, cacheWrite, 10) } });
    return [
      u("u1", null, 0, "Read the file."),
      a("a1", "u1", 1, 1, read, 100),
      { ...base, type: "system", subtype: "compact_boundary", uuid: `${prefix}cb`, parentUuid: null, logicalParentUuid: `${prefix}a1`, timestamp: at(2), content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 1000 } },
      u("cs", "cb", 2, "Summary of the conversation.", { isCompactSummary: true }),
      u("u2", "cs", 2, "Go on."),
      a("a2", "u2", 2, 2, read / 20, read),
    ];
  };
  writeSession(join(home, ".claude", "projects", slug, `${sessionId(n)}.jsonl`), records(false, "", 1000));
  writeSession(join(home, ".claude", "projects", slug, sessionId(n), "subagents", "agent-a1.jsonl"), records(true, "s-", 800));
}

/** A Codex rollout of thread `id` (a subagent's when `parent` is named), one request per step ([uncached input, cache
 *  read]), a minute apart from `minute`. */
function codexRollout(home, cwd, name, id, parent, steps, minute) {
  const stamp = (m) => at(m);
  const records = [
    { timestamp: stamp(minute), type: "session_meta", payload: { id, cwd, timestamp: stamp(minute), model_provider: "openai", ...(parent ? { parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } },
    { timestamp: stamp(minute), type: "turn_context", payload: { model: "gpt-sol-6.1", cwd } },
  ];
  let total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  steps.forEach(([input, cached], k) => {
    const last = { input_tokens: input + cached, cached_input_tokens: cached, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: input + cached + 10 };
    total = Object.fromEntries(Object.keys(total).map((key) => [key, total[key] + last[key]]));
    const m = minute + k;
    records.push(
      { timestamp: stamp(m), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Step ${k}.` }] } },
      { timestamp: stamp(m), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
      { timestamp: stamp(m), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 }, rate_limits: null } },
    );
  });
  return writeSession(join(home, ".codex", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-0${name}-${id}.jsonl`), records);
}

async function importedHome(t, write) {
  const root = await scratch(t);
  const home = join(root, "home");
  const cwd = join(home, "code", "site");
  mkdirSync(cwd, { recursive: true });
  write(home, cwd);
  const options = { home, env: { PATH: "/usr/bin" }, temp: join(root, "tmp") };
  const data = join(root, "agents");
  const writer = await openSqliteStore({ dataDir: data, role: "server" });
  await runImport(writer, await planImport(options), options);
  await writer.close();
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(async () => await store.close());
  const runs = await listRuns(store, {}, ctx);
  return { store, runs, metrics: async (session) => (await store.runs.get(runs.find((r) => r.importedFrom.session === session).id)).metrics };
}

test("an imported Claude Code run keeps its cache: the hit rate's parts, one idle break, and no text", { timeout: 120_000 }, async (t) => {
  const { metrics } = await importedHome(t, (home, cwd) => brokenSession(home, cwd, 1));
  const { cache } = await metrics(sessionId(1));
  assert.ok(cache, "the run's metrics hold its cache");
  assert.deepEqual([cache.read, cache.prompt], [1050, 3 + 1000 + 200 + 3 + 50 + 1100]);
  assert.deepEqual(cache.breaks, { ...zero(), idle: 1 });
  assert.equal(Object.keys(cache.extraCost).length, CACHE_CAUSES.length);
  assert.equal(cache.unpriced + (cache.extraCost.idle > 0 ? 1 : 0), 1, "the break is priced or counted unpriced");
  assert.equal(JSON.stringify(cache).includes("Read the file"), false);
});

test("a run with no break keeps its cache with every cause at 0; a pi run is analyzed too", { timeout: 120_000 }, async (t) => {
  const { metrics } = await importedHome(t, (home, cwd) => {
    claudeSession(home, cwd, 2);
    piSession(home, cwd, 3);
  });
  for (const session of [sessionId(2), sessionId(3)]) {
    const { cache } = await metrics(session);
    assert.ok(cache, `${session}: its metrics hold its cache`);
    assert.deepEqual(cache.breaks, zero(), session);
    assert.ok(cache.prompt >= cache.read, session);
  }
});

test("a compaction is named from the chain the import reads, in the session and in its subagent's own conversation, whose requests are in the hit rate", { timeout: 120_000 }, async (t) => {
  const { metrics } = await importedHome(t, (home, cwd) => compactedSession(home, cwd, 4));
  const { cache } = await metrics(sessionId(4));
  assert.deepEqual(cache.breaks, { ...zero(), compaction: 2 });
  const main = 3 + 1000 + 100 + (3 + 50 + 1000);
  const subagent = 3 + 800 + 100 + (3 + 40 + 800);
  assert.deepEqual([cache.read, cache.prompt], [1000 + 50 + 800 + 40, main + subagent]);
});

test("a Codex subagent's thread that goes on in another rollout is one conversation: the drop across its files is a break", { timeout: 120_000 }, async (t) => {
  const parent = sessionId(5);
  const child = sessionId(6);
  const { metrics } = await importedHome(t, (home, cwd) => {
    codexRollout(home, cwd, "1", parent, undefined, [[1000, 0], [1200, 1000]], 0);
    // The subagent's thread: its first rollout's last request reads 1100 of the cache, its second's first reads 60.
    codexRollout(home, cwd, "2", child, parent, [[1100, 0], [1300, 1100]], 2);
    codexRollout(home, cwd, "3", child, parent, [[1400, 60], [1500, 1350]], 4);
  });
  const { cache } = await metrics(parent);
  assert.deepEqual(cache.breaks, { ...zero(), unknown: 1 });
  assert.equal(cache.read, 1000 + 1100 + 60 + 1350);
});
