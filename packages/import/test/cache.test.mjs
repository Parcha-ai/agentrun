// The cache analyzer: each session's hit rate, and each turn whose cache read dropped more than 80% against the turn
// before it, with the cause the transcript shows. Every session here is synthetic: ids, prompts and counts are made up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, utimes } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeCache, CACHE_CAUSES, CACHE_SOURCES, cacheHome, cacheTotals, catalogOf, READERS, readSession } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, jsonl, claudeFile, claudeUser, codexAnswer, codexFile, codexMeta, codexUser, openaiUsage, piFile, piMeta, SESSION, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const PROMPT = "Fixture words the analyzer must never hand back.";

/** A Claude Code user record and its answer, chained to `parent`. A step: `read`, `write` (cache), `input`, `long` (the 1h
 *  part of `write`), `i` (the answer's second), `model`, `sidechain`. */
function exchange(k, step, parent) {
  const { read, write = 0, input = 5, long, i, model, sidechain = false, text = `${PROMPT} ${k}` } = step;
  const user = { ...claudeUser({ uuid: `u${k}`, text, i: i - 1, sidechain }), parentUuid: parent };
  const answer = { ...claudeAnswer({ uuid: `a${k}`, msg: `msg_${k}`, req: `req_${k}`, usage: anthropicUsage(input, 10, read, write, long), i, model, sidechain }), parentUuid: user.uuid };
  return [user, answer];
}

/** A linear Claude Code conversation of `steps`, each answering the one before. */
function linear(steps, from = 0, parent = null) {
  const out = [];
  steps.forEach((step, n) => {
    const records = exchange(from + n, step, parent);
    out.push(...records);
    parent = records[1].uuid;
  });
  return out;
}

async function claude(t, records) {
  const home = await tempHome(t);
  return readSession(await writeJsonl(claudeFile(home), records), "claude-code", { chain: true });
}

const analyzed = async (t, records, options = { catalog: false }) => analyzeCache(await claude(t, records), options);
const causes = (report) => report.breaks.map(({ turn, cause }) => [turn, cause]);

test("the causes come in the order the analyzer tries them", () => {
  assert.deepEqual(CACHE_CAUSES, ["model", "idle", "compaction", "edited", "sidechain", "unknown"]);
});

test("a session whose cache read holds has no break, and its hit rate is the read over the whole prompt", async (t) => {
  const report = await analyzed(t, linear([{ read: 0, write: 1000, i: 10 }, { read: 1000, write: 100, i: 20 }, { read: 1100, write: 100, i: 30 }]));
  assert.deepEqual(report.breaks, []);
  // input 5 a turn: 2100 read of (15 + 2100 + 1200).
  assert.equal(report.hitRate, Math.round((2100 / 3315) * 1e4) / 1e4);
});

test("the first turn is never a break, whatever it reads; a later drop is", async (t) => {
  const report = await analyzed(t, linear([{ read: 0, write: 5000, i: 10 }, { read: 5000, i: 20 }, { read: 100, write: 4900, i: 30 }]));
  assert.deepEqual(causes(report), [[3, "unknown"]]);
});

test("a drop of exactly 80% is no break; one token more is", async (t) => {
  const exact = await analyzed(t, linear([{ read: 1000, i: 10 }, { read: 200, write: 800, i: 20 }]));
  assert.deepEqual(exact.breaks, []);
  const over = await analyzed(t, linear([{ read: 1000, i: 10 }, { read: 199, write: 801, i: 20 }]));
  assert.deepEqual(causes(over), [[2, "unknown"]]);
  assert.equal(over.breaks[0].dropPct, 80.1);
  assert.equal(over.breaks[0].at, Date.parse(at(20)));
});

test("model: the turn ran on another model than the one before, which outranks an idle gap", async (t) => {
  const report = await analyzed(t, linear([{ read: 1000, i: 10 }, { read: 100, i: 20, model: "claude-fixture-2" }, { read: 1000, i: 30, model: "claude-fixture-2" }, { read: 100, i: 3000 }]));
  assert.deepEqual(causes(report), [
    [2, "model"],
    [4, "model"],
  ]);
});

