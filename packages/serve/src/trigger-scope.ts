// A scoped request's trigger list (workspace-scope.ts): the triggers of its own workspace's agents alone.
import type { Agents } from "./store/index.js";

/** The views of the triggers whose agent is in `workspace`. Ownership is read first, in one read per archived state of
 *  the workspace's own agents (a purged one's too), and `list` builds a view only for a trigger whose agent that read
 *  confirmed: a trigger is never listed because a later read left it out, and no other workspace's view is built. */
export async function triggersInWorkspace<V>(workspace: string, store: { agents: Pick<Agents, "list"> }, list: (keep: (agentId: string) => boolean) => Promise<V[]>): Promise<V[]> {
  const owned = new Set<string>();
  for (const archived of [false, true]) for (const agent of await store.agents.list({ archived, purged: true, workspace })) owned.add(agent.id);
  return list((agentId) => owned.has(agentId));
}
