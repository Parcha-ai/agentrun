// DELETE /v2/agents/{agent_id} of an agent made here (agent-delete.ts purgeAgent): once archived it is purged by the same
// rule as a run. Its revisions' content, its learning, its triggers, its sign-ins, its computer, disk and folders go; each
// of its runs becomes a tombstone; its own row stays as its tombstone (its id, archive and purge times), and every route
// of it is 410 purged. What its runs cost stays in every total. Not archived: 409 agent_not_archived. A run of it live:
// 409 run_not_final, nothing purged. Purging one agent never touches another. An unarchive or a write sent while its
// purge runs is 410 once it ends; after a purge stopped part way, each is 409 agent_not_runnable. An edit whose body
// arrives after the purge is 410 too, and so is a trigger made for it or moved to it: nothing of it is written again.
// Another system's agent keeps its delete whole (agent-delete.test.mjs).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { shadowRunId } from "../dist/learn/audit.js";
import { agentHomeFolder, runFolder } from "../dist/workspace/paths.js";
import { agent, FAUX, follow, serve, startInProcessRunner } from "./support.mjs";

const WINDOW = "from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";

/** A server with a runner of the test's own beside it, which `halt()` closes: a run the test writes to the store after
 *  that is claimed by the test alone, never raced by a runner. */
async function haltable(t, options = {}) {
  const server = await serve(t, { ...options, runner: false });
  const close = await startInProcessRunner(server.data, { ...options, faux: FAUX, mcpOwn: server.own });
  let closed;
  const halt = () => (closed ??= close());
  t.after(halt);
  return { ...server, halt };
}

/** `table.column` of each row of the store's file whose value has `text`. */
function mentions(data, text) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const found = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          const held = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
          if (held?.includes(text)) found.push(`${name}.${column}`);
        }
      }
    }
    return [...new Set(found)].sort();
  } finally {
    db.close();
  }
}