test("idle: past the 5-minute cache, or the hour when the cache was written for one; it outranks a compaction", async (t) => {
  const short = await analyzed(t, linear([{ read: 1000, i: 10 }, { read: 100, i: 311 }]));
  assert.deepEqual(causes(short), [[2, "idle"]]);
  const within = await analyzed(t, linear([{ read: 1000, i: 10 }, { read: 100, i: 309 }]));
  assert.deepEqual(causes(within), [[2, "unknown"]]);
  // The last turn that wrote the cache wrote it for an hour: 10 minutes is no idle gap, 61 are.
  const long = await analyzed(t, linear([{ read: 1000, write: 500, long: 500, i: 10 }, { read: 1500, i: 20 }, { read: 100, i: 620 }, { read: 1000, write: 500, long: 500, i: 630 }, { read: 100, i: 4300 }]));
  assert.deepEqual(causes(long), [
    [3, "unknown"],
    [5, "idle"],
  ]);
  const records = linear([{ read: 1000, i: 10 }]);
  records.push(...compaction("a0", 20), ...linear([{ read: 100, i: 400 }], 1, "cs"));
  assert.deepEqual(causes(await analyzed(t, records)), [[2, "idle"]]);
});

/** Claude Code's compaction: a boundary that starts a new chain, and the summary the conversation goes on from. */
const compaction = (logical, i) => [
  { type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: logical, sessionId: SESSION, isSidechain: false, timestamp: at(i), content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 1000 } },
  { ...claudeUser({ uuid: "cs", text: `${PROMPT} summary`, i: i + 1 }), parentUuid: "cb", isCompactSummary: true },
];

test("compaction: a compact boundary or summary since the turn before; its new chain is no edit", async (t) => {
  const records = linear([{ read: 1000, i: 10 }]);
  records.push(...compaction("a0", 20), ...linear([{ read: 100, write: 300, i: 30 }], 1, "cs"));
  assert.deepEqual(causes(await analyzed(t, records)), [[2, "compaction"]]);
  // A summary alone (an older file, no boundary) is one too.
  const summary = linear([{ read: 1000, i: 10 }]);
  summary.push({ ...claudeUser({ uuid: "cs", text: `${PROMPT} summary`, i: 20 }), parentUuid: "a0", isCompactSummary: true }, ...linear([{ read: 100, i: 30 }], 1, "cs"));
  assert.deepEqual(causes(await analyzed(t, summary)), [[2, "compaction"]]);
});

test("edited: the prompt leaves the last turn's chain at an earlier message, named by its index and never its text", async (t) => {
  // u0 a0 u1 a1, then u2 answers a0: the prompt is u0 a0 u2, and differs from the last turn's at index 2.
  const records = linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]);
  records.push(...linear([{ read: 100, i: 30 }], 2, "a0"));
  const report = await analyzed(t, records);
  assert.deepEqual(causes(report), [[3, "edited"]]);
  assert.equal(report.breaks[0].diverged, 2);
  // The first message rewritten: a new chain of the same side, which differs at index 0.
  const first = linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]);
  first.push(...linear([{ read: 100, i: 30, text: `${PROMPT} again` }], 2, null));
  const rewritten = await analyzed(t, first);
  assert.deepEqual(causes(rewritten), [[3, "edited"]]);
  assert.equal(rewritten.breaks[0].diverged, 0);
  // The same words sent again from the same place: the prompt matches through them and differs after.
  const resent = linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]);
  resent.push(...linear([{ read: 100, i: 30, text: `${PROMPT} 1` }], 2, "a0"));
  assert.equal((await analyzed(t, resent)).breaks[0].diverged, 3);
  for (const each of [report, rewritten]) assert.ok(!JSON.stringify(each).includes(PROMPT));
});

test("sidechain: the turn opens a sidechain after a main-chain turn; a model change outranks it", async (t) => {
  const records = linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]);
  records.push(...linear([{ read: 100, i: 30, sidechain: true }], 2, null));
  assert.deepEqual(causes(await analyzed(t, records)), [[3, "sidechain"]]);
  const switched = linear([{ read: 1000, i: 10 }]);
  switched.push(...linear([{ read: 100, i: 20, sidechain: true, model: "claude-fixture-2" }], 1, null));
  assert.deepEqual(causes(await analyzed(t, switched)), [[2, "model"]]);
});

