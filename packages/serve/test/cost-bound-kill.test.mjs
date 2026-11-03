// A harness request cut by a real crash in the window between the runner's durable record of it (written, and its
// request_start emitted) and its start mark on the run's root: the run's process is held inside that mark's write
// (faux-harness-start-mark-cut.mjs) and SIGKILLed there, with its server, and a server started anew opens the store. Once
// the cut request is booked, the run's cost must read at most the known costs plus what was held for it (its runner
// record's figure), never another request's smaller figure; the reopened turn's end is not waited for. The faux claude-agent harness on the faux model priced by its input, so a later turn's
// longer prompt holds more; no network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, follow, scratch, withEnv } from "./support.mjs";

const CUT = new URL("./fixtures/faux-harness-start-mark-cut.mjs", import.meta.url).pathname;
const PRICED = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (usd) => Math.round(usd * 1e6) / 1e6;

/** The run store's entries, once no process holds the store (the run ended, or its server closed). */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record)));
  } finally {
    db.close();
  }
}

test("claude-agent: a request whose process is SIGKILLed after it was admitted and before its start mark reached the root reads at most the known cost plus its own hold after a fresh server opens the run", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const [arm, held, go] = [join(dir, "arm"), join(dir, "held"), join(dir, "go")];
  withEnv(t, { START_MARK_ARM: arm, START_MARK_HELD: held });
  const options = { data, port: 0, faux: PRICED, fauxHarness: CUT, drainTimeout: "5s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  let api = client(one.baseUrl, one.token);
  assert.equal((await api("POST", "/agents", agent("lost", { harness: "claude-agent", instructions: `Answer, then cut the next turn until ${go}.` }))).status, 201);
  const runId = (await api("POST", "/agents/lost/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });

  // The next turn's prompt is far longer, so its one request holds far more than the first turn's.
  await writeFile(arm, "");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: `Go on. ${"Take every detail into account. ".repeat(60)}` })).status, 202);
  let hold = null;
  for (const end = Date.now() + 60_000; !(hold = JSON.parse(await readFile(held, "utf8").catch(() => "null"))); await sleep(50)) assert.ok(Date.now() < end, "the next turn's request reaches the write of its start mark");
  assert.equal(hold.request, 3, "held at the third request's start mark: the first turn made two");
  assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder?.pid, hold.pid, "the held process is the run's");
  // The opened run has nothing more to ask once this exists; the kill lands with the mark's write still open.
  await writeFile(go, "");
  process.kill(hold.pid, "SIGKILL");
  closed = true;
  await one.close();

  const two = await startServe(options);
  let twoClosed = false;
  t.after(() => (twoClosed ? undefined : two.close()));
  api = client(two.baseUrl, two.token);
  // The run is opened again and its cut request booked: its cost unknown, and bounded. Its end is not waited for: the
  // bound is read once the cut request is booked, whether or not the reopened turn ever ends.
  let run;
  for (const end = Date.now() + 90_000; ; await sleep(100)) {
    run = (await api("GET", `/runs/${runId}`)).body;
    if (run.cost?.usd === null && typeof run.cost?.at_most_usd === "number") break;
    assert.ok(Date.now() < end, `the run opens again and books its cut request: ${JSON.stringify(run.cost)}`);
  }
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  t.diagnostic(`rows ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  // A running run's store is its process's: the server's close lets it go, and the runner's records are read then.
  twoClosed = true;
  await two.close();

  // What was held for the cut request, as its runner record keeps it: the cap's own figure for it.
  const entries = entriesOf(data, runId);
  const records = entries.filter((e) => e.kind === "runner.request");
  const third = records.find((e) => e.data?.turn === 3)?.data?.heldUsd;
  const smaller = records.filter((e) => e.data?.turn !== 3).map((e) => e.data?.heldUsd);
  assert.ok(typeof third === "number" && smaller.every((usd) => typeof usd === "number" && usd < third), `the cut request held the most: ${JSON.stringify({ third, smaller })}`);
  assert.equal(run.cost.usd, null, "the cut request's own price never came in");
  assert.ok(run.cost.at_most_usd >= round(0.003 + third) - 1e-9, `at most the known $0.003 plus the cut request's own $${third}, never less: ${JSON.stringify(run.cost)}`);
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: null, requests: 3, at_most_usd: run.cost.at_most_usd }, "the usage row reads the same");
});
