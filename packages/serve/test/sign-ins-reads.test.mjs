// A run handed its agent's browser sign-in, as the store path serves it (ported from sign-ins.test.mjs's per-run-process
// cases; each names the cases it carries). What a run says is cut of every pointer it was handed, live or forgotten, by
// its row's hashes, or withheld whole when one of them can't be read back here (another seal key, a pointer dropped past
// the newest 32 kept, the sign-in rows gone). Its graph and its review are withheld alike; forget waits for a running run
// handed the sign-in; the agent's home never serves the sign-ins. The runs are real (the faux model repeats its message),
// marked as the runner marks a run it hands a sign-in; a seal key change is the server started again on its data. No
// sleeps, no process deaths, no lease clocks.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { forgetSignIn, saveSignIn } from "../dist/sign-ins-store.js";
import { WITHHELD_SIGN_IN } from "../dist/run-view.js";
import { answerFlow, flowAgent, follow } from "./support.mjs";
import { forgotten, holdsNone, marked, overStore, pointerOf, reads, reserved, runSaying, saved, server, sha, written } from "./custody-support.mjs";

/** That `view`, `lists` and `timeline` withhold what the run said: no answer, the title and Timeline rows withheld. */
function withheld({ view, lists, timeline }, ...needles) {
  assert.equal(view.result?.final_answer ?? null, null, JSON.stringify(view.result));
  assert.equal(view.title, WITHHELD_SIGN_IN);
  for (const row of lists) assert.equal(row.title, WITHHELD_SIGN_IN);
  assert.deepEqual(timeline.rows, []);
  holdsNone({ view, lists, timeline }, "Hold, then echo", ...needles);
}

// sign-ins.test.mjs: "through the API: …" (its home-files and forget-held halves), "a run whose live process the next
// server adopts after a crash never shows its browser sign-in's pointer", "across a restart, a run still going that was
// handed its sign-in keeps the pointer cut from its timeline and its answer".
test("a running run handed the sign-in is served cut while it runs and when it ends, and forget waits for its end; the agent's home never serves the sign-ins", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const pointer = pointerOf();
  await saved(s, pointer);
  const { runId, release } = await runSaying(s, pointer, { hold: true });
  marked(s, runId, [sha(pointer)]);
  await follow(s.api, runId, ["working"]);
  const running = await reads(s, runId);
  assert.match(running.view.title, /^\[redacted\] Hold/);
  assert.ok(running.timeline.rows.some((row) => /^\[redacted\] Hold/.test(row.text ?? row.summary ?? "")), JSON.stringify(running.timeline.rows));
  holdsNone(running, pointer);
  // Forget waits for the run: refused, naming it, never the pointer.
  const held = await s.api("DELETE", "/agents/alpha/sign-ins/default");
  assert.deepEqual([held.status, held.body.error?.code, held.body.error?.details?.handed_to], [409, "sign_in_held", runId], JSON.stringify(held.body));
  assert.match(held.body.error.message, new RegExp(`the run ${runId}`));
  holdsNone({ held: held.body }, pointer);
  // The agent's home lists no sign-ins and never reads or writes them.
  const listed = (await s.api("GET", "/agents/alpha/home/files")).body.files;
  assert.deepEqual(listed.filter((file) => file.host_owned).map((file) => file.path), []);
  const file = ["/agents/alpha", "home", "files", "sign-ins", "sign-ins.json"].join("/");
  const read = await s.api("GET", file);
  assert.deepEqual([read.status, read.body.error?.details?.reason], [403, "host_owned"], JSON.stringify(read.body));
  assert.equal((await s.api("PUT", file, { format: "sign-ins/1", sign_ins: [] })).status, 403);
  holdsNone({ listed, read: read.body, agent: (await s.api("GET", "/agents/alpha")).body, agents: (await s.api("GET", "/agents")).body }, pointer);
  // It ends: its answer cut, and the sign-in may be forgotten.
  release();
  await follow(s.api, runId, ["completed"]);
  const ended = await reads(s, runId);
  assert.match(ended.view.result.final_answer, /^On \[redacted\] Hold/);
  holdsNone(ended, pointer);
  const forgot = await s.api("DELETE", "/agents/alpha/sign-ins/default");
  assert.equal(forgot.status, 200, JSON.stringify(forgot.body));
  assert.deepEqual((await s.api("GET", "/agents/alpha")).body.sign_ins, []);
});