/** Agent `id` made here with `instructions`, and one completed run of it: the run's id. */
async function agentWithRun(api, id, instructions) {
  assert.equal((await api("POST", "/agents", agent(id, { instructions }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: `A question for ${id}.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  return run.body.run_id;
}

const money = async (api) => ({
  meter: (await api("GET", `/usage?${WINDOW}&group_by=meter`)).body,
  agent: (await api("GET", `/usage?${WINDOW}&group_by=agent`)).body,
  stats: (await api("GET", "/stats")).body,
});

test("an archived agent made here is purged: its runs tombstones, its definition gone, its row a tombstone (410 purged), its runs' money kept; the other agent untouched; a second DELETE 204", { timeout: 180_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  const gone = await agentWithRun(api, "gone-agent", "The instructions only this agent holds.");
  const kept = await agentWithRun(api, "kept-agent", "The other agent's instructions.");
  await halt();
  const shadow = shadowRunId(gone);
  const agentRevision = (await store.agents.get("gone-agent")).currentRevision;
  await store.runs.create({ id: shadow, agentId: "gone-agent", revisionId: agentRevision }, { body: { input: { content: "Again." } } });
  await store.runs.update(await store.claim(shadow, "runner-test", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.07 });
  const keptBefore = { agent: (await api("GET", "/agents/kept-agent")).body, run: (await api("GET", `/runs/${kept}`)).body, where: mentions(data, "The other agent's instructions.") };

  const live = await api("DELETE", "/agents/gone-agent");
  assert.deepEqual([live.status, live.body.error?.code], [409, "agent_not_archived"], JSON.stringify(live.body));
  assert.equal((await api("POST", "/agents/gone-agent/archive")).status, 200);
  const before = await money(api);

  const deleted = await api("DELETE", "/agents/gone-agent");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

  assert.deepEqual(await money(api), before, "/usage by meter and agent, and /stats, are as they were");
  const read = await api("GET", "/agents/gone-agent");
  assert.deepEqual([read.status, read.body.error?.code], [410, "purged"], JSON.stringify(read.body));
  assert.deepEqual(Object.keys(read.body.error.details).sort(), ["agent_id", "archived_at", "purged_at"]);
  assert.equal(read.body.error.details.agent_id, "gone-agent");
  for (const path of ["/agents/gone-agent/runs", "/agents/gone-agent/learning"]) {
    assert.equal((await api("GET", path)).status, 410, `GET ${path} is 410`);
  }
  for (const run of [gone, shadow]) assert.equal((await api("GET", `/runs/${run}`)).status, 410, `its run ${run} is a tombstone`);
  assert.ok(!(await api("GET", "/agents?archived=true")).body.agents?.some((one) => one.id === "gone-agent"), "no list shows it");
  assert.deepEqual(mentions(data, "The instructions only this agent holds."), [], "its definition is gone");
  assert.deepEqual(mentions(data, gone), ["runs.id"], "its run is named by its tombstone alone (its shadow's is named after it)");
  assert.ok(!existsSync(dirname(runFolder(data, "gone-agent", gone))), "its run's folder is gone");

  // The other agent is as it was.
  assert.deepEqual((await api("GET", "/agents/kept-agent")).body, keptBefore.agent);
  assert.deepEqual((await api("GET", `/runs/${kept}`)).body, keptBefore.run);
  assert.deepEqual(mentions(data, "The other agent's instructions."), keptBefore.where);
  assert.ok(existsSync(dirname(runFolder(data, "kept-agent", kept))), "and its run's folder");

  assert.equal((await api("DELETE", "/agents/gone-agent")).status, 204, "a second DELETE is 204");
  assert.deepEqual(await money(api), before);
});

test("an archived agent one of whose runs has an audit's shadow and a replay of its input (each started after it) is purged: 204, each run a tombstone, the money kept", { timeout: 180_000 }, async (t) => {
  const { api, store, halt } = await haltable(t);
  const source = await agentWithRun(api, "audited", "Answer.");
  await halt();
  const revisionId = (await store.agents.get("audited")).currentRevision;
  // Made from the source after it, as an audit and a replay make them: the store refuses the source's purge while either
  // is not purged.
  const made = [
    [shadowRunId(source), { input: { content: "A question for audited." }, audit: { of: source, workflow: "flow", digest: "d1" } }, 0.07],
    ["replay-1", { input: { content: "A question for audited." }, replay: { of: source, workflow: "flow", digest: "d1" } }, 0.05],
  ];
  for (const [id, body, costUsd] of made) {
    await store.runs.create({ id, agentId: "audited", revisionId }, { body });
    await store.runs.update(await store.claim(id, "runner-test", { leaseMs: 60_000 }), { state: "ended", costUsd });
  }
  assert.equal((await api("POST", "/agents/audited/archive")).status, 200);
  const before = await money(api);

  const deleted = await api("DELETE", "/agents/audited");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  for (const run of [source, ...made.map(([id]) => id)]) assert.equal((await api("GET", `/runs/${run}`)).status, 410, `its run ${run} is a tombstone`);
  assert.equal((await api("GET", "/agents/audited")).status, 410);
  assert.deepEqual(await money(api), before, "/usage by meter and agent, and /stats, are as they were");
});

test("an archived agent with a live run is 409 run_not_final, nothing purged; once the run ends, the DELETE purges it", { timeout: 120_000 }, async (t) => {
  const { api, store, halt } = await haltable(t);
  const done = await agentWithRun(api, "busy", "Answer.");
  await halt();
  assert.equal((await api("POST", "/agents/busy/archive")).status, 200);
  // A run that reached it before its archive, still held by a runner.
  const revisionId = (await store.agents.get("busy")).currentRevision;
  await store.runs.create({ id: "held-1", agentId: "busy", revisionId }, { body: { input: { content: "Still going." } } });
  const claim = await store.claim("held-1", "runner-test", { leaseMs: 120_000 });

  const refused = await api("DELETE", "/agents/busy");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, ["held-1"]);
  assert.equal((await store.agents.get("busy")).purgedAt, null, "the agent is not purged");
  assert.equal((await store.runs.get(done)).purgedAt, null, "nor its ended run");

  await store.runs.update(claim, { state: "stopped", outcome: "cancelled" });
  assert.equal((await api("DELETE", "/agents/busy")).status, 204);
  for (const run of [done, "held-1"]) assert.ok((await store.runs.get(run)).purgedAt !== null, `${run} is a tombstone`);
});

for (const step of ["after_step_2", "in_step_3"]) {
  test(`an agent's purge stopped ${step.replaceAll("_", " ")} is not purged yet; the next DELETE finishes it`, { timeout: 120_000 }, async (t) => {
    const crash = { done: false };
    const { api, store } = await serve(t, {
      agentDeleteAt: (at) => {
        if (at !== step || crash.done) return;
        crash.done = true;
        throw new Error(`stopped ${at}`);
      },
    });
    const first = await agentWithRun(api, "half", "Answer.");
    const second = await api("POST", "/agents/half/runs", { input: { content: "Another." } });
    await follow(api, second.body.run_id, ["completed"]);
    assert.equal((await api("POST", "/agents/half/archive")).status, 200);
    const stopped = await api("DELETE", "/agents/half");
    assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
    assert.equal((await store.agents.get("half")).purgedAt, null, "the agent is not purged yet");
    assert.equal((await api("GET", "/agents/half")).status, 200);
    assert.equal((await api("DELETE", "/agents/half")).status, 204);
    assert.equal((await api("GET", "/agents/half")).status, 410);
    for (const run of [first, second.body.run_id]) assert.ok((await store.runs.get(run)).purgedAt !== null, `${run} is a tombstone`);
  });
}

/** `promise`, or a failure in words once `ms` have passed. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref())]);

test("an agent being purged takes no unarchive and no write (its home, its definition, its current revision): after a purge stopped part way each is 409 agent_not_runnable until a DELETE finishes it; one sent while the DELETE runs waits for it and is 410 purged, its home and definition never written again",{ timeout: 180_000 }, async (t) => {
  const gate = { stop: false, hold: false };
  const { api, data, store } = await serve(t, {
    agentDeleteAt: async (at) => {
      if (at === "after_step_2" && gate.stop) {
        gate.stop = false;
        throw new Error(`stopped ${at}`);
      }
      if (at !== "in_step_3" || !gate.hold) return;
      gate.hold = false;
      gate.reach();
      await gate.held;
    },
  });
  await agentWithRun(api, "held", "Answer.");
  const homeFile = (name) => ["/agents", "held", "home", "files", name].join("/");
  assert.equal((await api("PUT", homeFile("notes.md"), "kept notes")).status, 200);
  assert.equal((await api("POST", "/agents/held/archive")).status, 200);

  // A purge stopped once its learning went: the agent stays archived and takes no unarchive or write (its home's, its
  // definition's, a move of its current revision).
  const LATE = "Instructions sent while the agent was being purged.";
  const [revision] = (await store.agents.revisions("held")).map((one) => one.id);
  const edit = ["PUT", "/agents/held/definition", { definition: { instructions: LATE } }];
  const move = ["POST", "/agents/held/current", { revision }];
  gate.stop = true;
  assert.equal((await api("DELETE", "/agents/held")).status, 500);
  for (const [method, path, body] of [["POST", "/agents/held/unarchive"], ["PUT", homeFile("late.md"), "late notes"], edit, move]) {
    const answer = await api(method, path, body);
    assert.deepEqual([answer.status, answer.body.error?.code], [409, "agent_not_runnable"], `${method} ${path} after a purge stopped part way: ${JSON.stringify(answer.body)}`);
  }
  assert.ok((await store.agents.get("held")).archivedAt !== null, "it is still archived");

  // The next DELETE, held in its runs' step: an unarchive and a write sent meanwhile wait for it, then are 410.
  gate.hold = true;
  const reached = new Promise((resolve) => (gate.reach = resolve));
  gate.held = new Promise((resolve) => (gate.release = resolve));
  const deleting = api("DELETE", "/agents/held");
  await within(reached, 60_000, "the DELETE reached its runs");
  const unarchiving = api("POST", "/agents/held/unarchive");
  const writing = api("PUT", homeFile("late.md"), "late notes");
  const editing = api(...edit);
  const moving = api(...move);
  await new Promise((resolve) => setTimeout(resolve, 500));
  gate.release();
  const [deleted, unarchived, written, edited, moved] = await Promise.all([deleting, unarchiving, writing, editing, moving]);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  for (const [answer, what] of [[unarchived, "the unarchive"], [written, "the home write"], [edited, "the edit"], [moved, "the move"]]) assert.deepEqual([answer.status, answer.body.error?.code], [410, "purged"], `${what}: ${JSON.stringify(answer.body)}`);
  assert.ok(!existsSync(agentHomeFolder(data, "held")), "its home is not made again");
  assert.deepEqual(mentions(data, LATE), [], "nor its definition written again");
  assert.equal(await store.settings.get("agent.purging.held"), undefined, "its purge's mark goes with it");
});

/** A `method` request of `path` whose JSON body is sent in two parts, its last byte once `finish()` is called: its answer. */
function slowSend(port, token, method, path, body) {
  const text = JSON.stringify(body);
  let finish;
  const answer = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.write(text.slice(0, -1));
    finish = () => req.end(text.slice(-1));
  });
  return { answer, finish };
}

