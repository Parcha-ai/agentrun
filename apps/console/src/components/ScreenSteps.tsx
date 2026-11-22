import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RowTitle, rowLabel } from "@/components/Timeline";
import { Spinner } from "@/components/ui/spinner";
import { clock } from "@/lib/format";
import { stepAt, videoClock, type VideoStep } from "@/lib/runVideo";
import { rowFailed, steps as stepsOf } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";

/** The run's screen and its steps: side by side from `xl`, the steps under the screen below that. */
export const SCREEN_WITH_STEPS = "grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem]";

/** The box a list of steps sits in, beside the screen or under it: its title line, then the list. Beside the screen it is
 *  as tall as the screen and the list scrolls in it; under it, the list scrolls in a short box, so the screen stays in
 *  sight. */
function StepsBox({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="relative min-h-0 border-t xl:border-l xl:border-t-0">
      <div className="flex flex-col xl:absolute xl:inset-0">
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b px-4 py-2.5">
          <p className="caps text-small font-semibold">Steps</p>
          <p className="text-label text-muted-foreground">{hint}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
const LIST = "relative max-h-72 min-h-0 flex-1 divide-y overflow-auto xl:max-h-none";
const LINE = "flex w-full items-start gap-3 px-4 py-2 text-left";

/** One step's line: when, then the label and the title the Timeline tab gives the same row. A failed step reads as failed. */
function StepWords({ when, row, wide = false }: { when: string; row: TimelineRow; wide?: boolean }) {
  return (
    <>
      <span className={cn("shrink-0 pt-0.5 font-mono text-label text-muted-foreground", wide ? "w-16" : "w-10")}>{when}</span>
      <span className="min-w-0 flex-1">
        <span className="caps block truncate text-label text-muted-foreground">{rowLabel(row)}</span>
        <span className={cn("line-clamp-3 break-words text-small leading-snug", rowFailed(row) && "text-destructive-text")}><RowTitle row={row} /></span>
      </span>
    </>
  );
}

/** A recording's steps, beside its player: what the run did while the file was recorded (lib/runVideo's videoSteps: the
 *  timeline's own steps and words), each at its time on the video. A step is a button that moves the video there, playing
 *  or paused as it was; the step the video is at is marked, and kept in sight as the video plays. `video` is the player's
 *  element (null until it is drawn). A step's time is its time on the timeline since the recording began. */
export function RunVideoSteps({ video, steps }: { video: HTMLVideoElement | null; steps: readonly VideoStep[] }) {
  const [now, setNow] = useState(-1);
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (!video) return;
    const read = () => setNow(stepAt(steps, video.currentTime));
    read();
    video.addEventListener("timeupdate", read);
    video.addEventListener("seeked", read);
    return () => { video.removeEventListener("timeupdate", read); video.removeEventListener("seeked", read); };
  }, [video, steps]);
  // The step the video is at stays in the list's own view: only the list scrolls, never the page.
  useEffect(() => {
    const box = list.current;
    const at = box?.querySelector<HTMLElement>('[aria-current="step"]')?.parentElement;
    if (!box || !at) return;
    if (at.offsetTop < box.scrollTop) box.scrollTop = at.offsetTop;
    else if (at.offsetTop + at.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = at.offsetTop + at.offsetHeight - box.clientHeight;
  }, [now]);
  const jump = (at: number) => {
    if (!video) return;
    video.currentTime = at;
    setNow(stepAt(steps, at));
  };
  return (
    <StepsBox hint="Click a step to jump to it">
      <ol ref={list} aria-label="The recording's steps" className={LIST}>
        {steps.map(({ step, at }, i) => (
          <li key={step.row.id}>
            <button type="button" onClick={() => jump(at)} aria-current={i === now ? "step" : undefined} className={cn(LINE, "hover:bg-accent", i === now && "bg-accent")}>
              <StepWords when={videoClock(at)} row={step.row} />
            </button>
          </li>
        ))}
      </ol>
    </StepsBox>
  );
}

/** How near its end a list counts as showing it, in px: a reader within a line of the end is still following. */
const END_SLACK = 24;

/** The run's steps so far, beside its live screen: the timeline's own steps and words (lib/timeline's `steps`, less the
 *  run's cost row), oldest first, each at its time of day. The list stays at its newest step as steps come, until the
 *  reader scrolls up to read an earlier one; back at the end, it follows again. `working`: the run is working now, said
 *  under the newest step. */
export function RunLiveSteps({ rows, working }: { rows: readonly TimelineRow[]; working: boolean }) {
  const told = useMemo(() => stepsOf(rows).filter((step) => step.row.kind !== "usage"), [rows]);
  const list = useRef<HTMLOListElement | null>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const box = list.current;
    if (box && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [told.length, working]);
  return (
    <StepsBox hint={`${told.length} ${told.length === 1 ? "step" : "steps"} so far`}>
      <ol ref={list} aria-label="The run's steps" className={LIST} onScroll={(e) => { const box = e.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < END_SLACK; }}>
        {told.map(({ row }) => <li key={row.id} className={LINE}><StepWords when={clock(row.timestamp)} row={row} wide /></li>)}
        {working && <li className={cn(LINE, "items-center text-small text-muted-foreground")}><Spinner /> Working</li>}
      </ol>
    </StepsBox>
  );
}
