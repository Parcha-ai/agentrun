import { useEffect, useState } from "react";
import { Banner, Button, useToast } from "@/components/ui";
import { type Agent, editBody } from "@/lib/agentForm";
import { noAccounts } from "@/lib/auth";
import type { Client } from "@/lib/client";
import { problem } from "@/lib/problem";

/** The names in a sentence: "a", "a and b", "a, b and c". */
const listWords = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What a run from a trigger does at a call that asks, as the warning says it. `waits`: the call waits for an answer
 *  (accounts on); `refused`: no one can answer, so the call is refused at once (accounts off, tool-gate.ts
 *  noApproverText). `skips`: the trigger skips its later firings while a run of it is active (a schedule, which takes no
 *  max_active_runs); a trigger of a pushed or polled source may start more runs instead, so it is not said there. */
export type AskOutcome = "waits" | "refused";
export const ASK_TITLE: Record<AskOutcome, string> = { waits: "Waits for your approval", refused: "Refused without your approval" };
export const askWords = (tools: readonly string[], outcome: AskOutcome = "waits", skips = false) =>
  outcome === "refused"
    ? `A run from this trigger is refused each call of ${listWords(tools)}: each needs your approval, and this server has accounts off, so no one can give it.`
    : `A run from this trigger stops and waits for you when it calls ${listWords(tools)}${skips ? "; later firings are skipped while it waits" : ""}.`;
export const UNATTENDED_FIX = "Run unattended: this agent's tools run without asking when no one is there.";

/** The tools of `agent` whose calls would stop a run started with no one there: those the server says ask
 *  (GET /v2/agents/{id}'s `tools`, each with its permission in force: the gate's own answer, never worked out here),
 *  while the agent's approvals are not "never". None for a workflow agent (it has no approvals to set) or one the read
 *  gave no tools for. */
export function askingTools(agent: Agent | null): string[] {
  if (!agent || agent.kind === "workflow" || agent.definition.approvals === "never") return [];
  return (agent.tools ?? []).filter((t) => t.permission === "ask").map((t) => t.name);
}

/** The warning itself: which tools would stop a run from a trigger, and the one fix. `outcome` and `skips`: as askWords;
 *  `busy`: the fix is being saved; `failed`: why its save did not land. The action is a plain button, never the form's
 *  submit: it sits inside the trigger forms. */
export function UnattendedBanner({ tools, outcome = "waits", skips = false, busy = false, failed, onFix, className }: { tools: readonly string[]; outcome?: AskOutcome; skips?: boolean; busy?: boolean; failed?: string | null; onFix: () => void; className?: string }) {
  return (
    <Banner tone="warning" data-unattended-warning="" className={className} title={ASK_TITLE[outcome]}
      actions={<Button type="button" size="sm" disabled={busy} aria-busy={busy || undefined} onClick={onFix}>{busy ? "Saving" : "Run unattended"}</Button>}>
      <p className="break-words">{askWords(tools, outcome, skips)}</p>
      <p className="mt-1 text-small text-muted-foreground">{UNATTENDED_FIX}</p>
      {failed && <p role="alert" className="mt-2 break-words font-mono text-small text-destructive-text">{failed}</p>}
    </Banner>
  );
}

/** The warning for the agent a trigger starts (`agentId`, none while none is picked): the agent read with its tools
 *  (GET /v2/agents/{id}), and the warning shown while one of them asks. `skips`: the trigger skips later firings while a
 *  run is active (a schedule). Whether a call that asks waits or is refused comes from the server's session read (accounts
 *  off: refused); a read that fails says it waits, the server's default. Run unattended saves a new revision of the agent
 *  with approvals "never" on the agent as the server has it now (its ETag), as the agent editor saves one. A read of the
 *  agent that fails shows nothing: the warning is advice, and the page works without it. */
export function UnattendedWarning({ v2, agentId, skips = false, className }: { v2: Client; agentId: string | null | undefined; skips?: boolean; className?: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [outcome, setOutcome] = useState<AskOutcome>("waits");
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
  const shown = !!agent && agent.agent_id === agentId && tools.length > 0;
  // Read once the warning has something to say: a server with accounts off refuses an ask rather than parking it.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    v2.session().then((r) => { if (live) setOutcome(noAccounts(r) ? "refused" : "waits"); }, () => {});
    return () => { live = false; };
  }, [v2, shown]);
  if (!shown) return null;
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
  return <UnattendedBanner tools={tools} outcome={outcome} skips={skips} busy={busy} failed={failed} onFix={() => void fix()} className={className} />;
}
