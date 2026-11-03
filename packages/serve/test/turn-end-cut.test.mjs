// A claude-agent follow-up whose turn ends showing nothing (the Claude CLI's /compact), its process killed after the turn's
// last entry and before the turn's end (TURN_END) is written (#1424's Greptile P1). The session holds the turn as over, so
// the relaunched process has no turn to recover, and the root has no end for it: the run must still complete, its answer
// the earlier one, with no other message. The kill comes at a write the process holds open (faux-harness-turn-end-cut.mjs),
// never after a wait. The faux claude-agent harness, no network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const CUT = new URL("./fixtures/faux-harness-turn-end-cut.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;

test("a follow-up whose turn ended showing nothing, its process killed before the turn's end was written, completes on the relaunch without another message", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const [arm, held] = [join(dir, "arm"), join(dir, "held")];
  withEnv(t, { TURN_END_ARM: arm, TURN_END_HELD: held });
  const { api, data } = await serve(t, { fauxHarness: CUT });
  assert.equal((await api("POST", "/agents", agent("unended", { harness: "claude-agent", instructions: "The second turn answers nothing." }))).status, 201);
  const { body } = await api("POST", "/agents/unended/runs", { input: { content: "hi" } });
  const runId = body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Answer 1.");

  // From here the run's process holds at the next turn end's write: the follow-up's.
  await writeFile(arm, "");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "/compact" })).status, 202);
  let hold = null;
  for (const end = Date.now() + 55_000; !(hold = JSON.parse(await readFile(held, "utf8").catch(() => "null"))); await sleep(50)) assert.ok(Date.now() < end, "the follow-up's turn reaches the write of its end");
  // In the window: the session wrote the turn's end (faux.turn_end), then the bridge the turn's last request (flush(true)'s
  // entry, with no content), and the root's turn end is the write held open.
  const ended = hold.since.lastIndexOf("faux.turn_end");
  assert.ok(ended >= 0 && hold.since.lastIndexOf("pi.assistant") > ended, `written since the arm: ${hold.since.join(", ")}`);
  assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder?.pid, hold.pid, "the held process is the run's");
  process.kill(hold.pid, "SIGKILL");

  // No message after the kill: the relaunched process alone ends the run.
  const { rows, last } = await follow(api, runId, ["completed"], { deadlineMs: 45_000 });
  t.diagnostic(`rows ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  assert.equal(last.status, "completed");
  assert.equal(await answer(api, runId), "Answer 1.", "the earlier answer stands");
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: 0.003, requests: 3 }, "the follow-up's request counts once");
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi", "You: /compact"], "no other message");
});
