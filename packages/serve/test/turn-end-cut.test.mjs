// A claude-agent follow-up whose turn ends showing nothing (the Claude CLI's /compact), its process killed after the turn's
// last entry and before the turn's end (TURN_END) is written (#1424's Greptile P1). The session holds the turn as over, so
// the relaunched process has no turn to recover, and the root has no end for it: the run must still complete, its answer
// that turn's own (none: ""), with no other message. The kill comes at a write the process holds open (faux-harness-turn-end-cut.mjs),
// never after a wait. The faux claude-agent harness, no network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const CUT = new URL("./fixtures/faux-harness-turn-end-cut.mjs", import.meta.url).pathname;
const WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
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
  assert.equal(await answer(api, runId), "", "the follow-up's own answer: it showed no text");
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: 0.003, requests: 3 }, "the follow-up's request counts once");
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi", "You: /compact"], "no other message");
});

/** Two follow-ups queued behind a held first turn (the second, "/compact", answers nothing); the run's process is killed at
 *  the write the arm file `armed` names (faux-harness-turn-end-cut.mjs), the server closed and another started. The run
 *  must read neither terminal nor working in the new process before the last follow-up's answer, "Answer 3.", and then
 *  completed. `holds` checks what the held process wrote and where it held. */
async function queuedRelaunch(t, armed, reaching, holds) {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const [arm, held, gate, first, last] = [join(dir, "arm"), join(dir, "held"), join(dir, "gate"), join(dir, "first"), join(dir, "last")];
  withEnv(t, { TURN_END_ARM: arm, TURN_END_HELD: held, TURN_END_GATE: gate });
  const options = { data, port: 0, faux: FAUX, fauxHarness: CUT, fauxWeb: WEB_HOLD, drainTimeout: "5s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  let api = client(one.baseUrl, one.token);
  const instructions = `Queue two follow-ups until ${first}, then hold the last until ${last}.`;
  assert.equal((await api("POST", "/agents", agent("queued", { harness: "claude-agent", instructions, tools: ["fetch_page"] }))).status, 201);
  const { body } = await api("POST", "/agents/queued/runs", { input: { content: "hi" } });
  const runId = body.run_id;
  // Turn 1 holds on its fetch: both follow-ups are accepted while it works, and wait their place.
  for (const end = Date.now() + 55_000; ; await sleep(50)) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (view.status === "working" && view.state === "working") break;
    assert.ok(Date.now() < end, `turn 1 works: ${view.status}/${view.state}`);
  }
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "/compact" })).status, 202);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "And then?" })).status, 202);
  await writeFile(arm, armed);
  await writeFile(first, "");
  let hold = null;
  for (const end = Date.now() + 55_000; !(hold = JSON.parse(await readFile(held, "utf8").catch(() => "null"))); await sleep(50)) assert.ok(Date.now() < end, reaching);
  holds(hold);
  assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder?.pid, hold.pid, "the held process is the run's");
  // The run's process and the server go down together: the next server counts no message waiting.
  process.kill(hold.pid, "SIGKILL");
  closed = true;
  await one.close();
  // The new server's process waits in its open until that server follows its door: every write of the reopen's reaches
  // the server as it is made, the first while the door is idle.
  const two = await startServe(options);
  t.after(() => two.close());
  api = client(two.baseUrl, two.token);
  // The last follow-up's turn holds on its fetch until the run reads terminal, or working in a process of the new server's:
  // an end that came before it answered shows.
  let early;
  for (const end = Date.now() + 90_000; ; await sleep(50)) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (TERMINAL.includes(view.status)) {
      early = { status: view.status, final_answer: view.result?.final_answer ?? null };
      break;
    }
    const holder = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8").catch(() => "{}")).holder?.pid;
    if (view.status === "working" && view.state === "working" && holder && holder !== hold.pid) break;
    assert.ok(Date.now() < end, `the run opens again: last ${view.status}/${view.state}`);
  }
  await writeFile(last, "");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  t.diagnostic(`ended before the queued follow-up answered: ${JSON.stringify(early ?? null)}; rows ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  // No end before the answer first: a server that reads the run done from its store stops the process before its open
  // reaches the gate.
  assert.equal(early, undefined, `the run read ${JSON.stringify(early)} before its queued follow-up answered`);
  assert.deepEqual(JSON.parse(await readFile(gate, "utf8").catch(() => "null")), { streamed: true }, "the reopen went on once the new server followed its door");
  assert.equal(await answer(api, runId), "Answer 3.", "the queued follow-up's answer");
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi", "You: /compact", "You: And then?"]);
}

test("a follow-up still queued behind an answerless turn whose process died before that turn's end, with the server down too, is answered before the run completes", { timeout: 240_000 }, async (t) => {
  // #1424's second Greptile P1: the relaunch writes the missing turn end while the door is idle, before the queue is
  // restored, and a server started anew counts no message waiting; it must not read that end as the run's.
  // Turn 1's end passes; the process holds at the next one's write: the answerless /compact turn's.
  await queuedRelaunch(t, "1", "the /compact turn reaches the write of its end", (hold) => {
    const ended = hold.since.lastIndexOf("faux.turn_end");
    assert.ok(ended >= 0 && hold.since.lastIndexOf("pi.assistant") > ended && hold.since.includes("adapter.turn_end"), `written since the arm: ${hold.since.join(", ")}`);
  });
});

test("a follow-up still queued behind an answerless turn whose end was written, its process killed before the follow-up was sent, with the server down too, is answered before the run completes", { timeout: 240_000 }, async (t) => {
  // #1424 (the lead's review): runTurns writes a turn's end, then sends the next queued message and writes its entry and
  // its end in a commit of its own. A process that dies between the two leaves the /compact turn answered, with its end,
  // and the last follow-up accepted (adapter.message) with no end; a server started anew counts no message waiting.
  // Both turn ends pass; the process holds at its next write, the session's record of the follow-up it sends.
  await queuedRelaunch(t, "2 after", "the queued follow-up's send reaches the session after the /compact turn's end", (hold) => {
    assert.equal(hold.at, "faux.user", `held at the session's record of the follow-up, after: ${hold.since.join(", ")}`);
    assert.equal(hold.since.filter((kind) => kind === "adapter.turn_end").length, 2, `both turn ends written: ${hold.since.join(", ")}`);
    assert.ok(!hold.since.slice(hold.since.lastIndexOf("adapter.turn_end")).includes("pi.user"), `the follow-up's entry not written: ${hold.since.join(", ")}`);
  });
});