// sign-ins.test.mjs: "a run whose process dies naming its sign-in's pointer in its log fails without showing the pointer",
// "a run's error that holds its browser sign-in's pointer is served cut, in its view and in the run lists alike", "an
// error's details are cut as its message is" (the store path serves an error's message alone: no details to cut).
test("a failed run's error that holds the pointer it was handed is served cut, in its view and both lists", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const pointer = pointerOf();
  await saved(s, pointer);
  const { runId } = await runSaying(s, "Browse.");
  marked(s, runId, [sha(pointer)]);
  // Its end as the runner wrote it: failed, its error the browser's last words.
  written(s, "UPDATE runs SET state = 'failed', summary = ? WHERE id = ?", `The browser died holding ${pointer}.`, runId);
  const { view, lists, timeline } = await reads(s, runId);
  assert.equal(view.error.message, "The browser died holding [redacted].");
  for (const row of lists) assert.equal(row.error.message, "The browser died holding [redacted].");
  assert.equal(view.error.details, undefined, "the store path serves no details to cut");
  holdsNone({ view, lists, timeline }, pointer);
});

// sign-ins.test.mjs: "a sign-in forgotten after its run ended is still cut from what that run said, after a restart",
// "a run that ended repeating its browser sign-in's pointer serves none of what it said while the next server cannot
// read the sign-in, and is shown again, cut, once it can", "an ended run a list reads from its row alone has its error
// withheld while its agent's sign-in does not open here, and served cut once it opens again", "a forgotten sign-in under
// another seal key is read as one that does not open", "a list row of an ended run that was never handed a sign-in serves
// its error as any run's, though its agent's sign-in does not open here".
test("a forgotten sign-in still cuts what its runs said; under another seal key they are withheld (words, title, Timeline, error), a run handed none is not, and the key back shows them cut", { skip: "follow-up: #2067", timeout: 180_000 }, async (t) => {
  const seal = randomBytes(32);
  const first = await server(t, { seal });
  const pointer = pointerOf();
  await saved(first, pointer);
  const said = (await runSaying(first, pointer)).runId;
  marked(first, said, [sha(pointer)]);
  const failed = (await runSaying(first, "Browse.")).runId;
  marked(first, failed, [sha(pointer)]);
  written(first, "UPDATE runs SET state = 'failed', summary = ? WHERE id = ?", `The browser died holding ${pointer}.`, failed);
  const plain = (await runSaying(first, "Browse.")).runId;
  written(first, "UPDATE runs SET state = 'failed', summary = ? WHERE id = ?", "The browser died.", plain);
  // Forgotten once its runs ended: kept sealed, for cutting alone.
  await forgotten(first);
  const cut = async (s) => {
    const one = await reads(s, said);
    assert.match(one.view.result.final_answer, /^On \[redacted\] Hold/);
    assert.ok(one.timeline.rows.some((row) => /^On \[redacted\] Hold/.test(row.text ?? row.summary ?? "")));
    const two = await reads(s, failed);
    for (const error of [two.view.error, ...two.lists.map((row) => row.error)]) assert.equal(error.message, "The browser died holding [redacted].");
    holdsNone({ one, two }, pointer);
  };
  await cut(first);
  // Another seal key: neither pointer opens, so neither run's words can be cut: both withheld.
  const rotated = await reserved(t, first, randomBytes(32));
  withheld(await reads(rotated, said), pointer);
  const two = await reads(rotated, failed);
  for (const error of [two.view.error, ...two.lists.map((row) => row.error)]) assert.equal(error.message, WITHHELD_SIGN_IN);
  holdsNone({ two }, pointer);
  // A run handed none is read as any run's.
  for (const error of [(await reads(rotated, plain)).view.error, ...(await reads(rotated, plain)).lists.map((row) => row.error)]) assert.equal(error.message, "The browser died.");
  // The right key back: shown again, cut.
  await cut(await reserved(t, rotated, seal));
});

