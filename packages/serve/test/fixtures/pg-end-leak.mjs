// A child of store-target-end.test.mjs (run with `node --test --test-force-exit` on Postgres, never by the suite's
// glob): a test that opens a store and never closes it. Its end (store-target.mjs) must fail it, naming the store's
// connections. It prints its schema ("schema: <name>"), which the parent drops once this process has exited.
import { test } from "node:test";
import { openPostgresStore } from "../../dist/store/index.js";
import { freshSchema, PG_URL } from "../store-target.mjs";

test("a test that leaves its store open", async () => {
  const schema = await freshSchema();
  process.stdout.write(`schema: ${schema}\n`);
  const store = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
});
