// A claude-agent or codex turn the person stopped mid-request stays stopped when the run's process is replaced before
// their follow-up (a crash, a park, a server restart; here a SIGKILL of the idle process). The next process opens the
// session, which still holds the stopped turn as open; the follow-up must be answered by a turn of its own, and nothing
// of the stopped turn may go on and show before it. The faux harness's "Cut until <file>." script: a read call, then a
// request admitted and never answered until the file exists, then "After the cut.". With the file there, the next
// process's script is the read call and "After the cut.": the one answer left belongs to whichever turn runs first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, runDir, runRecordOf, scratch, serve, withEnv, jsonIn } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
// The faux harness in a process a test can hold at the write of a turn's end (TURN_END_ARM, TURN_END_HELD).
const CUT = new URL("./fixtures/faux-harness-turn-end-cut.mjs", import.meta.url).pathname;
const ANSWERS = ["final_answer", "text_block"];
const usageRow = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;

/** The run's store entries, read once its process lets go of the store; a read that finds it held tries again. */
function storeEntries(data, runId) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(String(row.record)));
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}
const holderOf = (data, runId) => runRecordOf(data, runId).holder?.pid;
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

/** Waits for `check`, up to `ms`; fails naming `what`. */
async function until(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, what);
}

for (const harness of ["claude-agent", "codex", "opencode"]) {
  test(`${harness}: a turn stopped mid-request stays stopped when its process is replaced; the follow-up is answered by its own turn, and nothing of the stopped turn shows before it`, { timeout: 180_000 }, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    const go = join(await scratch(t), "go");
    assert.equal((await api("POST", "/agents", agent(`stopped-${harness}`, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/stopped-${harness}/runs`, { input: { content: "hi" } })).body.run_id;
    // The read call is answered; the next request is admitted and never answered: the turn is mid-request.
    await until("the second request is admitted", async () => (await usageRow(api, runId))?.requests === 2);
    assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
    await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
    // The stopped run's process goes before the follow-up; the follow-up's process opens the session anew.
    await writeFile(go, "");
    const { pid } = runRecordOf(data, runId).holder;
    process.kill(pid, "SIGKILL");
    await until("the run's process is gone", () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).status, 202);
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
    const shown = rows.map((r) => [r.kind, r.summary]);
    const followUp = rows.findIndex((r) => r.kind === "user_message" && r.summary === "You: go on");
    assert.ok(followUp > 0, `the follow-up shows: ${JSON.stringify(shown)}`);
    // Between the stop and the follow-up, nothing of the stopped turn goes on: no answer before the follow-up's message.
    assert.deepEqual(rows.slice(0, followUp).filter((r) => ANSWERS.includes(r.kind)).map((r) => r.summary), [], `the stopped turn went on before the follow-up: ${JSON.stringify(shown)}`);
    // The follow-up's own turn answers it.
    assert.deepEqual(rows.slice(followUp + 1).filter((r) => ANSWERS.includes(r.kind)).map((r) => r.summary), ["After the cut."], `the follow-up's answer: ${JSON.stringify(shown)}`);
    assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "After the cut.");
  });
}

for (const harness of ["claude-agent", "codex", "opencode"]) {
  test(`${harness}: a turn stopped mid-request whose process died before the turn's end was written: the next process writes that end, interrupted, before the follow-up, which is a turn of its own`, { timeout: 180_000 }, async (t) => {
    const dir = await scratch(t);
    const [arm, held, go] = [join(dir, "arm"), join(dir, "held"), join(dir, "go")];
    withEnv(t, { TURN_END_ARM: arm, TURN_END_HELD: held });
    const { api, data } = await serve(t, { fauxHarness: CUT });
    assert.equal((await api("POST", "/agents", agent(`unended-${harness}`, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/unended-${harness}/runs`, { input: { content: "hi" } })).body.run_id;
    await until("the second request is admitted", async () => (await usageRow(api, runId))?.requests === 2);
    // From here the process holds at the next write of a turn's end: the stopped turn's.
    await writeFile(arm, "");
    assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
    let hold = null;
    await until("the stopped turn reaches the write of its end", async () => (hold = await jsonIn(held)) !== null);
    assert.equal(holderOf(data, runId), hold.pid, "the held process is the run's");
    await writeFile(go, "");
    process.kill(hold.pid, "SIGKILL");
    await until("the run's process is gone", () => gone(hold.pid));
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).status, 202);
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
    const shown = rows.map((r) => [r.kind, r.summary]);
    const followUp = rows.findIndex((r) => r.kind === "user_message" && r.summary === "You: go on");
    assert.deepEqual(rows.slice(0, followUp).filter((r) => ANSWERS.includes(r.kind)).map((r) => r.summary), [], `the stopped turn went on before the follow-up: ${JSON.stringify(shown)}`);
    // The run's process lets go of its store once it completes.
    await until("the run's process is gone", () => { const pid = holderOf(data, runId); return pid === undefined || gone(pid); }, 60_000);
    const entries = storeEntries(data, runId);
    const ends = entries.filter((e) => e.kind === "adapter.turn_end").map((e) => e.data?.status);
    assert.deepEqual(ends, ["interrupted", "completed"], `the stopped turn's end, written by the next process, then the follow-up's: ${JSON.stringify(entries.map((e) => e.kind))}`);
    // Each end names the message its turn took (turns.ts): the stopped turn's, the run's first message.
    const messages = entries.filter((e) => e.kind === "adapter.message").map((e) => e.data?.id);
    const named = entries.filter((e) => e.kind === "adapter.turn_end").map((e) => e.data?.message);
    assert.deepEqual(named, messages, `the stopped turn's end names its message, and the follow-up's its own: ${JSON.stringify(named)} for ${JSON.stringify(messages)}`);
    const stoppedEnd = entries.findIndex((e) => e.kind === "adapter.turn_end");
    const followUpEntry = entries.findIndex((e) => e.kind === "pi.user" && JSON.stringify(e.model ?? []).includes("go on"));
    assert.ok(stoppedEnd >= 0 && followUpEntry > stoppedEnd, `the stopped turn's end comes before the follow-up's message: ${stoppedEnd}, ${followUpEntry}`);
  });

  test(`${harness}: a stopped turn the next process settled, which died before it wrote the turn's end: the process after it writes that end, interrupted, not completed`, { timeout: 240_000 }, async (t) => {
    // The session holds the stopped turn ended (settled) while the root still has no end for it: the open after that finds
    // the session idle, and the turn's end must still read interrupted, from the stop record.
    const dir = await scratch(t);
    const [arm, held, again, go] = [join(dir, "arm"), join(dir, "held"), join(dir, "again"), join(dir, "go")];
    withEnv(t, { TURN_END_ARM: arm, TURN_END_HELD: held, TURN_END_AGAIN: again });
    const { api, data } = await serve(t, { fauxHarness: CUT });
    assert.equal((await api("POST", "/agents", agent(`resettled-${harness}`, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/resettled-${harness}/runs`, { input: { content: "hi" } })).body.run_id;
    await until("the second request is admitted", async () => (await usageRow(api, runId))?.requests === 2);
    await writeFile(arm, "");
    assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
    let hold = null;
    await until("the stopped turn reaches the write of its end", async () => (hold = await jsonIn(held)) !== null);
    assert.equal(holderOf(data, runId), hold.pid, "the held process is the run's");
    await writeFile(go, "");
    process.kill(hold.pid, "SIGKILL");
    await until("the run's process is gone", () => gone(hold.pid));
    // The follow-up opens the run's next process. It settles the stopped turn in the session, then holds in its open at
    // the write of the turn's end on the root, and dies there, before it takes the message. The server's delivery tries
    // again, on the process it opens next.
    const posted = api("POST", `/runs/${runId}/messages`, { content: "go on" });
    let second = null;
    await until("the next process reaches the write of the stopped turn's end", async () => (second = await jsonIn(again)) !== null);
    assert.notEqual(second.pid, hold.pid);
    assert.equal(holderOf(data, runId), second.pid, "the second held process is the run's");
    process.kill(second.pid, "SIGKILL");
    await until("the second process is gone", () => gone(second.pid));
    assert.equal((await posted).status, 202);
    await until("the follow-up is answered", async () => {
      const { rows } = (await api("GET", `/runs/${runId}/timeline`)).body;
      const at = rows.findIndex((r) => r.kind === "user_message" && r.summary === "You: go on");
      return at >= 0 && rows.slice(at + 1).some((r) => ANSWERS.includes(r.kind));
    }, 90_000);
    await until("the run's process is gone", () => { const pid = holderOf(data, runId); return pid === undefined || gone(pid); }, 60_000);
    const entries = storeEntries(data, runId);
    const ends = entries.filter((e) => e.kind === "adapter.turn_end").map((e) => e.data?.status);
    assert.deepEqual(ends, ["interrupted", "completed"], `the stopped turn's end, written by the process after the one that settled it, then the follow-up's: ${JSON.stringify(entries.map((e) => e.kind))}`);
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    const followUp = rows.findIndex((r) => r.kind === "user_message" && r.summary === "You: go on");
    assert.deepEqual(rows.slice(0, followUp).filter((r) => ANSWERS.includes(r.kind)).map((r) => r.summary), [], `the stopped turn went on before the follow-up: ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  });

  test(`${harness}: a turn a drain cut (its process stopped, no stop by the person) still goes on in the next process and ends with its answer`, { timeout: 180_000 }, async (t) => {
    // The guard for what must not change: only a person's stop settles an open turn; a crash or a drain resumes it.
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, drainTimeout: "1s" });
    const go = join(await scratch(t), "go");
    assert.equal((await api("POST", "/agents", agent(`drained-${harness}`, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/drained-${harness}/runs`, { input: { content: "hi" } })).body.run_id;
    await until("the second request is admitted", async () => (await usageRow(api, runId))?.requests === 2);
    await writeFile(go, "");
    const pid = holderOf(data, runId);
    process.kill(pid, "SIGTERM");
    await until("the drained process is gone", () => gone(pid));
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
    const shown = rows.map((r) => [r.kind, r.summary]);
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi"], `no other message: ${JSON.stringify(shown)}`);
    assert.deepEqual(rows.filter((r) => ANSWERS.includes(r.kind)).map((r) => r.summary), ["After the cut."], `the drained turn went on to its answer: ${JSON.stringify(shown)}`);
    assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "After the cut.");
  });
}
