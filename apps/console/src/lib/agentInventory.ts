import type { Agent } from "./agentForm";
import { backendSdkLabel, backendSdkOf } from "./backendSdk";
import { cliLearningLabel, cliLearningOf } from "./cliLearning";
import { nativeReadinessOf, nativeRuntimeLabel } from "./native";
import { matchesFilter } from "./filter";
import { observedSearchTexts, type ObservedSession } from "./observations";

/** An agent's source changes its controls, not whether it belongs in the inventory. */
export function agentInventory(agents: readonly Agent[], sessions: readonly ObservedSession[], { archived = false, query = "" }: { archived?: boolean; query?: string } = {}) {
  const listed = agents.filter((agent) => !!agent.archived_at === archived);
  const latest = archived ? [] : latestAgentSessions(sessions);
  const profiles = new Map(listed.filter((agent) => cliLearningOf(agent.definition)).map((agent) => [agent.agent_id, agent]));
  const moved = new Set(listed.filter(agent => agent.source_sync?.moved).map(agent => agent.agent_id));
  const sources = new Map<string, ReturnType<typeof observedSearchTexts>>();
  for (const session of latest) {
    const id = session.learning?.agent_id;
    if (id && moved.has(id)) sources.set(id, [...(sources.get(id) ?? []), ...observedSearchTexts(session)]);
  }
  // Only an explicit source association can replace a learning profile's separate card. A profile with no retained
  // linked session must remain reachable, including while source telemetry has not been read or is unavailable.
  const represented = new Set(latest.map((session) => session.learning?.agent_id).filter((id) => id && profiles.has(id)));
  const shownAgents = listed.filter((agent) => !represented.has(agent.agent_id) && matchesFilter(query, ...agentSearchTexts(agent), ...(sources.get(agent.agent_id) ?? [])));
  const shownSessions = latest.filter((session) => {
    // Only the server-verified association folds source telemetry into a moved agent. A shared title/path is no proof.
    if (session.learning?.agent_id && moved.has(session.learning.agent_id)) return false;
    const profile = session.learning?.agent_id ? profiles.get(session.learning.agent_id) : undefined;
    return matchesFilter(query, ...observedSearchTexts(session), ...(profile ? agentSearchTexts(profile) : []));
  });
  return { agents: shownAgents, sessions: shownSessions, count: shownAgents.length + shownSessions.length };
}

/** Retain every source state. A disconnected or ended agent still has a detail page and reported history. */
export function latestAgentSessions(sessions: readonly ObservedSession[]): ObservedSession[] {
  const latest = new Map<string, ObservedSession>();
  for (const session of sessions) {
    const before = latest.get(session.id);
    const time = before ? Date.parse(session.received_at) - Date.parse(before.received_at) : 0;
    if (!before || time > 0 || time === 0 && session.sequence >= before.sequence) latest.set(session.id, session);
  }
  return [...latest.values()];
}

/** What an agent is found by (matchesFilter drops the empty ones and lowercases). */
function agentSearchTexts(agent: Agent): (string | null | undefined)[] {
  const native = nativeReadinessOf(agent), cli = cliLearningOf(agent.definition), sdk = backendSdkOf(agent.definition);
  return [agent.definition.name, agent.definition.description, agent.agent_id, agent.definition.harness, agent.definition.model,
    native?.project, native?.machine_id, native?.model, native && nativeRuntimeLabel(native.runtime),
    cli?.project, cli && cliLearningLabel(cli.runtime), sdk && backendSdkLabel(sdk)];
}
