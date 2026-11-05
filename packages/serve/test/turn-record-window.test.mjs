// Two more ways a run's end was read wrong, each a case of the record a turn ends on (turns.ts): a pi stop at the length
// limit is its turn's answer, and a follow-up waiting behind a turn keeps the run open across a crash in the window
// between that turn's end and the record of the follow-up's send. Each checks that the first terminal status read is the
// run's last. pi on the faux model, claude-agent and codex on the faux harness; no model, no network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const SEND_CUT = new URL("./fixtures/faux-harness-send-cut.mjs", import.meta.url).pathname;
const WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows;

// ---- a pi stop at the length limit ---------------------------------------------------------------------------------------

for (const [what, input, next] of [["as its first answer", "Answer until the length runs out.", undefined], ["after an answer with text", "hi", "Now answer until the length runs out."]]) {
  test(`pi: a stop at the length limit (text, no tool call) ends its turn ${what}; the run's answer is that turn's text, as its row shows it`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t);
    assert.equal((await api("POST", "/agents", agent("lengthy"))).status, 201);
    const started = await api("POST", "/agents/lengthy/runs", { input: { content: input } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    if (next) {
      await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
      assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "On hi: done.");
      assert.equal((await api("POST", `/runs/${runId}/messages`, { content: next })).status, 202);
    }
    const seen = [];
    for (const end = Date.now() + 30_000; ; await sleep(50)) {
      const { body: view } = await api("GET", `/runs/${runId}`);
      if (seen.at(-1) !== view.status) seen.push(view.status);
      if (TERMINAL.includes(view.status) && (!next || view.result?.final_answer !== "On hi: done.")) break;
      assert.ok(Date.now() < end, `the length stop ends the run: ${view.status}/${view.state}, answer ${JSON.stringify(view.result?.final_answer)} (${seen.join(" > ")})`);
    }
    const { rows } = await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
    const { body: view } = await api("GET", `/runs/${runId}`);
    assert.deepEqual([seen.find((s) => TERMINAL.includes(s)), view.status], ["completed", "completed"], seen.join(" > "));
    assert.equal(view.result?.final_answer, "Cut short: the length ran out", "the length stop's own text, never the earlier turn's");
    assert.ok(rows.some((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.text === "Cut short: the length ran out"), `its row shows the same text: ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  });
}

// ---- a crash between a turn's end and the record of the queued follow-up's send --------------------------------------

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a follow-up queued behind a turn, its process killed after that turn's end and before the follow-up's send is recorded on the root, with the server down too, is answered once before the run completes`, { timeout: 240_000 }, async (t) => {
    const dir = await scratch(t);
    const data = join(dir, "agents");
    const [arm, held, go] = [join(dir, "arm"), join(dir, "held"), join(dir, "go")];
    withEnv(t, { SEND_CUT_ARM: arm, SEND_CUT_HELD: held });
    const options = { data, port: 0, faux: FAUX, fauxHarness: SEND_CUT, fauxWeb: WEB_HOLD, drainTimeout: "5s" };
    const one = await startServe(options);
    let closed = false;
    t.after(() => (closed ? undefined : one.close()));
    let api = client(one.baseUrl, one.token);
    assert.equal((await api("POST", "/agents", agent(harness, { harness, instructions: `Queue a follow-up behind a turn held until ${go}.`, tools: ["fetch_page"] }))).status, 201);
    const { body } = await api("POST", `/agents/${harness}/runs`, { input: { content: "hi" } });
    const runId = body.run_id;
    for (const end = Date.now() + 55_000; ; await sleep(50)) {
      const view = (await api("GET", `/runs/${runId}`)).body;
      if (view.status === "working" && view.state === "working" && (await rowsOf(api, runId)).some((r) => r.kind === "user_message")) break;
      assert.ok(Date.now() < end, `turn 1 works: ${view.status}/${view.state}`);
    }
    const sent = await api("POST", `/runs/${runId}/messages`, { content: "and then?" });
    assert.deepEqual([sent.status, sent.body.mode], [202, "follow_up"], JSON.stringify(sent.body));
    // Turn 1 ends and writes its end; the process holds at the follow-up's send, before the root records it.
    await writeFile(arm, "");
    await writeFile(go, "");
    let hold = null;
    for (const end = Date.now() + 55_000; !(hold = JSON.parse(await readFile(held, "utf8").catch(() => "null"))); await sleep(50)) assert.ok(Date.now() < end, "the follow-up's send reaches its record");
    assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder?.pid, hold.pid, "the held process is the run's");
    process.kill(hold.pid, "SIGKILL");
    closed = true;
    await one.close();
    // The next server knows no message it sent: only the run's records say one waits.
    const two = await startServe(options);
    t.after(() => two.close());
    api = client(two.baseUrl, two.token);
    const seen = [];
    let early;
    for (const end = Date.now() + 90_000; ; await sleep(50)) {
      const { body: view } = await api("GET", `/runs/${runId}`);
      if (seen.at(-1) !== view.status) seen.push(view.status);
      if (TERMINAL.includes(view.status)) {
        const rows = await rowsOf(api, runId);
        if (!rows.some((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.text === "Answer 2.")) early ??= { status: view.status, final_answer: view.result?.final_answer ?? null };
        break;
      }
      assert.ok(Date.now() < end, `the next server ends the run: ${seen.join(" > ")}`);
    }
    const { rows } = await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
    const { body: view } = await api("GET", `/runs/${runId}`);
    t.diagnostic(`statuses ${seen.join(" > ")}; rows ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
    assert.equal(early, undefined, `the run read ${JSON.stringify(early)} before its queued follow-up was answered`);
    assert.deepEqual([view.status, view.result?.final_answer], ["completed", "Answer 2."], "the follow-up's answer is the run's");
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi", "You: and then?"], "the follow-up shows once");
    assert.ok(!rows.some((r) => r.text === "Answer 2, sent again."), "and is not sent again");
  });
}