test("rewritten and extraCost: the lost read paid again as a write or uncached input, at the turn's model's prices", async (t) => {
  const catalog = catalogOf([{ id: "claude-fixture-1", provider: "anthropic", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }]);
  const calculateCost = ({ cost }, u) => ({ total: (u.input * cost.input + u.output * cost.output + u.cacheRead * cost.cacheRead + u.cacheWrite * cost.cacheWrite) / 1e6 });
  const report = await analyzed(t, linear([{ read: 10_000, i: 10 }, { read: 1000, write: 8000, input: 500, i: 20 }]), { catalog, calculateCost });
  assert.equal(report.breaks.length, 1);
  const [found] = report.breaks;
  // 9000 read lost, 8500 of it paid again (8000 written, 500 uncached): (8000 * 3.75 + 500 * 3 - 8500 * 0.3) / 1e6.
  assert.equal(found.rewritten, 8500);
  assert.equal(found.extraCost, 0.02895);
  // A model no catalog lists, or no catalog: unknown.
  const unlisted = await analyzed(t, linear([{ read: 10_000, i: 10 }, { read: 1000, write: 8000, i: 20, model: "claude-unlisted" }]), { catalog, calculateCost });
  assert.equal(unlisted.breaks[0].extraCost, null);
});

test("a session read without its chain is told apart from one with: chain is absent, and no turn text is in the chain", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), linear([{ read: 1000, i: 10 }]));
  assert.equal((await readSession(file, "claude-code")).chain, undefined);
  const session = await readSession(file, "claude-code", { chain: true });
  assert.deepEqual(
    session.chain.map(({ id, parent, request }) => [id, parent, request]),
    [
      ["u0", undefined, undefined],
      ["a0", "u0", 0],
    ],
  );
  assert.ok(!JSON.stringify(session.chain).includes(PROMPT));
});

const ctx = (i, model = "gpt-fixture") => ({ type: "turn_context", timestamp: at(i), payload: { model, effort: "high", cwd: "/work/fixture" } });
const tokens = (input, cached, total, i) => ({ type: "event_msg", timestamp: at(i), payload: { type: "token_count", info: { last_token_usage: openaiUsage(input, cached, 10), total_token_usage: { total_tokens: total } } } });

test("a Codex session: a compacted record, a turn_context's new model, and a drop with neither", async (t) => {
  const home = await tempHome(t);
  const steps = [
    [1000, 0],
    [1200, 1000],
    ["compacted"],
    [1300, 100],
    [1400, 1200],
    ["gpt-fixture-2"],
    [1500, 50],
    [1600, 1400],
    [1700, 10],
  ];
  const records = [codexMeta("thread-1"), ctx(1)];
  let i = 2;
  let total = 0;
  for (const [input, cached] of steps) {
    if (input === "compacted") records.push({ type: "compacted", timestamp: at(i++), payload: { message: "", replacement_history: [] } }, ctx(i++));
    else if (typeof input === "string") records.push(ctx(i++, input));
    else records.push(codexUser(`${PROMPT} ${i}`, i++), codexAnswer("Fixture answer.", i++), tokens(input, cached, (total += input), i++));
  }
  const session = await readSession(await writeJsonl(codexFile(home), records), "codex", { chain: true });
  const report = await analyzeCache(session, { catalog: false });
  assert.deepEqual(causes(report), [
    [3, "compaction"],
    [5, "model"],
    [7, "unknown"],
  ]);
  // OpenAI's input holds its cached part: 3760 read of 9700.
  assert.equal(report.hitRate, Math.round((3760 / 9700) * 1e4) / 1e4);
  // Codex writes no cache: the 900 read lost is paid again as uncached input.
  assert.equal(report.breaks[0].rewritten, 900);
});

test("pi: its id/parentId chain names an edit; it writes no compaction or sidechain record", async (t) => {
  const home = await tempHome(t);
  const message = (id, parentId, i, role, extra) => ({ type: "message", id, parentId, timestamp: at(i), message: { role, timestamp: Date.parse(at(i)), ...extra } });
  const user = (id, parentId, i) => message(id, parentId, i, "user", { content: `${PROMPT} ${id}` });
  const answer = (id, parentId, i, cacheRead) => message(id, parentId, i, "assistant", { provider: "fixture", model: "fixture-model", content: [{ type: "text", text: "Done." }], stopReason: "stop", usage: { input: 5, output: 10, cacheRead, cacheWrite: 0 } });
  const records = [piMeta(), user("p1", null, 1), answer("p2", "p1", 2, 1000), user("p3", "p2", 3), answer("p4", "p3", 4, 1100), user("p5", "p2", 5), answer("p6", "p5", 6, 100)];
  const session = await readSession(await writeJsonl(piFile(home), records), "pi", { chain: true });
  const report = await analyzeCache(session, { catalog: false });
  assert.deepEqual(causes(report), [[3, "edited"]]);
  assert.equal(report.breaks[0].diverged, 2);
});