test("an edit of an agent's definition, or a move of its current revision, whose body arrives after its purge is 410 purged: no revision, text or move of it is written", { timeout: 120_000 }, async (t) => {
  const { api, data, store, port, token, halt } = await haltable(t);
  await agentWithRun(api, "edited", "The instructions before.");
  await halt();
  // A second revision, so a move of its current revision back to the first is a write.
  const second = await api("PUT", "/agents/edited/definition", { definition: { instructions: "The instructions after." } });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const [first, current] = (await store.agents.revisions("edited")).map((revision) => revision.id);
  assert.equal((await api("POST", "/agents/edited/archive")).status, 200);

  // Both routes read the agent when they are sent; their bodies come once it is purged.
  const LATE = "Instructions sent while the agent was purged.";
  const editing = slowSend(port, token, "PUT", "/v2/agents/edited/definition", { definition: { instructions: LATE, description: LATE } });
  const moving = slowSend(port, token, "POST", "/v2/agents/edited/current", { revision: first });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const deleted = await api("DELETE", "/agents/edited");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  editing.finish();
  moving.finish();
  for (const [answer, what] of [[await editing.answer, "the edit"], [await moving.answer, "the move"]]) {
    assert.deepEqual([answer.status, answer.body?.error?.code], [410, "purged"], `${what}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual((await store.agents.revisions("edited")).map((revision) => [revision.id, revision.body, revision.skills, revision.note]), [[first, {}, null, null], [current, {}, null, null]], "no revision is added, and each is blank");
  const row = await store.agents.get("edited");
  assert.deepEqual([row.currentRevision, row.name, row.description], [current, "", null], "its current revision is not moved, nor its description written");
  assert.deepEqual(mentions(data, LATE), [], "nothing the edit sent is in the store");
  assert.equal((await api("DELETE", "/agents/edited")).status, 204, "a second DELETE is 204");
  assert.equal((await api("GET", "/agents/edited")).status, 410);
});

test("a trigger made for a purged agent, or moved to it, is 410 purged: nothing written", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  await agentWithRun(api, "gone", "Answer.");
  await agentWithRun(api, "other", "Answer.");
  await halt();
  const LATE = "A trigger named after the purge";
  const trigger = (agentId, extra = {}) => ({ name: LATE, enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: agentId, input: { content: LATE }, max_cost_usd: 0.5 }, ...extra });
  const others = await api("POST", "/triggers", { ...trigger("other"), name: "the other's", target: { kind: "start_run", agent_id: "other", input: { content: "Answer." }, max_cost_usd: 0.5 } });
  assert.equal(others.status, 201, JSON.stringify(others.body));
  assert.equal((await api("POST", "/agents/gone/archive")).status, 200);
  assert.equal((await api("DELETE", "/agents/gone")).status, 204);

  const made = await api("POST", "/triggers", trigger("gone"));
  const moved = await api("PATCH", `/triggers/${others.body.id}`, { target: trigger("gone").target });
  for (const [answer, what] of [[made, "a trigger made for it"], [moved, "a trigger moved to it"]]) {
    assert.deepEqual([answer.status, answer.body?.error?.code], [410, "purged"], `${what}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual((await store.triggers.list("gone")).map((one) => one.id), [], "no trigger of it");
  assert.equal((await store.triggers.get(others.body.id)).agentId, "other", "the other's trigger stays the other's");
  assert.deepEqual(mentions(data, LATE), [], "nothing of either is in the store");
});