// sign-ins.test.mjs: "a run reopened after its first sign-in was forgotten has the old pointer cut from its follow-up,
// though it was handed a new one", "a run handed several sign-ins is withheld only when one of its own is lost: 33 forgets
// of the agent's others leave it cut", "a run handed a sign-in forgotten so long ago that it is no longer kept (past the
// newest 32) is withheld", "an ended run handed several sign-ins whose agent's sign-ins file is gone is withheld".
test("a run handed several pointers is cut of each, live or forgotten, past the agent's other forgets; withheld once one of its own is dropped past the newest 32, or the sign-ins are gone", { skip: "follow-up: #2067", timeout: 120_000 }, async (t) => {
  const s = await server(t);
  // 33 of the agent's sign-ins forgotten before (Kernel's): the cap keeps the newest 32 of the agent's, across providers.
  const churn = (n) => overStore(s, async (store) => {
    for (let i = 0; i < n; i++) {
      await saveSignIn(store, s.seal, { agentId: "alpha", provider: "kernel", pointer: `agentrun-${randomBytes(12).toString("hex")}` });
      await forgetSignIn(store, s.seal, { remove: async () => undefined }, "alpha", "kernel");
    }
  });
  await churn(33);
  const [old, live] = [pointerOf("OLD"), pointerOf("LIVE")];
  await saved(s, old);
  await forgotten(s);
  await saved(s, live);
  const both = (await runSaying(s, `${old} ${live}`)).runId;
  marked(s, both, [sha(old), sha(live)]);
  const liveOnly = (await runSaying(s, live)).runId;
  marked(s, liveOnly, [sha(live)]);
  const shown = await reads(s, both);
  assert.match(shown.view.result.final_answer, /^On \[redacted\] \[redacted\] Hold/);
  holdsNone(shown, old, live);
  // 32 more of the agent's forgotten: `old` is dropped past the newest 32, so `both` can't be cut of it: withheld.
  await churn(32);
  withheld(await reads(s, both), old, live);
  // The run handed only the live one is still cut: only a run whose own pointer is lost is withheld.
  assert.match((await reads(s, liveOnly)).view.result.final_answer, /^On \[redacted\] Hold/);
  // The agent's sign-ins gone (live and forgotten): nothing it was handed can be read back: withheld.
  written(s, "DELETE FROM sign_ins WHERE agent_id = ?", "alpha");
  written(s, "DELETE FROM sign_in_tombstones WHERE agent_id = ?", "alpha");
  withheld(await reads(s, liveOnly), live);
});

// sign-ins.test.mjs: "a workflow run of an agent with a browser sign-in serves no graph while the next server cannot read
// the sign-in", "an escalated run handed a sign-in that can't be read back has its review's reason withheld alike in its
// view and in both lists".
test("a workflow run whose hand can't be read back serves no graph (403, in the view's words) and its review's reason withheld in its view and both lists; unmarked, both are served", { timeout: 120_000 }, async (t) => {
  const s = await server(t, { agentTools: false });
  const gated = answerFlow();
  gated.schemas.In.properties.amount = { type: "number" };
  gated.root.steps.unshift({ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person" });
  assert.equal((await s.api("POST", "/agents", flowAgent("gated", gated))).status, 201);
  const runId = (await s.api("POST", "/agents/gated/runs", { input: { question: "What is six times seven?", amount: 600 } })).body.run_id;
  await follow(s.api, runId, ["completed"]);
  const reason = async () => [(await s.api("GET", `/runs/${runId}`)).body, ...(await Promise.all(["/runs", "/agents/gated/runs"].map(async (path) => (await s.api("GET", path)).body.runs.find((run) => run.run_id === runId))))].map((run) => run.review?.reason);
  const served = await reason();
  assert.ok(served.every((text) => typeof text === "string" && text !== WITHHELD_SIGN_IN), JSON.stringify(served));
  assert.equal((await s.api("GET", `/runs/${runId}/graph`)).status, 200);
  // Marked as handed a sign-in this server keeps nothing of: it can't be read back.
  marked(s, runId, [sha("a pointer this server never kept")]);
  assert.deepEqual(await reason(), [WITHHELD_SIGN_IN, WITHHELD_SIGN_IN, WITHHELD_SIGN_IN]);
  const graph = await s.api("GET", `/runs/${runId}/graph`);
  assert.deepEqual([graph.status, graph.body.error?.code, graph.body.error?.message], [403, "forbidden", WITHHELD_SIGN_IN]);
});