test("cacheTotals counts the breaks and sums their priced extra cost by cause, every cause there", () => {
  const totals = cacheTotals([
    { breaks: [{ cause: "idle", extraCost: 0.1 }, { cause: "idle", extraCost: 0.2 }, { cause: "edited", extraCost: null }] },
    { breaks: [] },
  ]);
  assert.deepEqual(totals, {
    sessions: 2,
    breaks: { model: 0, idle: 2, compaction: 0, edited: 1, sidechain: 0, unknown: 0 },
    extraCost: { model: 0, idle: 0.3, compaction: 0, edited: 0, sidechain: 0, unknown: 0 },
    unpriced: 1,
  });
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const RESUMED = "00000000-0000-4000-8000-000000000002";

test("--cache prints a line per session, keyed as --known-answer keys them, then the totals: numbers and causes only", async (t) => {
  const home = await tempHome(t);
  // A session with an edit, and its subagent, whose own conversation drops at its second turn.
  const main = linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]);
  main.push(...linear([{ read: 100, i: 30 }], 2, "a0"));
  const original = await writeJsonl(claudeFile(home), main);
  await utimes(original, new Date(at(0)), new Date(at(0)));
  await writeJsonl(subagentFile(home), linear([{ read: 1000, i: 40, sidechain: true }, { read: 100, i: 50, sidechain: true }], 10));
  // A session resumed from it: its file opens with the first exchange copied, then its own first turn reads little. The
  // copies are the first file's: this one's first turn is its turn 1, no break.
  await writeJsonl(claudeFile(home, RESUMED), [...main.slice(0, 2).map((record) => ({ ...record, sessionId: SESSION })), ...linear([{ read: 50, write: 1000, i: 60 }], 20, "a0").map((record) => ({ ...record, sessionId: RESUMED }))]);
  const records = [codexMeta("thread-1"), ctx(1)];
  let total = 0;
  for (const [n, [input, cached]] of [[1000, 0], [1200, 1000], [1300, 100]].entries()) {
    if (n === 2) records.push({ type: "compacted", timestamp: at(20), payload: { message: "", replacement_history: [] } });
    records.push(codexUser(`${PROMPT} ${n}`, 10 * n + 2), codexAnswer("Fixture answer.", 10 * n + 3), tokens(input, cached, (total += input), 10 * n + 4));
  }
  await writeJsonl(codexFile(home), records);

  const result = run(home, "--cache");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const totals = lines.pop();
  const known = run(home, "--known-answer");
  assert.equal(known.status, 0, known.stderr);
  assert.deepEqual(
    lines.map(({ key }) => key),
    known.stdout.trim().split("\n").map((line) => JSON.parse(line).key),
  );
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), ["key", "source", "hitRate", "breaks"]);
    for (const found of line.breaks) assert.deepEqual(Object.keys(found), ["turn", "at", "dropPct", "rewritten", "extraCost", "cause", ...("subagent" in found ? ["subagent"] : [])]);
  }
  const by = Object.fromEntries(lines.map((line) => [line.breaks.map(({ cause, turn, subagent }) => `${cause}@${turn}${subagent ? `/${subagent}` : ""}`).join(",") || "none", line]));
  assert.deepEqual(Object.keys(by).sort(), ["compaction@3", "edited@3,unknown@2/1", "none"]);
  assert.equal(by.none.source, "claude-code");
  assert.equal(by["compaction@3"].source, "codex");
  assert.deepEqual(totals, { totals: { sessions: 3, breaks: { model: 0, idle: 0, compaction: 1, edited: 1, sidechain: 0, unknown: 1 }, extraCost: { model: 0, idle: 0, compaction: 0, edited: 0, sidechain: 0, unknown: 0 }, unpriced: 3 } });
  for (const leak of [PROMPT, "Fixture answer", "/work/fixture", home, SESSION, RESUMED, "thread-1", "u0", "a0"]) assert.ok(!result.stdout.includes(leak), `prints ${leak}`);
});

