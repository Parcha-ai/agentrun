import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type DiffLine, learnedBy, type LearningDiff, type NoteChange, noteChanges } from "@/lib/learning";
import { problem } from "@/lib/problem";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

type Read = { state: "reading" } | { state: "failed"; error: unknown } | { state: "read"; changes: NoteChange[] };

/** What a run's learning changed, read once for a run that kept a note (`learned`), and again on Try again; null for a
 *  run that kept none, or with nothing to read it from. */
export function useRunChanges(run: Pick<Run, "run_id" | "learning">, read?: () => Promise<LearningDiff>) {
  const kept = !!read && learnedBy(run.learning).length > 0;
  const [got, setGot] = useState<Read>({ state: "reading" });
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    if (!kept) return;
    let live = true;
    setGot({ state: "reading" });
    // A reader that throws at once fails the read like one that rejects: the page says so, never breaks.
    Promise.resolve().then(() => read!()).then((diff) => { if (live) setGot({ state: "read", changes: noteChanges(diff, run.learning) }); }, (e) => { if (live) setGot({ state: "failed", error: e ?? new Error("unknown") }); });
    return () => { live = false; };
  }, [run.run_id, kept, asks]); // eslint-disable-line react-hooks/exhaustive-deps
  return kept ? { got, retry: () => setAsks((n) => n + 1) } : null;
}

/** "What it changed": each note the run's learning added, replaced, retired or removed, by its name, its file in small;
 *  each opens to its text before and after, what changed marked. Nothing when it changed no note. */
export function RunChanges({ got, retry }: { got: Read; retry: () => void }) {
  if (got.state === "read" && !got.changes.length) return null;
  const p = got.state === "failed" ? problem(got.error, "what it changed") : null;
  return (
    <section className="border" aria-label="What it changed">
      <h2 className="caps border-b px-4 py-3 text-small font-semibold">What it changed</h2>
      {got.state === "reading" && <p className="px-4 py-3 text-body text-muted-foreground" role="status">Reading what it changed…</p>}
      {p && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-body" role="alert">
          <span className="min-w-0 flex-1">Couldn't read what it changed: {p.why.charAt(0).toLowerCase() + p.why.slice(1)}</span>
          <Button type="button" onClick={retry} size="sm">Try again</Button>
        </div>
      )}
      {got.state === "read" && <ul className="divide-y">{got.changes.map((c) => <li key={c.file}><Change change={c} /></li>)}</ul>}
    </section>
  );
}

function Change({ change: c }: { change: NoteChange }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/40" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-lead" data-said>{c.said}</span>
          <span className="mt-0.5 block break-all font-mono text-label text-muted-foreground">{c.file}</span>
        </span>
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && (c.withheld
        ? <p className="px-4 pb-3 text-body text-muted-foreground">{c.withheld}</p>
        : (
          <div className="grid grid-cols-1 gap-3 px-4 pb-4 md:grid-cols-2">
            <Side name="before" lines={c.before} none="Not there before." />
            <Side name="after" lines={c.after} none="Not there after." />
          </div>
        ))}
    </>
  );
}

/** One side of a note's text, each line on its own, a taken-out or new line marked (a gutter sign, a tint, and words a
 *  screen reader says). */
function Side({ name, lines, none }: { name: "before" | "after"; lines: DiffLine[] | null; none: string }) {
  return (
    <div className="min-w-0 border" data-side={name}>
      <p className="caps border-b px-3 py-2 text-label text-muted-foreground">{name === "before" ? "Before" : "After"}</p>
      {lines === null ? <p className="px-3 py-2 text-body text-muted-foreground">{none}</p> : (
        <pre className="max-h-80 overflow-auto py-2 font-mono text-small leading-[1.7]">
          {lines.map((l, i) => (
            <span key={i} className={cn("flex min-h-[1.7em] px-3", l.mark === "added" && "bg-primary/10", l.mark === "removed" && "bg-destructive/10")}>
              <span aria-hidden className="w-4 shrink-0 select-none text-muted-foreground">{l.mark === "added" ? "+" : l.mark === "removed" ? "−" : ""}</span>
              {l.mark === "added" && <span className="sr-only">Added line: </span>}
              {l.mark === "removed" && <span className="sr-only">Taken out: </span>}
              <span data-mark={l.mark} className={cn("min-w-0 whitespace-pre-wrap break-words", l.mark === "gap" && "text-muted-foreground")}>{l.text}</span>
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
