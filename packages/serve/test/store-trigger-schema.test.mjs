// The trigger tables as the engine keeps its firings in them (one retry policy): a firing's status is one of due, started,
// sent, skipped, failed, missed and ignored (an ignored push's key kept as a seen key), a pushed firing keeps its tag
// attrs, and a trigger may cap its active runs (1 to 100).
import assert from "node:assert/strict";
import { test } from "node:test";
import { scratchConnection, T0 } from "./store-support.mjs";

async function withTrigger(db) {
  await db.run("INSERT INTO agents (id, name, created_at) VALUES ('agent-1', 'Agent', ?)", T0);
  await db.run(`INSERT INTO triggers (id, agent_id, name, source, target, created_at, updated_at) VALUES ('trg-1', 'agent-1', 'nightly', '{"kind":"schedule"}', '{"kind":"start_run"}', ?, ?)`, T0, T0);
}
const firing = (db, key, status, attrs = null) => db.run("INSERT INTO trigger_firings (trigger_id, key, by, nominal_at, status, at, attrs) VALUES ('trg-1', ?, 'webhook', ?, ?, ?, ?)", key, T0, status, T0, attrs);

test("a firing may be sent or ignored, and keeps its attrs; a status outside the seven is refused", async (t) => {
  const db = await scratchConnection(t);
  await withTrigger(db);
  await firing(db, "fir-sent", "sent");
  await firing(db, "fir-ignored", "ignored", JSON.stringify({ event: "push", delivery: "d-1" }));
  assert.deepEqual(await db.all("SELECT key, status FROM trigger_firings ORDER BY key"), [{ key: "fir-ignored", status: "ignored" }, { key: "fir-sent", status: "sent" }]);
  assert.deepEqual(JSON.parse((await db.get("SELECT attrs FROM trigger_firings WHERE key = 'fir-ignored'")).attrs), { event: "push", delivery: "d-1" });
  await assert.rejects(firing(db, "fir-odd", "queued"), /CHECK constraint failed/, "an unknown status is refused");
});

test("a trigger's max_active_runs is 1 to 100, or none", async (t) => {
  const db = await scratchConnection(t);
  await withTrigger(db);
  await db.run("UPDATE triggers SET max_active_runs = 3 WHERE id = 'trg-1'");
  assert.equal((await db.get("SELECT max_active_runs FROM triggers WHERE id = 'trg-1'")).max_active_runs, 3);
  await db.run("UPDATE triggers SET max_active_runs = NULL WHERE id = 'trg-1'");
  await assert.rejects(db.run("UPDATE triggers SET max_active_runs = 0 WHERE id = 'trg-1'"), /CHECK constraint failed/, "0 is refused");
  await assert.rejects(db.run("UPDATE triggers SET max_active_runs = 101 WHERE id = 'trg-1'"), /CHECK constraint failed/, "past 100 is refused");
});
