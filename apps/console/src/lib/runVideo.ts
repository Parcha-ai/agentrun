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

/** The run's steps (lib/timeline's `steps`, as the Timeline tab tells them) that began while `recording` was being
 *  made, each at its time on the video: its row's time less the recording's start. None when the timeline doesn't say
 *  when the recording began. A step's time is the timeline's, so the video shows it within about a second of there. The
 *  run's cost row is not a step of the screen and is left out. */
export function videoSteps(rows: readonly TimelineRow[], recording: Pick<RunRecording, "path" | "seconds">): VideoStep[] {
  const start = recordingStart(rows, recording.path);
  if (start === undefined) return [];
  const end = start + recording.seconds * 1000;
  return steps(rows).flatMap((step) => {
    if (step.row.kind === "usage") return [];
    const at = Date.parse(step.row.timestamp);
    return Number.isNaN(at) || at < start || at > end ? [] : [{ step, at: (at - start) / 1000 }];
  });
}

/** The step the video is at: the last that began at or before `seconds`, by its place in `told`; -1 before the first. */
export function stepAt(told: readonly VideoStep[], seconds: number): number {
  let at = -1;
  for (let i = 0; i < told.length; i += 1) if (told[i]!.at <= seconds) at = i;
  return at;
}

/** A time on the video as a player says it: "0:07", "12:40", "1:02:05". */
export function videoClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
