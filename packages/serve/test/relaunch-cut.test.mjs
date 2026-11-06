// A claude-agent run relaunched after its process dies, with its turn's request cut before any content, must not read
// completed before its recovered turn answers (#1424's F1, from run-end-trace's adversarial probe). On the relaunch the
// reopen writes the cut request's empty entry while the door is idle and the harness is still starting (2 s here, as a
// real CLI's spawn): that entry is no turn's end. The recovered turn holds on a fetch until the run is terminal or reads
// working in its new process, so an end that came before it shows. The faux claude-agent harness, no network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const RELAUNCH = new URL("./fixtures/faux-harness-relaunch.mjs", import.meta.url).pathname;
const WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows;

/** A claude-agent run of `instructions` whose first turn has answered, then a follow-up whose turn's first request has
 *  left (its start mark makes the usage row count 3 requests: turn 1's two and this one). */
async function inSecondTurn(api, id, instructions) {
  assert.equal((await api("POST", "/agents", agent(id, { harness: "claude-agent", instructions, tools: ["fetch_page"] }))).status, 201);
  const { body } = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  await follow(api, body.run_id, ["completed"], { deadlineMs: 55_000 });
  assert.equal((await api("POST", `/runs/${body.run_id}/messages`, { content: "and then?" })).status, 202);
  for (const end = Date.now() + 55_000; ; await sleep(50)) {
    const usage = (await rowsOf(api, body.run_id)).findLast((r) => r.kind === "usage")?.usage;
    if (usage?.requests === 3) break;
    assert.ok(Date.now() < end, `turn 2's request leaves: usage ${JSON.stringify(usage)}`);
  }
  return body.run_id;
}

/** Every status GET reads until the run is final, with whether the timeline held `answer` at the first terminal one. */
async function watch(api, runId, answer) {
  const seen = [];
  let atFirstTerminal;
  for (const end = Date.now() + 90_000; ; await sleep(50)) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (seen.at(-1) !== view.status) seen.push(view.status);
    if (TERMINAL.includes(view.status) && atFirstTerminal === undefined) {
      const rows = await rowsOf(api, runId);
      atFirstTerminal = { status: view.status, final_answer: view.result?.final_answer ?? null, answered: rows.some((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.text === answer) };
    }
    const page = (await api("GET", `/runs/${runId}/timeline`)).body;
    if (page.final) return { seen, atFirstTerminal, last: view, rows: page.rows };
    assert.ok(Date.now() < end, `the run ends: seen ${seen.join(" > ")}`);
  }
}

test("a claude-agent run relaunched after its process dies, its turn's request cut before any content, does not read completed before the recovered turn answers", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const [mark, gate] = [join(dir, "killed"), join(dir, "go")];
  withEnv(t, { RELAUNCH_MARK: mark });
  const { api, data } = await serve(t, { fauxHarness: RELAUNCH, fauxWeb: WEB_HOLD });
  const runId = await inSecondTurn(api, "relaunch", `Probe the relaunch, held until ${gate}.`);
  const record = async () => runRecordOf(data, runId);
  const killed = (await record()).holder.pid;
  await writeFile(mark, "");
  process.kill(killed, "SIGKILL");
  // The gate opens once the run is terminal, or once the relaunched process's turn runs (working/working with a new
  // holder): the recovered turn holds on its fetch until then, so an end that came before it shows.
  let early;
  for (const end = Date.now() + 90_000; ; await sleep(50)) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (TERMINAL.includes(view.status)) {
      early = { status: view.status, final_answer: view.result?.final_answer ?? null, answered: (await rowsOf(api, runId)).some((r) => r.text === "After the cut.") };
      break;
    }
    const now = await record();
    if (view.status === "working" && view.state === "working" && now.holder?.pid && now.holder.pid !== killed) break;
    assert.ok(Date.now() < end, `the run relaunches: last ${view.status}/${view.state}`);
  }
  await writeFile(gate, "");
  const { seen, atFirstTerminal, last } = await watch(api, runId, "After the cut.");
  t.diagnostic(`terminal before the recovered turn ran: ${JSON.stringify(early ?? null)}`);
  t.diagnostic(`statuses ${seen.join(" > ")}; at the first terminal read ${JSON.stringify(atFirstTerminal)}; final ${last.status} ${JSON.stringify(last.result?.final_answer ?? null)}`);
  assert.equal(early, undefined, `the run read ${JSON.stringify(early)} before its recovered turn ran`);
  assert.deepEqual(atFirstTerminal, { status: "completed", final_answer: "After the cut.", answered: true }, "the run reads completed only once its recovered turn answered");
});
