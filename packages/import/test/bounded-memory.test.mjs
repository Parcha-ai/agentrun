// A home's import holds per request a few numbers, and per record read a packed key in typed arrays, not the reader's
// objects: a home of 100,000 requests imports under a 64 MB heap, with the answers of an import under node's default
// heap. Before, each request stayed a full Answer object and each record key a string in a Map until the run ended,
// and the same home needed more than 96 MB of heap.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SESSIONS = 100;
const PAIRS = 1000;
const hex = (n, width) => n.toString(16).padStart(width, "0");

/** SESSIONS Claude Code sessions of PAIRS question/answer pairs each, every id and count made from its index. */
async function writeHome(home) {
  for (let s = 0; s < SESSIONS; s++) {
    const session = `00000000-0000-4000-8000-${hex(s, 12)}`;
    const records = [];
    for (let i = 0; i < PAIRS; i++) {
      const n = s * PAIRS + i;
      records.push(claudeUser({ uuid: `10000000-0000-4000-8000-${hex(n, 12)}`, text: `Question ${n}.`, i: 2 * i, session }));
      records.push(claudeAnswer({ uuid: `20000000-0000-4000-8000-${hex(n, 12)}`, msg: `msg_${hex(n, 8)}`, req: `req_${hex(n, 8)}`, usage: anthropicUsage(10 + (n % 7), 5 + (n % 3)), i: 2 * i + 1, session }));
    }
    await writeJsonl(claudeFile(home, session), records);
  }
}

const run = (home, ...node) => promisify(execFile)(process.execPath, [...node, CLI, home, "--known-answer"], { env: { PATH: process.env.PATH }, maxBuffer: 1 << 24 });

test("a home of 100,000 requests imports under a 64 MB heap, with the answers of the default heap", async (t) => {
  const home = await tempHome(t);
  await writeHome(home);
  const free = await run(home);
  const lines = free.stdout.trim().split("\n");
  assert.equal(lines.length, SESSIONS);
  assert.equal(lines.reduce((n, line) => n + JSON.parse(line).calls, 0), SESSIONS * PAIRS, "every request counted");
  const bounded = await run(home, "--max-old-space-size=64").catch((error) => assert.fail(`out of memory under a 64 MB heap: ${error.signal ?? error.code}`));
  assert.equal(bounded.stdout, free.stdout);
});
