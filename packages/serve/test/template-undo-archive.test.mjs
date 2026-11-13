// A template apply that fails after its agent is made undoes itself: the triggers it made are removed and the agent is
// archived. The archive goes through the trigger engine (triggers.agentArchived), as POST /agents/{id}/archive does, so a
// trigger the undo could not remove is turned off in that same store transaction with the reason agent_archived, never with
// none; unarchiving answers it among the triggers still off, and turning it on works. The failing write is a store seam:
// the trigger's row is written, then the write throws, so the apply never learns its id and the trigger outlives the undo.
// The engine's store is a second handle on the server's own (startServe's `store`), so the agents it reads are the server's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, serve } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");

test("after a template undo, the agent's triggers read disabled agent_archived, and unarchive answers them, each turned on again", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  // The store made as a server makes it, then a second handle on it (as a runner holds one), which the server's trigger
  // engine is handed: the server opens its own, as the store's one owner.
  await (await openSqliteStore({ dataDir: data, role: "server" })).close();
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  let failNext = true;
  // The trigger's row is written, then its write throws: the apply's undo runs with this trigger still in the store.
  const triggers = new Proxy(store.triggers, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name !== "create" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        const row = await value.apply(target, args);
        if (failNext) {
          failNext = false;
          throw new Error("the store failed after the write");
        }
        return row;
      };
    },
  });
  const { api } = await serve(t, { data, store: { agents: store.agents, runs: store.runs, triggers } });
  t.after(() => store.close().catch(() => {}));

  const applied = await api("POST", "/templates/market-monitor/apply", { parameters: { competitors: "Acme (acme.example)" } });
  assert.ok(applied.status >= 400, `the apply failed and was undone: ${applied.status} ${JSON.stringify(applied.body)}`);
  const archived = (await api("GET", "/agents?archived=true")).body.agents;
  assert.equal(archived.length, 1, `the agent it made is archived: ${JSON.stringify(archived)}`);
  const agentId = archived[0].agent_id ?? archived[0].id;
  const left = await store.triggers.list(agentId);
  assert.equal(left.length, 1, "the trigger the undo could not remove is still in the store");
  assert.deepEqual([left[0].enabled, left[0].disabled?.reason], [false, "agent_archived"], `turned off with the agent's archive, by its reason: ${JSON.stringify(left[0].disabled)}`);

  const back = await api("POST", `/agents/${agentId}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.triggers_off, [{ id: left[0].id, name: left[0].name }], "unarchive answers it among the triggers still off");
  const on = await api("PATCH", `/triggers/${left[0].id}`, { enabled: true });
  assert.equal(on.body.enabled, true, JSON.stringify(on.body));
});
