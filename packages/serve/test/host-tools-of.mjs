// The host tools `names` names over pi registrations `tools`, as the runner binds a tool a harness other than pi calls
// (host-tools.ts hostToolOf): each by its catalog name, its registration found by its wire name, on the run's
// environment (`run.env`) and, when the test gives one, its Harness (`run.harness`: the api's commit, snapshot,
// conversation, waitForTask and root agent). A member the test gives no run for throws when a tool reads it.
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { wireName } from "../dist/catalog.js";
import { hostToolOf } from "../dist/host-tools.js";

const none = (what) => () => { throw new Error(`this test's run has no ${what}`); };

export function hostToolsOf(run, names, context, results, tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const harness = run.harness;
  const ctx = {
    context,
    results,
    env: run.env ?? (async () => ({})),
    commit: harness ? (change, at, options) => harness.commit(change, at, options) : none("store"),
    snapshot: harness ? (...args) => Reflect.apply(harness.snapshot, harness, args) : none("Harness"),
    conversation: harness ? (id, at) => harness.conversation(id, at) : none("Harness"),
    waitForTask: harness ? (id, at) => harness.waitForTask(id, at) : none("Harness"),
    agent: harness
      ? async (at) => {
          const root = await harness.conversation(ROOT_CONVERSATION_ID, at);
          if (!root) throw new Error("the run has no root conversation");
          return root.agent(at);
        }
      : none("Harness"),
  };
  return names.flatMap((name) => {
    const tool = byName.get(wireName(name));
    const host = tool ? hostToolOf(name, tool, ctx) : undefined;
    return host ? [host] : [];
  });
}
