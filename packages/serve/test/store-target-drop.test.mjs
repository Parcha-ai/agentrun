// store-target.mjs dropSchema, against a connection that keeps its own transaction going in the schema (a server a test
// drops the schema under): the drop takes each table's lock in Postgres' order, so a transaction that holds one table and
// wants another can meet it in a cycle, and Postgres ends one of the two as the victim ("deadlock detected", 40P01): the
// drop, in the case this file is about, or the holder, which this file tries again. The drop asks again and the schema
// goes. Both orders of the two tables are tried, so one of them is the cycle whichever order Postgres drops them in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { client, dropSchema, freshSchema, postgresOnly } from "./store-target.mjs";

/** The deadlocks Postgres has counted in this database (its statistics land within a second of the transaction's end). */
const deadlocks = async (db) => Number((await db.query("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()")).rows[0].deadlocks);

/** One try: the holder takes `first`, the drop waits on it, the holder wants `second`. `{ holderLost: true }` when Postgres
 *  ended the holder as the cycle's victim (the drop then went through with no retry, so this try showed nothing). */
async function contend(first, second) {
  const schema = await freshSchema();
  const setup = await client();
  const holder = await client();
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`CREATE TABLE ${schema}.a (id int)`);
    await setup.query(`CREATE TABLE ${schema}.b (id int)`);
    await holder.query("SET lock_timeout = '30s'");
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${schema}.${first}`);
    const before = await deadlocks(setup);
    const dropped = dropSchema(schema);
    // The drop is waiting for the holder's lock: only then does the holder want the other table.
    for (let waited = 0; ; waited += 20) {
      const { rows } = await setup.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [`DROP SCHEMA IF EXISTS ${schema} %`]);
      if (rows.length) break;
      assert.ok(waited < 20_000, "the drop never waited on the holder's lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let holderLost = false;
    try {
      // Granted at once (the drop does not hold it), or after the drop gave way as the deadlock's victim.
      await holder.query(`LOCK TABLE ${schema}.${second}`);
      await holder.query("COMMIT");
    } catch (error) {
      // The holder's own deadlock check ran after the cycle formed and chose the holder: its transaction is over.
      if (error?.code !== "40P01") throw error;
      holderLost = true;
      await holder.query("ROLLBACK");
    }
    await dropped;
    const { rows } = await setup.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
    assert.deepEqual(rows, [], "the schema is gone");
    if (holderLost) return { holderLost };
    // A cycle that formed was counted once: the drop was its victim, and its retry is what dropped the schema.
    let counted = 0;
    for (let waited = 0; waited < 5_000 && counted < 1; waited += 100) {
      counted = (await deadlocks(setup)) - before;
      if (counted < 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { holderLost, retried: counted >= 1 };
  } finally {
    await holder.end().catch(() => undefined);
    await setup.end().catch(() => undefined);
  }
}

test("dropSchema drops a schema whose other connection holds one table and then wants the other while the drop waits, in both orders: a drop that is the deadlock's victim is asked again", { ...postgresOnly("a deployment's Postgres store"), timeout: 120_000 }, async () => {
  // Only the order opposite to the one Postgres drops in is a cycle; the other order is no cycle at all (the holder is
  // granted the second table at once). A try where the holder lost the cycle is run again on a fresh schema. Every try
  // drops the schema; the cycle must have been the drop's, retried, in at least one order, in at most 8 tries each.
  const tries = [];
  let retried = false;
  for (const order of [["a", "b"], ["b", "a"]]) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await contend(order[0], order[1]);
      tries.push({ order: order.join(""), ...result });
      if (!result.holderLost) break;
    }
    retried ||= tries.some((one) => one.retried);
  }
  assert.ok(retried, `the drop was never the deadlock's victim, so its retry was not exercised: ${JSON.stringify(tries)}`);
});
