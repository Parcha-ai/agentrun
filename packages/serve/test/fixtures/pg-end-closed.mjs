// A child of store-target-end.test.mjs (run with `node --test` on Postgres, never by the suite's glob): the leaking
// child's test, with its store closed and its schema dropped in an after-hook. Its end (store-target.mjs) passes it.
import { test } from "node:test";
import { openPostgresStore } from "../../dist/store/index.js";
import { dropSchema, freshSchema, PG_URL } from "../store-target.mjs";

test("a test that closes its store", async (t) => {
  const schema = await freshSchema();
  process.stdout.write(`schema: ${schema}\n`);
  const store = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  t.after(async () => {
    await store.close();
    await dropSchema(schema);
  });
  await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
});
