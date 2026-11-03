import { CodingAgentHandoff } from "@/components/CodingAgentHandoff";
import type { Agent } from "@/lib/agentForm";

/** Administration launches a reviewed external handoff or the native API playground, pinned to the displayed revision. */
export function RunBar({ agent, endpoint }: { agent: Agent; endpoint?: string }) {
  return (
    <section className="flex flex-wrap items-center gap-3 border-b px-5 py-4 md:px-8" aria-label="Run agent">
      <span className="flex-1 text-[12px] text-muted-foreground">Run rev {agent.definition.version} of {agent.definition.name}</span>
      <CodingAgentHandoff context={{ kind: "run", agentId: agent.agent_id, revision: agent.revision }} serverUrl={endpoint} label="Run with your coding agent" />
      <a href={`#/playground?agent=${encodeURIComponent(agent.agent_id)}&revision=${encodeURIComponent(agent.revision)}`} className="text-[12px] text-primary hover:underline">API playground</a>
    </section>
  );
}
