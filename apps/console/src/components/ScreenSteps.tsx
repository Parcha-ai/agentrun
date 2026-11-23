import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RowTitle, rowLabel } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { clock } from "@/lib/format";
import { stepAt, stepCall, videoClock, type VideoStep } from "@/lib/runVideo";
import { rowFailed, steps as stepsOf } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { TimelineRow } from "@/lib/v2";

/** The run's screen and its steps: side by side from `xl`, the steps under the screen below that. */
export const SCREEN_WITH_STEPS = "grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem]";

/** The box a list of steps sits in, beside the screen or under it: its title line, then the list. Beside the screen it is
 *  as tall as the screen and the list scrolls in it; under it, the list scrolls in a short box, so the screen stays in
 *  sight. */
function StepsBox({ hint, children, foot }: { hint: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="relative min-h-0 border-t xl:border-l xl:border-t-0">
      <div className="flex flex-col xl:absolute xl:inset-0">
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b px-4 py-2.5">
          <p className="caps text-small font-semibold">Steps</p>
          <p className="text-label text-muted-foreground">{hint}</p>
        </div>
        {children}
        {foot && <div className="shrink-0 border-t px-4 py-2">{foot}</div>}
      </div>
    </div>
  );
}
const LIST = "relative max-h-72 min-h-0 flex-1 overflow-auto xl:max-h-none";
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
 *  element (null until it is drawn). A step's time is its time on the timeline since the recording began.
 *  `onOpenCall`: where the run's trace can be read, the step the video is at opens in the Dev tools tab when it is a tool
 *  call (by the call's id): what it was given, what it returned, how long it took and what it cost. The button is under
 *  the list and always there, so the list keeps its height as the video plays. */
export function RunVideoSteps({ video, steps, onOpenCall }: { video: HTMLVideoElement | null; steps: readonly VideoStep[]; onOpenCall?: (toolUseId: string) => void }) {
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
  const call = now >= 0 && steps[now] ? stepCall(steps[now].step) : null;
  return (
    <StepsBox hint="Click a step to jump to it" foot={onOpenCall && (
      <Button size="xs" disabled={!call} onClick={() => call && onOpenCall(call)} title={call ? undefined : "The step the video is at is not a tool call"}>Open this step in Dev tools</Button>
    )}>
      <ol ref={list} aria-label="The recording's steps" className={cn(LIST, "divide-y")}>
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
 *  run's cost row), oldest first, each at its time of day. The list stays at its newest step as steps come and as a
 *  step's words change (a call's become its result's, which can take more lines), until the reader scrolls up to read
 *  an earlier one; back at the end, it follows again. `working`: the run is working now, said under the newest step.
 *  The box scrolls and holds no control, so it takes the focus itself: the keyboard scrolls it. */
export function RunLiveSteps({ rows, working }: { rows: readonly TimelineRow[]; working: boolean }) {
  const told = useMemo(() => stepsOf(rows).filter((step) => step.row.kind !== "usage"), [rows]);
  const box = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [told, working]);
  return (
    <StepsBox hint={`${told.length} ${told.length === 1 ? "step" : "steps"} so far`}>
      <div ref={box} role="region" aria-label="The run's steps" tabIndex={0} className={LIST} onScroll={(e) => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK; }}>
        <ol className="divide-y">
          {told.map(({ row }) => <li key={row.id} className={LINE}><StepWords when={clock(row.timestamp)} row={row} wide /></li>)}
          {working && <li className={cn(LINE, "items-center text-small text-muted-foreground")}><Spinner /> Working</li>}
        </ol>
      </div>
    </StepsBox>
  );
}