test("--cache and --known-answer are one output each: both, or neither, is a usage error", async (t) => {
  const home = await tempHome(t);
  assert.equal(run(home, "--cache", "--known-answer").status, 2);
  assert.equal(run(home).status, 2);
  const empty = run(home, "--cache");
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { totals: { sessions: 0, breaks: { model: 0, idle: 0, compaction: 0, edited: 0, sidechain: 0, unknown: 0 }, extraCost: { model: 0, idle: 0, compaction: 0, edited: 0, sidechain: 0, unknown: 0 }, unpriced: 0 } });
});

test("the analyzer reads the sources that write a chain, and refuses another before reading a file", async (t) => {
  const home = await tempHome(t);
  assert.deepEqual(CACHE_SOURCES, ["claude-code", "codex", "pi"]);
  // OpenCode's claude-agent requests mirror a Claude Code session's: analyzed, their breaks would count twice.
  await assert.rejects(cacheHome(home, { sources: ["claude-code", "opencode"], catalog: false }), (error) => error instanceof RangeError && /not opencode$/.test(error.message));
  const cli = run(home, "--cache", "--sources", "opencode");
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /^unknown source: opencode\n/);
  // With no --sources, --cache reads CACHE_SOURCES alone: a refused source would exit 2.
  assert.equal(run(home, "--cache").status, 0);
});

test("a cursor read with a chain goes on with it; one read without is no place to go on from", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), linear([{ read: 1000, i: 10 }]));
  const reader = READERS["claude-code"];
  const first = await reader.read({ file }, undefined, { chain: true });
  await appendFile(file, jsonl(linear([{ read: 100, i: 20 }], 1, "a0")));
  const next = await reader.read({ file }, first.cursor, { chain: true });
  assert.equal(next.resumed, true);
  assert.deepEqual(next.sessions[0].session.chain.map(({ id }) => id), ["u0", "a0", "u1", "a1"]);
  const plain = await reader.read({ file }, undefined, {});
  const after = await reader.read({ file }, plain.cursor, { chain: true });
  assert.equal(after.resumed, false);
  assert.equal(after.sessions[0].session.chain.length, 4);
});

/** A Codex rollout of `steps` ([input, cached] each, from second `i`), its file named for `name`; `id` its thread. */
async function rollout(home, name, id, steps, i, model = "gpt-fixture") {
  const records = [codexMeta(id), ctx(i++, model)];
  let total = 0;
  for (const [input, cached] of steps) records.push(codexUser(`${PROMPT} ${i}`, i++), codexAnswer("Fixture answer.", i++), tokens(input, cached, (total += input), i++));
  return writeJsonl(codexFile(home, `rollout-2026-01-01T00-00-0${name}-fixture.jsonl`), records);
}

test("--cache compares a session's files across their boundary, in the import's order, its turns counted on", async (t) => {
  const home = await tempHome(t);
  // One thread in two rollouts: the first file's last turn reads 1000, the second's first reads 50.
  await rollout(home, "1", "thread-1", [[1000, 0], [1200, 1000]], 1);
  await rollout(home, "2", "thread-1", [[1300, 50], [1400, 1250]], 30);
  const result = run(home, "--cache", "--sources", "codex");
  assert.equal(result.status, 0, result.stderr);
  const [line, totals] = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
  assert.deepEqual(line.breaks.map(({ turn, cause, dropPct }) => [turn, cause, dropPct]), [[3, "unknown", 95]]);
  assert.equal(totals.totals.sessions, 1);
  // A model change or an idle gap at the boundary is named as within a file.
  const idle = await tempHome(t);
  await rollout(idle, "1", "thread-1", [[1000, 0], [1200, 1000]], 1);
  await rollout(idle, "2", "thread-1", [[1300, 50]], 1000);
  assert.deepEqual(JSON.parse(run(idle, "--cache", "--sources", "codex").stdout.split("\n")[0]).breaks.map(({ turn, cause }) => [turn, cause]), [[3, "idle"]]);
});

test("--cache never compares two sessions: a thread's first turn is its turn 1 whatever another read last", async (t) => {
  const home = await tempHome(t);
  await rollout(home, "1", "thread-1", [[1000, 0], [1200, 1000]], 1);
  await rollout(home, "2", "thread-2", [[1300, 50], [1400, 1250]], 30);
  const result = run(home, "--cache", "--sources", "codex");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(lines.length, 3);
  for (const line of lines.slice(0, 2)) assert.deepEqual(line.breaks, []);
});

