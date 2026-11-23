// parseHome with a state keeps each locator's cursor between passes. A cursor holds what its read needs to go on, and no
// more: each request's model and usage, packed, not the request (its calls, ids and key as objects). A state kept so is
// as small a request as the import's own index of records, whatever the source, so a stateful import holds no more of a
// large history than a stateless one. Measured as the state's bytes (v8 serialize): what a caller keeps, and the same on
// every run, unlike a heap reading.
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexContext, codexFile, codexMeta, codexTokens, codexUser, jsonl, openaiUsage, piAnswer, piFile, piMeta, piUser, tempHome } from "./fixtures.mjs";

const N = 3000;
const hex = (i) => i.toString(16).padStart(12, "0");

/** Claude Code: each request two lines (a tool call, then text with the final usage), a user line before it. */
const claudeLines = (from, to) =>
  Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    return [
      claudeUser({ uuid: `00000000-0000-4000-8000-a${hex(i).slice(1)}`, text: `Question ${i}.`, i: 3 * i }),
      claudeAnswer({ uuid: `00000000-0000-4000-8000-b${hex(i).slice(1)}`, msg: `msg_${hex(i)}`, req: `req_${hex(i)}`, usage: anthropicUsage(10, 1), i: 3 * i + 1, block: { type: "tool_use", id: `toolu_${hex(i)}`, name: "Bash", input: { command: "ls" } } }),
      claudeAnswer({ uuid: `00000000-0000-4000-8000-c${hex(i).slice(1)}`, msg: `msg_${hex(i)}`, req: `req_${hex(i)}`, usage: anthropicUsage(10, 20 + (i % 7)), i: 3 * i + 2 }),
    ];
  }).flat();

/** Codex: each request a call, its output and its token count. */
const codexLines = (from, to) =>
  Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    const call = `call_${hex(i)}`;
    return [
      { type: "response_item", timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3000).toISOString(), payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: call } },
      { type: "response_item", timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3000 + 1000).toISOString(), payload: { type: "function_call_output", call_id: call, output: "ok" } },
      codexTokens(openaiUsage(100, 50, 10 + (i % 5)), openaiUsage(100 * (i + 1), 50 * (i + 1), 12 * (i + 1)), 3 * i + 2),
    ];
  }).flat();

const piLines = (from, to) => Array.from({ length: to - from }, (_, k) => [piUser(`Question ${from + k}.`, 2 * (from + k) + 1), piAnswer({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 2 * (from + k) + 2)]).flat();

async function write(file, records) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl(records));
  return file;
}

// Each bound over the source's records index (its records' keys: four a Claude Code request here, a uuid for each line)
// and its counts; under what the requests as objects take: 602, 426 and 178 bytes a request.
for (const [source, file, opening, lines, bound] of [
  ["claude-code", claudeFile, [], claudeLines, 450],
  ["codex", codexFile, [codexMeta("thread-state"), codexContext(1), codexUser("Go.", 2)], codexLines, 200],
  ["pi", piFile, [piMeta()], piLines, 150],
]) {
  test(`${source}: a state kept between passes holds each request's counts, not the request: under ${bound} bytes a request`, async (t) => {
    const home = await tempHome(t);
    await write(file(home), [...opening, ...lines(0, N)]);
    const state = {};
    const [first] = await parseHome(home, { sources: [source], state, catalog: false });
    assert.equal(first.calls, N);
    const bytes = serialize(state).length;
    assert.ok(bytes / N < bound, `${Math.round(bytes / N)} bytes a request`);
  });
}

// A session's file often holds a request or two (a short session, a subagent's): its cursor carries no room to grow
// into, nor more of an index than its keys. Holding the requests as objects, a state of 300 such files held 1,370 bytes
// a file of one request, 2,110 of three, 4,782 of ten (v8 serialize): within 200 bytes of that for one request (an
// index and counts cost a little more than one request's object), and under it from three.
for (const [requests, bound] of [
  [1, 1370 + 200],
  [3, 2110],
  [10, 4782],
]) {
  test(`Claude Code: a state over files of ${requests} request${requests > 1 ? "s" : ""} each holds under ${bound} bytes a file`, async (t) => {
    const home = await tempHome(t);
    const FILES = 300;
    for (let f = 0; f < FILES; f += 1) {
      const id = `00000000-0000-4000-8000-${hex(f)}`;
      const records = [];
      for (let i = 0; i < requests; i += 1) {
        records.push(claudeUser({ uuid: `10000000-0000-4000-8000-${hex(f * 100 + i)}`, text: "Go.", i: 2 * i, session: id }));
        records.push(claudeAnswer({ uuid: `20000000-0000-4000-8000-${hex(f * 100 + i)}`, msg: `msg_${f}_${i}`, req: `req_${f}_${i}`, usage: anthropicUsage(10, 5), i: 2 * i + 1, session: id }));
      }
      await write(claudeFile(home, id), records);
    }
    const state = {};
    const sessions = await parseHome(home, { sources: ["claude-code"], state, catalog: false });
    assert.equal(sessions.length, FILES);
    const bytes = serialize(state).length / FILES;
    assert.ok(bytes < bound, `${Math.round(bytes)} bytes a file`);
  });
}

test("passes with a state across appends (a request's lines split between them), a rewrite and a failed read give a fresh pass's totals each time", async (t) => {
  const home = await tempHome(t);
  const claude = await write(claudeFile(home), claudeLines(0, 40));
  const codex = await write(codexFile(home), [codexMeta("thread-state"), codexContext(1), codexUser("Go.", 2), ...codexLines(0, 40)]);
  const pi = await write(piFile(home), [piMeta(), ...piLines(0, 40)]);
  const state = {};
  const fresh = (options = {}) => parseHome(home, { catalog: false, failures: [], ...options });
  const pass = async (label, options = {}) => assert.deepEqual(await parseHome(home, { catalog: false, failures: [], state, ...options }), await fresh(options), label);
  await pass("first pass");
  // Each request's first lines now, the line with its final usage in the next append.
  const claudeNext = claudeLines(40, 60);
  const codexNext = codexLines(40, 60);
  await appendFile(claude, jsonl(claudeNext.slice(0, -1)));
  await appendFile(codex, jsonl(codexNext.slice(0, -1)));
  await appendFile(pi, jsonl(piLines(40, 50)));
  await pass("an append that ends inside a request");
  await appendFile(claude, jsonl(claudeNext.slice(-1)));
  await appendFile(codex, jsonl(codexNext.slice(-1)));
  await pass("the rest of that request");
  // A rewrite in place, as long as before: read again from its start.
  await writeFile(claude, jsonl(claudeLines(100, 160)));
  await pass("a rewrite");
  // A read that fails: the pass is the fresh pass with the same failure, and the next one reads it again.
  const { READERS } = await import("../dist/index.js");
  const failing = { ...READERS["codex"], read: () => Promise.reject(Object.assign(new Error("injected"), { code: "EIO" })) };
  await appendFile(codex, jsonl(codexLines(60, 70)));
  await pass("a failed read", { readers: { ...READERS, codex: failing } });
  await pass("after the failed read");
});
