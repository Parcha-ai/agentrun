import { Plus } from "lucide-react";
import { useState } from "react";
import { ToolCard } from "@/components/ToolCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { matchesFilter } from "@/lib/filter";
import { isMonidName, monidGrantOf, monidGrantText, monidNameProblem } from "@/lib/monid";

/** What a grant's card says it is: one endpoint, or every endpoint of its provider that monid prices per call. */
const cardLine = (grant: string): string => {
  const g = monidGrantOf(grant);
  if (!g) return "Not a monid endpoint's name: the save refuses it. Untick it.";
  return g.endpoint === null
    ? `Every endpoint of ${g.provider} that monid prices per call, as monid lists them when the agent is saved.`
    : `${g.provider}'s /${g.endpoint}, priced and pinned when the agent is saved.`;
};

/** The monid grants the Tools step shows: each `listed` or granted, that `filter` keeps by its name or its card's line.
 *  MonidGrants draws them and the step's count adds them. */
export const monidCards = (tools: readonly string[], listed: readonly string[], filter: string): string[] =>
  [...new Set([...listed, ...tools].filter(isMonidName))].filter((g) => matchesFilter(filter, g, cardLine(g)));

/** The Tools step's monid row: the agent's monid grants, a card each (untick one to take it away; it stays listed, to tick
 *  again), and a field that grants another by its name, `monid:<provider>/<endpoint>` or `monid:<provider>/*`. The
 *  field checks the name's shape only; the save reads monid's listing and is the judge of the rest. `listed`: the grants
 *  to show unticked too, which the editor keeps (every grant its form has shown), so a card outlives a save and a step
 *  change. `notes`: what the last save's
 *  answer said of a grant (each endpoint monid prices by usage), in the server's words; `refused`: why the last save was
 *  refused at a grant, in the server's words. */
export function MonidGrants({ tools, listed = [], filter, notes = [], refused = [], onChange }: {
  tools: readonly string[]; listed?: readonly string[]; filter: string;
  notes?: readonly { grant: string; message: string }[]; refused?: readonly { grant: string; message: string }[];
  onChange: (tools: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const grants = monidCards(tools, listed, filter);
  const toggle = (grant: string) => onChange(tools.includes(grant) ? tools.filter((t) => t !== grant) : [...tools, grant]);
  const grant = () => {
    const name = monidGrantText(text);
    if (!name) return;
    const why = monidNameProblem(name);
    setProblem(why);
    if (why) return;
    setText("");
    if (!tools.includes(name)) onChange([...tools, name]);
  };
  return (
    <section aria-label="monid endpoints" className="mt-4 space-y-2">
      <p className="caps text-label font-semibold text-muted-foreground">monid · paid endpoints</p>
      {grants.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-start gap-2">
          {grants.map((g) => {
            const no = refused.filter((r) => r.grant === g);
            return <li key={g} className="min-w-0"><ToolCard value={g} name={g} description={cardLine(g)} alert={no.length ? "The save was refused here: see below." : undefined} warn={no.length > 0} on={tools.includes(g)} disabled={false} onToggle={() => toggle(g)} /></li>;
          })}
        </ul>
      )}
      <form className="flex max-w-3xl flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); grant(); }}>
        <Input aria-label="monid grant" value={text} onChange={(e) => { setText(e.target.value); setProblem(undefined); }} aria-invalid={problem ? true : undefined}
          placeholder="monid:<provider>/<endpoint> or monid:<provider>/*" className="min-w-0 flex-[1_1_18rem]" spellCheck={false} autoCapitalize="off" autoComplete="off" />
        <Button type="submit" size="sm" className="h-control-md" disabled={!text.trim()}><Plus aria-hidden /> Grant</Button>
      </form>
      {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      <p className="text-small text-muted-foreground">A grant is priced and pinned when the agent is saved, from what monid lists then. monid's key is set in Settings → API Keys.</p>
      {refused.length > 0 && (
        <ul className="space-y-1 font-mono text-small text-destructive-text" role="alert" aria-label="monid grants refused">
          {refused.map((r, i) => <li key={`${r.grant}:${i}`}>{r.message}</li>)}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1 font-mono text-small text-warning-text" role="status" aria-label="monid save warnings">
          {notes.map((n, i) => <li key={`${n.grant}:${i}`}>{n.message}</li>)}
        </ul>
      )}
    </section>
  );
}
