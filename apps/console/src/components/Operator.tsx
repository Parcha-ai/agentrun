import { ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@/lib/agentForm";
import { keeper, startBody } from "@/lib/runStart";

/** The hosted console's Operator: one composer. Pick an agent, give it its first message, and the run starts and opens. */
export function Operator({ agents, onStart, error }: { agents: Agent[]; onStart?: (agentId: string, text: string, key: string) => Promise<string | null>; error?: string | null }) {
  const agentic = agents.filter((a) => a.kind === "agentic" && !a.archived_at);
  const [agentId, setAgentId] = useState(agentic[0]?.agent_id ?? "");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useMemo(() => keeper(), []);
  // The list can change under the page (the first agent made, one archived): keep a selection that is in it.
  useEffect(() => { if (!agentic.some((a) => a.agent_id === agentId)) setAgentId(agentic[0]?.agent_id ?? ""); }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    const built = startBody("agentic", { text });
    if (!built.ok || !onStart || !agentId || sending) return;
    setSending(true);
    const refused = await onStart(agentId, text, keys.keyFor(agentId, built.body));
    setSending(false); setProblem(refused);
    if (!refused) keys.done();
  };
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-5 pt-20 text-center">
      <h1 className="text-[26px] font-semibold">What do you want to run?</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">Pick an agent and give it its first message.</p>
      {!agentic.length ? (
        <p className="mt-10 border px-4 py-6 font-mono text-[13px] text-muted-foreground">No agents yet. Make one under Agents, then start it here.</p>
      ) : (
        <form className="mt-10 w-full border bg-card text-left" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <label className="sr-only" htmlFor="operator">First message</label>
          <textarea id="operator" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Summarize the standup: we ship Friday and the FAQ needs a draft."
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(); } }}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 font-mono text-[14px] outline-none placeholder:text-muted-foreground" />
          <div className="flex items-center gap-3 px-3 pb-3">
            <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="h-8 border bg-background px-2 font-mono text-[12px]">
              {agentic.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.definition.name}</option>)}
            </select>
            <span className="flex-1" />
            <button type="submit" aria-label="Start the run" disabled={!text.trim() || sending} className="flex size-8 items-center justify-center border bg-background hover:bg-accent disabled:opacity-45"><ArrowUp className="size-4" aria-hidden /></button>
          </div>
        </form>
      )}
      {(problem || error) && <p className="mt-4 font-mono text-[13px] text-destructive-text" role="alert">{problem ?? error}</p>}
    </div>
  );
}