test("a moved session's copy of an old compaction is no evidence for its boundary break; a compaction of its own is", async (t) => {
  // The session in its first folder: a compaction, then two turns. Moved, its file in the second folder copies all of
  // that (the same uuids), then goes on with a turn that reads little.
  const first = linear([{ read: 1000, i: 10 }]);
  first.push(...compaction("a0", 20), ...linear([{ read: 1000, i: 30 }, { read: 1100, i: 40 }], 1, "cs"));
  const cases = [
    ["copied only", [], "a2", "unknown"],
    ["compacted again after the move", [{ ...compaction("a2", 45)[0], uuid: "cb2" }, { ...compaction("a2", 45)[1], uuid: "cs2", parentUuid: "cb2" }], "cs2", "compaction"],
  ];
  for (const [name, own, parent, cause] of cases) {
    const home = await tempHome(t);
    const earlier = await writeJsonl(claudeFile(home, SESSION, "-work-a"), first);
    await utimes(earlier, new Date(at(0)), new Date(at(0)));
    await writeJsonl(claudeFile(home, SESSION, "-work-b"), [...first, ...own, ...linear([{ read: 50, write: 1000, i: 50 }], 3, parent)]);
    const result = run(home, "--cache", "--sources", "claude-code");
    assert.equal(result.status, 0, result.stderr);
    const [line] = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
    assert.deepEqual(line.breaks.map(({ turn, cause }) => [turn, cause]), [[4, cause]], name);
  }
});

test("a compaction after the first file's last turn is evidence for the boundary break, though the next file holds only its copy", async (t) => {
  // The session in its first folder: two turns, then a compaction. Moved, its file in the second folder copies all of it
  // (the compaction too, the same uuids) and goes on from the summary with a turn that reads little.
  const first = [...linear([{ read: 1000, i: 10 }, { read: 1100, i: 20 }]), ...compaction("a1", 30)];
  const home = await tempHome(t);
  const earlier = await writeJsonl(claudeFile(home, SESSION, "-work-a"), first);
  await utimes(earlier, new Date(at(0)), new Date(at(0)));
  await writeJsonl(claudeFile(home, SESSION, "-work-b"), [...first, ...linear([{ read: 50, write: 1000, i: 50 }], 2, "cs")]);
  const result = run(home, "--cache", "--sources", "claude-code");
  assert.equal(result.status, 0, result.stderr);
  const [line] = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
  assert.deepEqual(line.breaks.map(({ turn, cause }) => [turn, cause]), [[3, "compaction"]]);
});

test("a file with no turn compared passes the carry on with its own compaction", async (t) => {
  const home = await tempHome(t);
  // One thread in three rollouts: the middle one holds a compaction and no request.
  await rollout(home, "1", "thread-1", [[1000, 0], [1200, 1000]], 1);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-02-fixture.jsonl"), [codexMeta("thread-1"), ctx(20), { type: "compacted", timestamp: at(21), payload: { message: "", replacement_history: [] } }]);
  await rollout(home, "3", "thread-1", [[1300, 50]], 30);
  const result = run(home, "--cache", "--sources", "codex");
  assert.equal(result.status, 0, result.stderr);
  const [line] = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
  assert.deepEqual(line.breaks.map(({ turn, cause }) => [turn, cause]), [[3, "compaction"]]);
});

test("a copied compaction between two turns of a file's own is no evidence either", async (t) => {
  const home = await tempHome(t);
  const earlier = await writeJsonl(claudeFile(home), [...linear([{ read: 1000, i: 10 }]), ...compaction("a0", 20)]);
  await utimes(earlier, new Date(at(0)), new Date(at(0)));
  // Another session's file: its own turn, then the first file's compaction copied, then its own turn again.
  const own = linear([{ read: 1000, i: 40 }], 10);
  await writeJsonl(claudeFile(home, RESUMED), [...own, ...compaction("a0", 20), ...linear([{ read: 50, write: 1000, i: 50 }], 11, "a10")]);
  const result = run(home, "--cache", "--sources", "claude-code");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((text) => JSON.parse(text));
  lines.pop();
  assert.deepEqual(lines.flatMap(({ breaks }) => breaks.map(({ turn, cause }) => [turn, cause])), [[2, "unknown"]]);
});
