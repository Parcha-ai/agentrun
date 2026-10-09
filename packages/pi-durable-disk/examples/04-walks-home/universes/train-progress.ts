// A universe's progress as D2's train.py records it (../train), read over the disk's S3 API: work/train/<u>/state.json
// (steps done and total, status, segments with the machine that wrote each) and the last line of progress.jsonl (the
// score: metres walked in 10 s by that checkpoint's policy, in C MuJoCo as the tab runs it). state.json is renamed once
// per finished checkpoint, after its progress line, so a state.json read here never names a line that is not there.
import type { RunRef } from "@parcha/pi-durable-disk";
import { runPath } from "@parcha/pi-durable-disk";
import type { Control, Progress } from "./multiverse.ts";
import { trainDir } from "./workload.ts";

/** train.py's units: flat ground, or the held-out course (--course), which it writes as `score_unit` on every line. */
export const TRAIN_SCORE_UNIT = "m walked in 10 s";
export const COURSE_SCORE_UNIT = "m along the course in 20 s";

type TrainState = {
  status?: string;
  generation?: number;
  steps_done?: number;
  steps_total?: number;
  segments?: { generation?: number; host?: string }[];
};

const text = async (control: Pick<Control, "getObject">, key: string): Promise<string | null> => {
  try {
    return new TextDecoder().decode(await control.getObject(key));
  } catch {
    return null;
  }
};

/** The universe's progress, or null before train.py wrote its first state.json. A score is 0 until the first evaluation. */
export async function readTrainProgress(control: Pick<Control, "getObject">, run: RunRef, universe: string): Promise<Progress | null> {
  const base = `${runPath(run.id)}/work/${trainDir(universe)}`;
  const stateText = await text(control, `${base}/state.json`);
  if (!stateText) return null;
  const state = JSON.parse(stateText) as TrainState;
  const total = state.steps_total ?? 0;
  const step = state.steps_done ?? 0;
  let score = 0;
  let unit: string | undefined;
  const lines = (await text(control, `${base}/progress.jsonl`))?.trim().split("\n") ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const line = JSON.parse(lines[i]!) as { score?: number | null; score_unit?: string };
      if (typeof line.score === "number") {
        score = line.score;
        unit = line.score_unit;
        break;
      }
    } catch {
      // a line cut short by a crash is not the last checkpoint's
    }
  }
  const segment = state.segments?.at(-1);
  return {
    step,
    total,
    score,
    progress: total > 0 ? Math.min(1, step / total) : 0,
    done: state.status === "done",
    generation: state.generation ?? segment?.generation ?? 0,
    host: segment?.host ?? "",
    at: new Date().toISOString(),
    ...(unit ? { unit } : {}),
  };
}
