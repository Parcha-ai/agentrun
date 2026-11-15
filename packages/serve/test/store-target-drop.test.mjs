// store-target.mjs dropSchema, against a connection that keeps its own transaction going in the schema (a server a test
// drops the schema under): the drop takes each table's lock in Postgres' order, so a transaction that holds one table and
// wants another can meet it in a cycle, and Postgres ends the drop as the victim ("deadlock detected", 40P01). The drop
// asks again and the schema goes. Both orders of the two tables are tried, so one of them is the cycle whichever order
// Postgres drops them in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { client, dropSchema, freshSchema, postgresOnly } from "./store-target.mjs";

for (const order of [["a", "b"], ["b", "a"]]) {
  test(`dropSchema drops a schema whose other connection holds ${order[0]} and then wants ${order[1]} while the drop waits: a drop that is the deadlock's victim is asked again`, { ...postgresOnly("a deployment's Postgres store"), timeout: 60_000 }, async () => {
    const schema = await freshSchema();
    const setup = await client();
    const holder = await client();
    try {
      await setup.query(`CREATE SCHEMA ${schema}`);
      await setup.query(`CREATE TABLE ${schema}.a (id int)`);
      await setup.query(`CREATE TABLE ${schema}.b (id int)`);
      await holder.query("SET lock_timeout = '30s'");
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${schema}.${order[0]}`);
      const dropped = dropSchema(schema);
      // The drop is waiting for the holder's lock: only then does the holder want the other table.
      for (let waited = 0; ; waited += 20) {
        const { rows } = await setup.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [`DROP SCHEMA IF EXISTS ${schema} %`]);
        if (rows.length) break;
        assert.ok(waited < 20_000, "the drop never waited on the holder's lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Granted at once (the drop does not hold it), or after the drop gave way as the deadlock's victim.
      await holder.query(`LOCK TABLE ${schema}.${order[1]}`);
      await holder.query("COMMIT");
      await dropped;
      const { rows } = await setup.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
      assert.deepEqual(rows, [], "the schema is gone");
    } finally {
      await holder.end().catch(() => undefined);
      await setup.end().catch(() => undefined);
    }
  });
}
