// OpenCode under the read pool: its sessions are rows of a database (or JSON storage files), not one file of lines, so
// parseHome reads them on its own thread while the pool's workers read the line sources (pool.ts), Copilot CLI's among
// them. A pooled call gives the totals of one thread on a home that holds OpenCode and Copilot data, its claude-agent
// requests counted once and a copied Copilot shutdown no second time. Synthetic fixtures only.
import assert from "node:assert/strict";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";
import { buildLegacy, buildV2 } from "./fixtures/opencode/fixture.mjs";

const DATA = ".local/share/opencode";
const OLD = "00000000-0000-4000-8000-0000000000b1";
const NEW = "00000000-0000-4000-8000-0000000000b2";
const COPILOT = "00000000-0000-4000-8000-0000000000c1";
const COPIED = "00000000-0000-4000-8000-0000000000c2";

/** A Copilot CLI session event (github/copilot-sdk session-events.ts's shape), its time the i-th second. */
const copilotEvent = (i, type, data) => ({ type, data, id: `p${i}`, parentId: i ? `p${i - 1}` : null, timestamp: at(i) });
/** A shutdown's tokens for one model, its input holding the cache read. */
const copilotMetric = (input, output, cacheRead) => ({ requests: { count: 1, cost: 1 }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } });

/** A home of every source: a 2.x opencode.db and the JSON storage beside it; claude-session-1, the Claude Code session
 *  OpenCode's ses_K ran two claude-agent requests in; a Claude Code session resumed into a second file (a copy); a Codex
 *  thread; a Copilot CLI session of two answers and a shutdown, and an older flat file that copies its events and goes
 *  on (its copied shutdown adds no tokens). */
async function mixedHome(t) {
  const home = await tempHome(t);
  await buildV2(join(home, DATA, "opencode.db"));
  await buildLegacy(join(home, DATA, "storage"));
  const session = "claude-session-1";
  await writeJsonl(claudeFile(home, session), [
    claudeUser({ uuid: "k-u1", text: "Fixture prompt.", i: 0, session }),
    claudeAnswer({ uuid: "k-a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(3, 2), i: 1, session }),
    claudeAnswer({ uuid: "k-a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(4, 1), i: 2, session }),
  ]);
  const question = claudeUser({ uuid: "c-u1", text: "Fixture question.", i: 0, session: OLD });
  const answer = claudeAnswer({ uuid: "c-a1", msg: "msg_c1", req: "req_c1", usage: anthropicUsage(10, 20, 30, 40), i: 1, session: OLD });
  const old = await writeJsonl(claudeFile(home, OLD), [question, answer]);
  const resumed = await writeJsonl(claudeFile(home, NEW), [question, answer, claudeUser({ uuid: "c-u2", text: "Again.", i: 5, session: NEW }), claudeAnswer({ uuid: "c-a2", msg: "msg_c2", req: "req_c2", usage: anthropicUsage(1, 2, 3, 4), i: 6, session: NEW })]);
  await utimes(old, 1_000, 1_000);
  await utimes(resumed, 2_000, 2_000);
  await writeJsonl(codexFile(home), [codexMeta("thread-1"), codexContext(1), codexUser("Fixture question.", 2), codexAnswer("Fixture answer.", 3), codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4)]);
  const state = join(home, ".copilot", "session-state");
  const events = [
    copilotEvent(0, "session.start", { sessionId: COPILOT, version: 1, producer: "copilot-agent", copilotVersion: "1.0.40", startTime: at(0), selectedModel: "claude-sonnet-4.5", context: { cwd: "/work/fixture" } }),
    copilotEvent(1, "user.message", { content: "Fixture question." }),
    copilotEvent(2, "assistant.message", { messageId: "pm-1", model: "claude-sonnet-4.5", content: "Looking." }),
    copilotEvent(3, "assistant.message", { messageId: "pm-2", model: "claude-sonnet-4.5", content: "Done." }),
    copilotEvent(4, "session.shutdown", { shutdownType: "routine", modelMetrics: { "claude-sonnet-4.5": copilotMetric(900, 40, 500) } }),
  ];
  const copilot = await writeJsonl(join(state, COPILOT, "events.jsonl"), events);
  const copied = await writeJsonl(join(state, `${COPIED}.jsonl`), [
    ...events.slice(1),
    copilotEvent(5, "session.resume", { resumeTime: at(5), eventCount: 5, context: { cwd: "/work/fixture" } }),
    copilotEvent(6, "user.message", { content: "Again." }),
    copilotEvent(7, "assistant.message", { messageId: "pm-3", model: "claude-sonnet-4.5", content: "Again done." }),
    copilotEvent(8, "session.shutdown", { shutdownType: "routine", modelMetrics: { "claude-sonnet-4.5": copilotMetric(300, 10, 100) } }),
  ]);
  await utimes(copilot, 1_000, 1_000);
  await utimes(copied, 2_000, 2_000);
  return home;
}

/** `run` with every pool worker it makes watched: the files their reads were of. */
async function watched(run) {
  const files = [];
  const watch = (worker) => {
    worker.on("message", (read) => {
      for (const { locator } of read.ok ? read.sessions : []) files.push(locator.file);
    });
  };
  process.on("worker", watch);
  try {
    return { result: await run(), files };
  } finally {
    process.off("worker", watch);
  }
}

test("a pooled call on a home with OpenCode and Copilot data gives the totals of one thread; OpenCode is read on parseHome's own thread", async (t) => {
  const home = await mixedHome(t);
  const one = await parseHome(home, { catalog: false, env: {}, threads: 1 });
  const by = Object.fromEntries(one.map((row) => [row.id, row]));
  // Every source is in the answer, and ses_K's two claude-agent requests count in claude-session-1 alone.
  assert.deepEqual(new Set(one.map(({ source }) => source)), new Set(["claude-code", "codex", "opencode", "copilot"]));
  assert.deepEqual([by.ses_K.calls, by["claude-session-1"].calls], [2, 2]);
  assert.equal(by[NEW].calls, 1, "the resumed file counts its copy of msg_c1 no second time");
  // Copilot: the shutdown's tokens, less the cache read its input holds; the copy's first shutdown adds none.
  assert.deepEqual([by[COPILOT].calls, by[COPILOT].tokens.input, by[COPILOT].tokens.cacheRead], [2, 400, 500]);
  assert.deepEqual([by[COPIED].calls, by[COPIED].tokens.input, by[COPIED].tokens.output], [1, 200, 10], "the copied events count no second time");
  for (const opts of [{ threads: 2 }, { threads: 3, readAhead: 0 }, { threads: 4, readAhead: 1 << 10 }]) {
    const { result, files } = await watched(() => parseHome(home, { catalog: false, env: {}, ...opts }));
    assert.deepEqual(result, one, JSON.stringify(opts));
    assert.ok(files.length > 0, "the workers read the line sources");
    assert.deepEqual(files.filter((file) => file.includes(`${join(".local", "share", "opencode")}`)), [], "no OpenCode read on a worker");
    assert.ok(files.some((file) => file.includes(join(".copilot", "session-state"))), "Copilot's files read on a worker");
  }
  // OpenCode before Claude Code: the mirrored requests still count once.
  assert.deepEqual(await parseHome(home, { catalog: false, env: {}, threads: 2, sources: ["opencode", "copilot", "codex", "claude-code"] }), one);
});
