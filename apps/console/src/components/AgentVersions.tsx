import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/Skeleton";
import { ProblemCard } from "@/components/Problem";
import type { Agent } from "@/lib/agentForm";
import type { Client } from "@/lib/client";
import { when } from "@/lib/format";
import { problem, type Problem } from "@/lib/problem";

type Revision = Awaited<ReturnType<Client["listRevisions"]>>["revisions"][number];

/** Immutable definitions of this agent. Changes are made through the page's Edit agent action. */
export function AgentVersions({ agent, v2 }: { agent: Agent; v2: Client }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [reading, setReading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const read = async (after: string | null) => {
    if (busy.current) return;
    busy.current = true;
    const n = ++generation.current;
    setReading(true);
    try {
      const page = await v2.listRevisions(agent.agent_id, after);
      if (n !== generation.current) return;
      setRevisions((previous) => {
        const merged = new Map((after ? previous ?? [] : []).map((revision) => [revision.revision, revision]));
        for (const revision of page.revisions) merged.set(revision.revision, revision);
        return [...merged.values()];
      });
      setCursor(page.next_cursor); setError(null);
    } catch (e) { if (n === generation.current) setError(problem(e, after ? "more versions" : "the versions")); }
    finally { if (n === generation.current) { busy.current = false; setReading(false); } }
  };
  useEffect(() => {
    busy.current = false; setRevisions(null); setCursor(null); setError(null); setExpanded(null);
    void read(null);
    return () => { generation.current++; busy.current = false; };
  }, [v2, agent.agent_id, agent.revision, agent.revisions]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !revisions) return <ProblemCard problem={error} onRetry={() => void read(null)} className="" />;
  if (!revisions) return <ListSkeleton label="Loading versions" rows={4} />;
  return <section className="overflow-hidden border" aria-label="Agent versions">
    <div className="border-b px-4 py-3 text-body text-muted-foreground">{agent.revisions} {agent.revisions === 1 ? "version" : "versions"} · Current version {agent.definition.version}</div>
    {revisions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-small" aria-label="Versions">
      <thead className="border-b bg-card text-muted-foreground"><tr>{["Version", "Created", "Note", "Configuration"].map((label) => <th key={label} className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead>
      <tbody>{revisions.map((revision) => <Fragment key={revision.revision}>
        <tr className="border-b last:border-b-0">
          <td className="whitespace-nowrap px-4 py-3"><span className="font-semibold">v{revision.version}</span>{revision.revision === agent.revision && <span className="ml-2 bg-primary/10 px-2 py-1 text-micro text-primary-text">Current</span>}</td>
          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(revision.created_at)}</td>
          <td className="min-w-40 px-4 py-3 text-muted-foreground">{revision.note || "—"}</td>
          <td className="px-4 py-3"><Button size="sm" aria-expanded={expanded === revision.revision} aria-label={`View configuration for version ${revision.version}`} onClick={() => setExpanded((current) => current === revision.revision ? null : revision.revision)}>{expanded === revision.revision ? "Hide" : "View"}</Button></td>
        </tr>
        {expanded === revision.revision && <tr className="border-b bg-card"><td colSpan={4} className="p-4"><p className="mb-3 break-all font-mono text-label text-muted-foreground">{revision.revision}</p><pre aria-label={`Version ${revision.version} configuration`} className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words font-mono text-small">{JSON.stringify(revision.definition, null, 2)}</pre></td></tr>}
      </Fragment>)}</tbody>
    </table></div> : <p className="p-10 text-center text-body text-muted-foreground">No versions were returned for this agent.</p>}
    {error && <ProblemCard problem={error} className="m-4" />}
    {cursor && <div className="flex justify-center p-4"><Button size="sm" disabled={reading} onClick={() => void read(cursor)}>{reading ? "Loading" : "Load more versions"}</Button></div>}
  </section>;
}
