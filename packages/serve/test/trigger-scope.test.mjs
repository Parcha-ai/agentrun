// A scoped request's trigger list (trigger-scope.ts): the triggers of its own workspace's agents alone. Ownership is read
// first and confirmed for each listed trigger; a trigger is never listed because a later read left it out, so a trigger of
// another workspace deleted between two reads never reaches this workspace's list. Views are built for its own alone.
import assert from "node:assert/strict";
import { test } from "node:test";

const { triggersInWorkspace } = await import("../dist/trigger-scope.js");

const W1 = "org:one";
const W2 = "org:two";

/** A store of two workspaces' agents and triggers, whose trigger rows a racing W1 delete changes after their first read:
 *  `all()` answers every row, then the W1 trigger is gone for every read after it. Counts each agent workspace read. */
function racingStore() {
  const agents = [
    { id: "agent-1", workspace: W1, archived: false },
    { id: "agent-2", workspace: W2, archived: false },
    { id: "agent-2-old", workspace: W2, archived: true },
  ];
  let rows = [
    { id: "trg-1", agentId: "agent-1", target: { input: { content: "W1's secret plan" } } },
    { id: "trg-2", agentId: "agent-2", target: { input: { content: "W2's" } } },
    { id: "trg-2-old", agentId: "agent-2-old", target: { input: { content: "W2's archived" } } },
  ];
  const reads = { workspace: 0, all: 0 };
  return {
    reads,
    agents: {
      list: async ({ archived = false, workspace } = {}) => agents.filter((a) => a.archived === archived && (workspace === undefined || a.workspace === workspace)),
      workspace: async (id) => {
        reads.workspace += 1;
        return agents.find((a) => a.id === id)?.workspace;
      },
    },
    triggers: {
      all: async () => {
        reads.all += 1;
        const now = rows;
        // W1 deletes its trigger right after this read.
        rows = rows.filter((row) => row.agentId !== "agent-1");
        return now;
      },
    },
  };
}

/** Triggers.list as the server's: every row's view, or the rows whose agent `keep` takes; counts the views built. */
const lister = (store, built) => async (keep) => (await store.triggers.all()).filter((row) => keep === undefined || keep(row.agentId)).map((row) => (built.push(row.id), { id: row.id, target: row.target }));

test("a trigger of another workspace deleted between two reads never reaches this workspace's list", async () => {
  const store = racingStore();
  const listed = await triggersInWorkspace(W2, store, lister(store, []));
  assert.deepEqual(listed.map((view) => view.id).sort(), ["trg-2", "trg-2-old"], "W2's own triggers, archived agent's included");
  assert.ok(!JSON.stringify(listed).includes("W1's secret plan"), "never W1's view, nor its target input");
});

test("the list builds views of this workspace's triggers alone, with no workspace read per trigger", async () => {
  const store = racingStore();
  const built = [];
  await triggersInWorkspace(W2, store, lister(store, built));
  assert.deepEqual(built.sort(), ["trg-2", "trg-2-old"], "no view of a foreign trigger is built");
  assert.equal(store.reads.workspace, 0, "ownership is one read of the workspace's agents, not one per trigger");
  assert.equal(store.reads.all, 1, "the triggers are read once");
});

test("a workspace with no agents lists nothing", async () => {
  const store = racingStore();
  assert.deepEqual(await triggersInWorkspace("org:none", store, lister(store, [])), []);
});
