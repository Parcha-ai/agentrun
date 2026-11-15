import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Client } from "@/lib/client";
import type { Standing } from "@/lib/learningLoop";
import type { ReplayRead } from "@/lib/v2";

// A revision that is not serving, replayed by its owner: Replay posts a replay on the server's default inputs
// (POST .../revisions/{digest}/replays) and the card shows its progress from the GET until the server decides it, then
// the decision in one sentence (the read's own words) and the score. A 409 shows the server's words. The card's tab reads
// again when it is decided (`onDecided`), so the standing beside it says what the replay made of it.

/** How long the card waits between two reads of a running replay. */
export const POLL_MS = 3000;

/** Whether a revision's standing offers Replay: one the server would take (not serving, served before, refit, or
 *  replaying already, which it refuses: 409). */
export const replayable = (standing: Pick<Standing, "word">): boolean => standing.word === "Held" || standing.word === "Not decided" || standing.word === "Superseded";

type State =
  | { at: "idle" }
  | { at: "starting" }
  | { at: "running"; replay: string; read: ReplayRead | null; unread?: string }
  | { at: "decided"; read: ReplayRead }
  | { at: "refused"; message: string; code: string | null };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const pts = (d: number) => `${d >= 0 ? "+" : ""}${Math.round(d * 1000) / 10} pts`;
const inputs = (n: number) => `${n} graded ${n === 1 ? "input" : "inputs"}`;

/** What a running replay has done so far, in one line. */
export function progressLine(read: ReplayRead | null): string {
  if (!read) return "Replay started: its runs are queued.";
  const o = read.outcomes;
  const done = o.answered + o.handed_back + o.failed + o.skipped_write;
  return `Replaying on ${inputs(read.inputs)}: ${done} of ${read.inputs} ended (${o.answered} answered alone, ${o.handed_back} handed back${o.failed ? `, ${o.failed} failed` : ""}${o.skipped_write ? `, ${o.skipped_write} skipped` : ""}).`;
}

/** The decision of a replay in one sentence, the read's own words after its verdict, and its score. */
export function decisionLine(read: ReplayRead): { text: string; score: string | null } {
  const reason = read.reason ? ` ${read.reason}` : "";
  const text = read.status === "failed" ? `The replay did not finish.${reason}` : read.decided === "promote" ? `Promoted: it serves first now.${reason}` : read.decided === "hold" ? `Still held.${reason}` : read.decided === "superseded" ? `Superseded.${reason}` : `Decided.${reason}`;
  const s = read.score;
  return { text, score: s.n > 0 ? `Workflow ${pct(s.wf_acc)} vs agent ${pct(s.agent_acc)} on ${inputs(s.n)} (${pts(s.delta)}), ${s.handed_back} handed back` : null };
}

/** The Replay button of one revision of a learned workflow, and what its replay is doing or decided. */
export function ReplayRevision({ v2, agentId, workflow, digest, offered, onDecided, pollMs = POLL_MS }: { v2: Client; agentId: string; workflow: string; digest: string; offered: boolean; onDecided?: () => void; pollMs?: number }) {
  const [state, setState] = useState<State>({ at: "idle" });
  // Another revision's card never shows this one's replay.
  useEffect(() => { setState({ at: "idle" }); }, [workflow, digest]);
  const decided = useRef(onDecided);
  decided.current = onDecided;
  const replay = state.at === "running" ? state.replay : null;
  const unread = state.at === "running" ? state.unread : undefined;
  // A running replay is read now, and again every `pollMs` until the server says it is decided or failed.
  useEffect(() => {
    if (replay === null || unread !== undefined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      Promise.resolve().then(() => v2.learnedWorkflowReplay(agentId, workflow, digest, replay)).then((read) => {
        if (!live) return;
        if (read.status === "running") { setState({ at: "running", replay, read }); timer = setTimeout(look, pollMs); return; }
        setState({ at: "decided", read });
        decided.current?.();
      }, (e: unknown) => { if (live) setState((s) => (s.at === "running" ? { ...s, unread: e instanceof Error ? e.message : String(e) } : s)); });
    };
    look();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [v2, agentId, workflow, digest, replay, unread, pollMs]);
  const start = () => {
    setState({ at: "starting" });
    Promise.resolve().then(() => v2.startLearnedWorkflowReplay(agentId, workflow, digest)).then(
      (r) => setState({ at: "running", replay: r.replay, read: null }),
      (e: unknown) => {
        const code = (e as { code?: unknown })?.code;
        setState({ at: "refused", message: e instanceof Error ? e.message : String(e), code: typeof code === "string" ? code : null });
      },
    );
  };
  const busy = state.at === "starting" || state.at === "running";
  // A decided replay keeps its sentence after the tab reads again and the revision's standing no longer offers Replay.
  if (!offered && state.at === "idle") return null;
  return (
    <div className="mt-2 space-y-1" data-testid="replay-revision">
      {(state.at === "idle" || state.at === "starting" || state.at === "refused" || state.at === "decided") && (
        <Button size="sm" onClick={start} disabled={busy} aria-label={`Replay revision ${digest.slice(0, 7)} on graded inputs`}>{state.at === "starting" ? "Starting…" : state.at === "idle" ? "Replay" : "Replay again"}</Button>
      )}
      {state.at === "running" && (
        <p className="break-words text-body" role="status" data-testid="replay-progress">
          {state.unread !== undefined ? `Couldn't read the replay: ${state.unread} ` : progressLine(state.read)}
          {state.unread !== undefined && <button type="button" className="underline underline-offset-2" onClick={() => setState({ at: "running", replay: state.replay, read: state.read })}>Check again</button>}
        </p>
      )}
      {state.at === "refused" && (
        <p className="break-words text-body" role="alert" data-testid="replay-refused">
          {state.message}{state.code && <span className="ml-2 font-mono text-label text-muted-foreground">{state.code}</span>}
        </p>
      )}
      {state.at === "decided" && (() => {
        const d = decisionLine(state.read);
        return (
          <div role="status" data-testid="replay-decision">
            <p className="break-words text-body">{d.text}</p>
            {d.score && <p className="break-words font-mono text-label text-muted-foreground" data-testid="replay-score">{d.score}</p>}
          </div>
        );
      })()}
    </div>
  );
}
