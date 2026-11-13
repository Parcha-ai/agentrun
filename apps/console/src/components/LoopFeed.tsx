import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { runLabel, when } from "@/lib/format";
import { kindOf, MARKER_LETTER, MARKER_WORDS, type MarkerKind, recordOf, refitOf, replayLine, standingOf } from "@/lib/learningLoop";
import type { LearningLoop, LoopCompile, Promotion, Serving } from "@/lib/v2";

// The learning feed: what the loop did, newest first. A compile turn (a run's end, any round of it, wrote a workflow from
// its notes: which notes went in, each attempt, and where that revision stands now, as the replay card says it) and each promotion record (a revision replaying,
// promoted, held, refit, or superseded by a newer revision while it replayed, with its numbers). A draft the checks refused says what they said, in their words, never a
// silent nothing; a run whose handed values can't be read says the words are withheld.

/** How many entries show before "Show all". */
const FIRST = 8;

type Entry = { at: string; key: string } & ({ kind: "compile"; compile: LoopCompile } | { kind: "promotion"; record: Promotion });

const MARKER_TONE: Record<MarkerKind, ChipTone> = { promote: "success", hold: "warning", refit: "plain", revision: "active", superseded: "muted" };

/** `serving`: the server's serving digest per workflow (the promotions read's), the one revision that says Serving. */
export function LoopFeed({ loop, promotions, serving = [] }: { loop: LearningLoop | null; promotions: readonly Promotion[]; serving?: readonly Serving[] }) {
  const [all, setAll] = useState(false);
  const entries: Entry[] = [
    ...(loop?.compiles ?? []).map((compile): Entry => ({ at: compile.at, key: `c:${compile.run_id}:${compile.round}`, kind: "compile", compile })),
    ...promotions.map((record, i): Entry => ({ at: record.at, key: `p:${i}`, kind: "promotion", record })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, FIRST);
  return (
    <section className="border" aria-label="Learning feed" data-testid="loop-feed">
      <h2 className="caps flex items-baseline gap-2 border-b px-4 py-3 text-small font-semibold">Learning feed<span className="font-mono font-normal text-muted-foreground">{entries.length}</span></h2>
      <ol className="divide-y">
        {shown.map((entry) => (
          <li key={entry.key} className="min-w-0 px-4 py-3" data-testid={`feed-${entry.kind}`}>
            {entry.kind === "compile" ? <Compiled compile={entry.compile} promotions={promotions} serving={serving.find((one) => one.workflow === entry.compile.workflow)?.digest ?? null} /> : <Decided record={entry.record} />}
          </li>
        ))}
      </ol>
      {entries.length > FIRST && (
        <div className="flex justify-center border-t px-4 py-2"><Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>{all ? "Show fewer" : `Show all ${entries.length}`}</Button></div>
      )}
    </section>
  );
}

const Run = ({ id }: { id: string }) => <a href={`#/runs/${encodeURIComponent(id)}`} className="underline underline-offset-2 hover:text-foreground">run {runLabel(id)}</a>;
const Meta = ({ at, run }: { at: string; run?: string }) => (
  <p className="mt-1 font-mono text-label text-muted-foreground"><time dateTime={at}>{when(at)}</time>{run ? <> · <Run id={run} /></> : null}</p>
);

function Compiled({ compile: c, promotions, serving }: { compile: LoopCompile; promotions: readonly Promotion[]; serving: string | null }) {
  const failed = c.digest === null || c.workflow === null;
  const refused = c.attempts.filter((a) => !a.ok);
  const errors: { e: string; attempt: number | null }[] = [...c.attempts.flatMap((a, i) => (a.ok ? [] : a.errors.map((e) => ({ e, attempt: i + 1 })))), ...c.draft_errors.map((e) => ({ e, attempt: null }))];
  // Its revision's standing as the replay card says it (standingOf): Serving only for the champion the server names, Served
  // for one promoted before it, Refit when a refit of it serves in its place, Held, Replaying, Superseded.
  const standing = failed ? null : standingOf(recordOf(promotions, c.workflow!, c.digest), { serving, refit: refitOf(promotions, c.workflow!, c.digest) });
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {failed ? <Chip tone="error">Draft failed</Chip> : <Chip tone="plain">Compiled</Chip>}
        {c.workflow ? <span className="min-w-0 break-all font-mono text-body font-semibold">{c.workflow}</span> : <span className="text-body text-muted-foreground">no workflow kept</span>}
        {standing && <Chip tone={standing.tone}>{standing.word}</Chip>}
      </div>
      {c.from_notes.length > 0 && (
        <p className="mt-1 break-words text-small text-muted-foreground">From {c.from_notes.length === 1 ? "1 note" : `${c.from_notes.length} notes`}: <span className="font-mono text-foreground">{c.from_notes.join(", ")}</span></p>
      )}
      {c.attempts.length > 0 && (
        <p className="mt-0.5 text-small text-muted-foreground">{c.attempts.length === 1 ? "1 attempt" : `${c.attempts.length} attempts`}{refused.length ? `, ${refused.length} refused by the checks` : ""}{failed ? ": it tries again on a later run." : "."}</p>
      )}
      {c.withheld ? (
        <p className="mt-1 text-small text-warning-text" role="note">The checks' words are withheld here: this run's handed values can't be read to cut them.</p>
      ) : errors.length > 0 && (
        <ul className="mt-1 space-y-0.5" aria-label="What the checks said" data-testid="draft-errors">
          {errors.map(({ e, attempt }, n) => <li key={n} className="break-words font-mono text-small text-destructive-text">{attempt ? `Attempt ${attempt}: ` : ""}{e}</li>)}
        </ul>
      )}
      <Meta at={c.at} run={c.run_id} />
    </div>
  );
}

function Decided({ record }: { record: Promotion }) {
  const kind = kindOf(record);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={MARKER_TONE[kind]}>{MARKER_LETTER[kind]} · {MARKER_WORDS[kind]}</Chip>
        <span className="min-w-0 break-all font-mono text-body font-semibold">{record.workflow}</span>
        <span className="font-mono text-label text-muted-foreground">{record.digest.slice(0, 7)}</span>
      </div>
      <p className="mt-1 break-words text-small text-muted-foreground">{replayLine(record)}</p>
      {record.replay?.n ? record.reason && <p className="mt-0.5 line-clamp-2 break-words text-small text-muted-foreground">{record.reason}</p> : null}
      <Meta at={record.at} />
    </div>
  );
}
