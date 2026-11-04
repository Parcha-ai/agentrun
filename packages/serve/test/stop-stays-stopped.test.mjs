// A claude-agent or codex turn the person stopped mid-request stays stopped when the run's process is replaced before
// their follow-up (a crash, a park, a server restart; here a SIGKILL of the idle process). The next process opens the
// session, which still holds the stopped turn as open; the follow-up must be answered by a turn of its own, and nothing
// of the stopped turn may go on and show before it. The faux harness's "Cut until <file>." script: a read call, then a
// request admitted and never answered until the file exists, then "After the cut.". With the file there, the next
// process's script is the read call and "After the cut.": the one answer left belongs to whichever turn runs first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const ANSWERS = ["final_answer", "text_block"];
const usageRow = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;

/** Waits for `check`, up to `ms`; fails naming `what`. */
async function until(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, what);
}

for (const harness of ["claude-agent", "codex"]) {
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
    const { pid } = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder;
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
