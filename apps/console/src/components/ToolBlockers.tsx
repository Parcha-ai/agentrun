import { toolBlockers } from "@/lib/toolSettings";

/** Where a start refused for a workflow call node's tool (set to deny, or to ask, which a call node can't wait for) is
 *  fixed: the agent's own Tools, on that tool's permission, or every agent's, Settings → Tools. Nothing when the refusal
 *  names no such tool. The server's own words are said beside it, by the caller. */
export function ToolBlockers({ agentId, details }: { agentId: string; details: Record<string, unknown> | null | undefined }) {
  const { denied, asks } = toolBlockers(details);
  const tools = [...new Set([...denied, ...asks])];
  if (!tools.length) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {tools.map((tool) => <a key={tool} href={`#/agents/${encodeURIComponent(agentId)}/edit?tool=${encodeURIComponent(tool)}`} className="underline underline-offset-4">Set {tool} for this agent</a>)}
      <span>or for every agent: <a href="#/settings/tools" className="underline underline-offset-4">Settings → Tools</a></span>
    </p>
  );
}
