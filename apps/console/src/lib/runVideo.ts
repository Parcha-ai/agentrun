import { type Step, steps } from "./timeline";
import type { Run, TimelineRow } from "./v2";

/** One of a run's screen recordings, as its read lists it. */
type RunRecording = NonNullable<Run["recordings"]>[number];

/** A step of the run on a recording's clock: `at` seconds from the video's start. */
export type VideoStep = { step: Step; at: number };

/** When the recording at `path` began, in ms: the time of the timeline row that says so. The server writes that row as
 *  the file's encoder starts, a first file's ("Recording the desktop's screen into recordings/desktop.mp4.") and a later
 *  one's ("…: the recording goes on in recordings/desktop-2.mp4."); each ends with the file's own path. Undefined with no
 *  such row: a timeline not read that far, or a run whose server said it otherwise. */
export function recordingStart(rows: readonly TimelineRow[], path: string): number | undefined {
  for (const row of rows) {
    if (row.kind !== "phase") continue;
    const words = row.summary ?? row.text ?? "";
    if (!words.endsWith(` into ${path}.`) && !words.endsWith(` goes on in ${path}.`)) continue;
    const at = Date.parse(row.timestamp);
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

/** When a step happened, in ms. A tool's call row is dated when the model's turn began, which can be long before the
 *  tool ran (the model thinking, or the call held while a person had the computer), so a tool step is placed when it
 *  ran: at its first computer call's start where the server kept its calls (`computer_calls`), else when its result
 *  came (its call's time and how long to its result). Any other step, and a call with no result yet, at its row's time. */
function happenedAt(step: Step): number {
  const called = step.row.computer_calls?.[0]?.started_at;
  const at = called ? Date.parse(called) : Number.NaN;
  return Number.isNaN(at) ? Date.parse(step.row.timestamp) + (step.ms ?? 0) : at;
}

/** The run's steps (lib/timeline's `steps`, as the Timeline tab tells them) that happened while `recording` was being
 *  made, each at its time on the video (when it happened, less the recording's start), in the video's order: a call
 *  that waited for a person's hand-back comes after the take-over it waited on. None when the timeline doesn't say when
 *  the recording began. The times are the timeline's, so the video shows a step within about a second of there. The
 *  run's cost row is not a step of the screen and is left out. */
export function videoSteps(rows: readonly TimelineRow[], recording: Pick<RunRecording, "path" | "seconds">): VideoStep[] {
  const start = recordingStart(rows, recording.path);
  if (start === undefined) return [];
  const end = start + recording.seconds * 1000;
  return steps(rows)
    .flatMap((step) => {
      if (step.row.kind === "usage") return [];
      const at = happenedAt(step);
      return Number.isNaN(at) || at < start || at > end ? [] : [{ step, at: (at - start) / 1000 }];
    })
    // By time, the timeline's order kept between steps of one instant (the sort is stable).
    .sort((a, b) => a.at - b.at);
}

/** The tool call a step is, by the call's id: a call's row, or its result's once the result folded into it (lib/timeline's
 *  `steps`). Null for a step that is no call (a phase, a message). The run's trace knows the call by the same id. */
export const stepCall = (step: Step): string | null => ((step.row.kind === "tool_use" || step.row.kind === "tool_result") && step.row.tool_use_id ? step.row.tool_use_id : null);

/** The step the video is at: the last that happened at or before `seconds`, by its place in `told` (in the video's
 *  order, as videoSteps gives it); -1 before the first. */
export function stepAt(told: readonly VideoStep[], seconds: number): number {
  let at = -1;
  for (let i = 0; i < told.length; i += 1) if (told[i]!.at <= seconds) at = i;
  return at;
}

/** What a player's clock may read short of the time it was sent to. Chrome keeps a video's time in whole microseconds
 *  and cuts the rest, so a video sent to 4.023 s says 4.022999: read as it is, the step it was sent to has not happened
 *  yet and the one before is marked, and opened. Half a millisecond covers the cut, and is under the millisecond the
 *  timeline keeps its times to, so no step is reached before one that is a different time. */
export const CLOCK_SLACK = 0.0005;

/** The step a player is at by its own clock (`video.currentTime`): stepAt, with the clock's cut allowed for. */
export const stepAtClock = (told: readonly VideoStep[], clock: number): number => stepAt(told, clock + CLOCK_SLACK);

/** A time on the video as a player says it: "0:07", "12:40", "1:02:05". */
export function videoClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
