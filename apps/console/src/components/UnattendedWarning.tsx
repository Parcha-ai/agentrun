import { useEffect, useState } from "react";
import { Banner, Button, useToast } from "@/components/ui";
import { type Agent, editBody } from "@/lib/agentForm";
import type { Client } from "@/lib/client";
import { problem } from "@/lib/problem";

/** The names in a sentence: "a", "a and b", "a, b and c". */
const listWords = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The words of the warning, as the trigger forms and a trigger's page say it. */
export const waitsWords = (tools: readonly string[]) => `A run from this trigger stops and waits for you when it calls ${listWords(tools)}; later firings are skipped while it waits.`;
export const UNATTENDED_FIX = "Run unattended: this agent's tools run without asking when no one is there.";

/** The tools of `agent` whose calls would park a run started with no one there: those the server says ask
 *  (GET /v2/agents/{id}'s `tools`, each with its permission in force: the gate's own answer, never worked out here),
 *  while the agent's approvals are not "never". None for a workflow agent (it has no approvals to set) or one the read
 *  gave no tools for. */
export function askingTools(agent: Agent | null): string[] {
  if (!agent || agent.kind === "workflow" || agent.definition.approvals === "never") return [];
  return (agent.tools ?? []).filter((t) => t.permission === "ask").map((t) => t.name);
}

/** The warning itself: which tools would stop a run from a trigger, and the one fix. `busy`: the fix is being saved;
 *  `failed`: why its save did not land. */
export function UnattendedBanner({ tools, busy = false, failed, onFix, className }: { tools: readonly string[]; busy?: boolean; failed?: string | null; onFix: () => void; className?: string }) {
  return (
    <Banner tone="warning" data-unattended-warning="" className={className} title="Waits for your approval"
      actions={<Button size="sm" disabled={busy} aria-busy={busy || undefined} onClick={onFix}>{busy ? "Saving" : "Run unattended"}</Button>}>
      <p className="break-words">{waitsWords(tools)}</p>
      <p className="mt-1 text-small text-muted-foreground">{UNATTENDED_FIX}</p>
      {failed && <p role="alert" className="mt-2 break-words font-mono text-small text-destructive-text">{failed}</p>}
    </Banner>
  );
}

/** The warning for the agent a trigger starts (`agentId`, none while none is picked): the agent read with its tools
 *  (GET /v2/agents/{id}), and the warning shown while one of them asks. Run unattended saves a new revision of the agent
 *  with approvals "never" on the agent as the server has it now (its ETag), as the agent editor saves one. A read that
 *  fails shows nothing: the warning is advice, and the page works without it. */
export function UnattendedWarning({ v2, agentId, className }: { v2: Client; agentId: string | null | undefined; className?: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    setAgent(null); setFailed(null);
    if (!agentId) return;
    let live = true;
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, () => {});
    return () => { live = false; };
  }, [v2, agentId]);
  const tools = askingTools(agent);
  if (!agent || agent.agent_id !== agentId || !tools.length) return null;
  const fix = async () => {
    setBusy(true); setFailed(null);
    try {
      const { agent: now, etag } = await v2.getAgent(agent.agent_id);
      const body = editBody(now, { approvals: "never" }, "Run unattended");
      const { unchanged, ...send } = body;
      const saved = unchanged ? now : (await v2.updateDefinition(agent.agent_id, send, etag)).agent;
      // A write's answer carries no tools: the read's stay, and approvals never ends the warning.
      setAgent((was) => (was?.agent_id === saved.agent_id ? { ...saved, tools: was.tools } : was));
      toast({ title: `${saved.definition.name || saved.agent_id} runs unattended`, tone: "success" });
    } catch (e) {
      // The server's own words where it answered, else why it could not be asked; then what to do.
      const said = problem(e, "the agent");
      setFailed(`Not saved: ${said.said ?? said.why} ${said.next}`);
    }
    setBusy(false);
  };
  return <UnattendedBanner tools={tools} busy={busy} failed={failed} onFix={() => void fix()} className={className} />;
}
