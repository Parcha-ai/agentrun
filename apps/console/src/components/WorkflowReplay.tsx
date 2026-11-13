import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { problem, ProblemCard } from "@/components/learningProblem";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Slider } from "@/components/ui/slider";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import type { Client } from "@/lib/client";
import { runLabel, when } from "@/lib/format";
import { replaySteps } from "@/lib/workflowReplay";
import type { WorkflowRevisions } from "@/lib/v2";

// A learned workflow replayed across its revisions (GET /agents/{id}/learning/workflows/{name}/revisions): the workflow
// the agent runs now, drawn as the console's workflow graph, with a step for each revision that changed it. A step shows
// the graph as it was then, each node marked NEW (first in this revision) or EDITED (its prompt, code, inputs or tier
// changed), one line saying what changed and the revision's date. Play steps through them; the slider and the arrows go
// to any one. The marks are words on the nodes (NEW, EDITED), never colour alone.

/** The latest revisions the replay reads: the server's most. */
const LIMIT = 50;
/** How long a step stays up while playing. */
export const STEP_MS = 1800;

/** The learned workflows in use (`workflows`: the tab's list), one replay at a time, the first by default. Nothing when
 *  none is active. `v2` is read when it shows, and again on Try again. */
export function WorkflowReplay({ v2, agentId, workflows }: { v2: Client; agentId: string; workflows: { name: string; status: string }[] }) {
  const active = workflows.filter((w) => w.status === "active").map((w) => w.name);
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked !== null && active.includes(picked) ? picked : (active[0] ?? null);
  if (name === null) return null;
  return <Replay key={name} v2={v2} agentId={agentId} name={name} choices={active} onPick={setPicked} />;
}

function Replay({ v2, agentId, name, choices, onPick }: { v2: Client; agentId: string; name: string; choices: string[]; onPick: (name: string) => void }) {
  const [data, setData] = useState<WorkflowRevisions | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    // A client without the read (a fake in a test) is a failed read, never a thrown render.
    Promise.resolve().then(() => v2.learnedWorkflowRevisions(agentId, name, LIMIT)).then((r) => { if (live) setData(r); }, (e) => { if (live) setError(e ?? new Error("unknown")); });
    return () => { live = false; };
  }, [v2, agentId, name, asked]);
  const heading = (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
      <h2 className="caps min-w-0 flex-1 text-small font-semibold">How the workflow changed</h2>
      {choices.length > 1 && <Picker small className="w-56 max-w-full" label="Learned workflow" value={name} onChange={onPick} options={choices.map((c) => ({ value: c, label: c }))} />}
    </header>
  );
  if (error && !data) return (
    <section className="border" aria-label="How the workflow changed">{heading}<div className="p-4"><ProblemCard problem={problem(error, "how the workflow changed")} onRetry={() => setAsked((n) => n + 1)} className="" /></div></section>
  );
  if (!data) return <section className="border" aria-label="How the workflow changed" aria-busy>{heading}<div className="p-4"><Bone className="h-48 w-full" /></div></section>;
  return <section className="border" aria-label="How the workflow changed">{heading}<Steps data={data} /></section>;
}

/** The replay of a read: the controls, the step's line and date, its graph. */
export function Steps({ data, stepMs = STEP_MS }: { data: WorkflowRevisions; stepMs?: number }) {
  const { steps, unreadable } = useMemo(() => replaySteps(data.revisions), [data.revisions]);
  const [at, setAt] = useState(Math.max(0, steps.length - 1));
  const [playing, setPlaying] = useState(false);
  // A new read lands on the newest revision, the workflow as it is now.
  useEffect(() => { setAt(Math.max(0, steps.length - 1)); setPlaying(false); }, [steps]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setAt((n) => Math.min(n + 1, steps.length - 1)), stepMs);
    return () => clearInterval(timer);
  }, [playing, steps.length, stepMs]);
  // Playing stops on the newest.
  useEffect(() => { if (playing && at >= steps.length - 1) setPlaying(false); }, [playing, at, steps.length]);
  if (!data.revisions.length) return null;
  if (!steps.length) return <p className="px-4 py-3 text-body text-muted-foreground" role="status">This workflow's revisions can't be read as a workflow{unreadable ? `: ${unreadable} ${unreadable === 1 ? "revision" : "revisions"} did not read` : ""}.</p>;
  const step = steps[Math.min(at, steps.length - 1)]!;
  const n = steps.length;
  const go = (to: number) => { setPlaying(false); setAt(Math.max(0, Math.min(n - 1, to))); };
  const play = () => { if (playing) return setPlaying(false); if (at >= n - 1) setAt(0); setPlaying(true); };
  const shown = `Revision ${Math.min(at, n - 1) + 1} of ${n}, ${when(step.at)}`;
  return (
    <div className="space-y-3 p-4">
      {n > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button size="sm" onClick={play} aria-label={playing ? "Pause the replay" : "Play the replay"} aria-pressed={playing}>{playing ? <Pause aria-hidden /> : <Play aria-hidden />}{playing ? "Pause" : "Play"}</Button>
          <Button size="icon" onClick={() => go(at - 1)} disabled={at <= 0} aria-label="Previous revision"><ChevronLeft aria-hidden /></Button>
          <Button size="icon" onClick={() => go(at + 1)} disabled={at >= n - 1} aria-label="Next revision"><ChevronRight aria-hidden /></Button>
          <Slider min={1} max={n} value={at + 1} onChange={(v) => go(v - 1)} label="Revision" valueText={shown} className="basis-full sm:min-w-[10rem] sm:flex-1 sm:basis-0" />
        </div>
      )}
      <div className="min-w-0">
        <p className="font-mono text-label text-muted-foreground">
          <span>{n > 1 ? `Revision ${at + 1} of ${n}` : "One revision"}</span> · <time dateTime={step.at}>{when(step.at)}</time>
          {" · "}{step.run ? <a href={`#/runs/${encodeURIComponent(step.run)}`} className="underline underline-offset-2 hover:text-foreground">run {runLabel(step.run)}</a> : "a person"}
        </p>
        <p className="mt-1 break-words text-lead" role="status" data-testid="replay-line">{step.line}</p>
        {step.reason && <p className="mt-0.5 line-clamp-2 break-words text-body text-muted-foreground">{step.reason}</p>}
      </div>
      {/* The graph takes the room: a short workflow is drawn up to 1.6x to the card's width, centred (by its margins, so a wide one still scrolls from its start) in a frame at least 280px tall. */}
      <div className="flex min-h-[280px] overflow-auto border bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] p-4">
        <WorkflowGraph graph={step.graph} marks={step.marks} label={`The workflow at revision ${at + 1} of ${n}, as a graph`} minScale={0.5} maxScale={1.6} className="m-auto" />
      </div>
      <div className="space-y-1.5">
        <GraphLegend />
        <p className="font-mono text-label text-muted-foreground"><span className="font-semibold text-foreground">NEW</span> first appears in this revision · <span className="font-semibold text-foreground">EDITED</span> its prompt, code, inputs or tier changed</p>
      </div>
      {(data.total > data.revisions.length || data.truncated || unreadable > 0) && (
        <p className="text-body text-muted-foreground">
          {data.total > data.revisions.length && `The latest ${data.revisions.length} of ${data.total} revisions. `}
          {data.truncated && "Older changes are past the log this server keeps. "}
          {unreadable > 0 && `${unreadable} ${unreadable === 1 ? "revision" : "revisions"} could not be read as a workflow and ${unreadable === 1 ? "is" : "are"} left out.`}
        </p>
      )}
    </div>
  );
}
