// The scan (src/scan.ts) on the Claude Code and Codex lines #3499's cases hold: the Claude Code session an OpenCode
// claude-agent request mirrors, and Codex subagent threads that name their parent in a long first line (session_meta,
// both its forms). A totals read with the scan gives what one parsing every line gives, read by read and in a home's
// totals, the mirrored requests counted once either way. Synthetic fixtures only.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { lineReader, READERS } from "../dist/index.js";
import { claudeCodeLines } from "../dist/readers/claude-code.js";
import { codexLines } from "../dist/readers/codex.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";
import { buildLegacy, buildV2 } from "./fixtures/opencode/fixture.mjs";

const DATA = ".local/share/opencode";
/** Each line source's reader as the registry has it (the scan on a totals read), and one that parses every line. */
const scanned = { "claude-code": lineReader(claudeCodeLines), codex: lineReader(codexLines) };
const parsed = { "claude-code": lineReader({ ...claudeCodeLines, fields: undefined }), codex: lineReader({ ...codexLines, fields: undefined }) };

/** A home of #3499's cases: a 2.x opencode.db and its JSON storage, claude-session-1 (ses_K's claude-agent requests K2
 *  and K3 ran in it), and Codex threads under a top one, each naming it in session_meta: by parent_thread_id with
 *  source.subagent.thread_spawn beside it, by thread_spawn alone, and with a first line over the 256 KiB chunk that
 *  parentOf reads by. */
async function mirrorHome(t) {
  const home = await tempHome(t);
  await buildV2(join(home, DATA, "opencode.db"));
  await buildLegacy(join(home, DATA, "storage"));
  const session = "claude-session-1";
  await writeJsonl(claudeFile(home, session), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0, session }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(3, 2), i: 1, session }),
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(4, 1), i: 2, session }),
  ]);
  const turns = (input) => [codexContext(1), codexUser("Fixture task.", 2), codexAnswer("Fixture answer.", 3), codexTokens(openaiUsage(input, 2, 5, 1), openaiUsage(input, 2, 5, 1), 4)];
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-top.jsonl"), [codexMeta("thread-top"), ...turns(10)]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-01-child.jsonl"), [codexMeta("thread-child", "thread-top"), ...turns(20)]);
  const spawned = codexMeta("thread-spawned", "thread-top");
  delete spawned.payload.parent_thread_id;
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-02-spawned.jsonl"), [spawned, ...turns(30)]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-03-long.jsonl"), [{ ...codexMeta("thread-long", "thread-top"), padding: "x".repeat(1024 * 1024) }, ...turns(40)]);
  return home;
}

test("#3499's Claude Code and Codex cases: a totals read with the scan gives what one parsing every line gives", async (t) => {
  const home = await mirrorHome(t);
  const options = { turns: false, totals: true };
  for (const source of ["claude-code", "codex"]) {
    const locators = await READERS[source].discover(home);
    assert.ok(locators.length > 0, source);
    for (const locator of locators) {
      const a = await scanned[source].read(locator, undefined, { ...options });
      const b = await parsed[source].read(locator, undefined, { ...options });
      assert.deepStrictEqual(a, b, `${source} ${locator.file}`);
    }
  }
});

test("#3499's cases in a home's totals: the scan's reads and parsed reads give one answer, the mirrored requests counted once", async (t) => {
  const home = await mirrorHome(t);
  const scan = await parseHome(home, { catalog: false, env: {} });
  const parse = await parseHome(home, { catalog: false, env: {}, readers: { ...READERS, ...parsed } });
  assert.deepEqual(scan, parse);
  const by = Object.fromEntries(scan.map((row) => [row.id, row]));
  // K2 and K3 count in claude-session-1, K4 and K5 in ses_K (opencode-home.test.mjs works them out).
  assert.deepEqual([by["claude-session-1"].calls, by.ses_K.calls], [2, 2]);
  // Each Codex thread is the top one's: one session, its three subagents' requests with its own (input less the 2 cached).
  assert.deepEqual([by["thread-top"].calls, by["thread-top"].subagents, by["thread-top"].tokens.input], [4, 3, 8 + 18 + 28 + 38]);
  assert.equal(scan.filter(({ source }) => source === "codex").length, 1);
});
