// The trainer's output as the chat reads it. pi-run's trainer (04-walks-home/train/train_skill.py) prints one JSON object per line, each with an `event`, and writes the same checkpoint records to
// skill-progress.jsonl. The known events become one quiet line each, from their typed fields (never by matching prose); a line that is not a known event stays exactly as it was, and the raw output is one
// click away in the page. Pure: a known event with fields of the wrong type says nothing rather than something wrong.

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 12288000 steps as "12M", 491520 as "492k". */
function steps(n: number): string {
  if (n >= 1e6) return `${n >= 1e7 ? Math.round(n / 1e6) : Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
const round = (v: number): string => String(Math.round(v * 100) / 100);
const seconds = (s: number): string => `${Math.round(s * 10) / 10} s`;
/** The skill's own words for what passing needs (">= 0.6") as symbols. */
const target = (t: string): string => t.replace(">=", "≥").replace("<=", "≤");

/** One trainer event as a line, or null when it is not one this knows (or its fields are not what it expects). */
export function trainerLine(event: unknown): string | null {
  const e = bag(event);
  const kind = e ? str(e.event) : null;
  if (e === null || kind === null) return null;
  switch (kind) {
    case "skill.start": {
      const name = str(e.label) ?? str(e.skill);
      const joints = num(e.joints);
      return name === null ? null : `start · ${name}${joints !== null ? ` · ${joints} joints` : ""}`;
    }
    case "skill.waiting-for-compile":
      return "compiling the body…";
    case "skill.compile-ready": {
      const waited = num(e.waited_s);
      if (waited === null || typeof e.finished !== "boolean") return null;
      return e.finished ? `compiled · ready in ${seconds(waited)}` : `compile not finished after ${seconds(waited)}`;
    }
    case "train.start": {
      const remaining = num(e.remaining);
      const device = str(e.device);
      if (remaining === null || device === null) return null;
      const restore = str(e.restore);
      return `training ${steps(remaining)} steps on ${device}${restore ? ` · resuming from ${restore}` : ""}`;
    }
    case "skill.checkpoint": {
      const n = num(e.checkpoint);
      if (n === null) return null;
      const t = num(e.t);
      const when = t !== null ? ` · ${seconds(t)}` : "";
      if (e.fell_at !== null && e.fell_at !== undefined) return `checkpoint ${n} · fell in its test${when}`;
      const m = bag(e.metric);
      const name = m ? str(m.name) : null;
      const value = m ? num(m.value) : null;
      const unit = m ? str(m.unit) : null;
      const goal = m ? str(m.target) : null;
      const what = name !== null && value !== null ? ` · ${name} ${round(value)}${unit ? ` ${unit}` : ""}${goal ? ` (target ${target(goal)})` : ""}` : "";
      const verdict = typeof e.passes === "boolean" ? (e.passes ? " · ✓ passes" : " · not yet") : "";
      return `checkpoint ${n}${what}${verdict}${when}`;
    }
    case "skill.check": {
      // `train-skill --check <policy>`: the skill's own test, run once on a finished policy.
      if (typeof e.passes !== "boolean") return null;
      const m = bag(e.metric);
      const name = m ? str(m.name) : null;
      const value = m ? num(m.value) : null;
      const unit = m ? str(m.unit) : null;
      const goal = m ? str(m.target) : null;
      const what = name !== null && value !== null ? ` · ${name} ${round(value)}${unit ? ` ${unit}` : ""}${goal ? ` (target ${target(goal)})` : ""}` : "";
      const why = str(e.error)?.split("\n")[0] ?? null;
      if (what === "" && why === null) return null;
      const verdict = e.passes ? "✓ passes" : what === "" ? "did not pass" : "not yet";
      return `check${what} · ${verdict}${!e.passes && why !== null ? ` · ${why}` : ""}`;
    }
    case "skill.test-error": {
      const n = num(e.checkpoint);
      const why = str(e.error);
      return n === null || why === null ? null : `checkpoint ${n} · its test raised: ${why.split("\n")[0]}`;
    }
    case "train.diverged": {
      const at = num(e.steps);
      const why = str(e.error);
      return at === null ? null : `diverged at ${at} steps${why ? `: ${why}` : ""}`;
    }
    case "skill.done": {
      const status = str(e.status);
      if (status === null) return null;
      const passed = bag(e.passed_at);
      const at = passed ? num(passed.checkpoint) : null;
      const wall = num(e.wall_s);
      const diagnosis = str(e.diagnosis);
      return `${status} · ${at !== null ? `passed at checkpoint ${at}` : "never passed"}${wall !== null ? ` · ${seconds(wall)}` : ""}${diagnosis ? ` · ${diagnosis}` : ""}`;
    }
    case "skill.refused":
    case "body.refused": {
      const why = str(e.why);
      return why === null ? null : `refused: ${why}`;
    }
    default:
      return null;
  }
}

export type OutputLine = { kind: "event" | "pass" | "plain"; text: string };

/** A command's output, line by line: the trainer's known events as quiet lines, every other line as it was; `recognized` is how many lines were events (0: nothing here is a trainer's). */
export function humanizeOutput(output: string): { lines: OutputLine[]; recognized: number } {
  const lines: OutputLine[] = [];
  let recognized = 0;
  for (const raw of output.replace(/\n$/, "").split("\n")) {
    let said: string | null = null;
    let passed = false;
    if (raw.startsWith("{")) {
      try {
        const e = JSON.parse(raw) as unknown;
        said = trainerLine(e);
        passed = bag(e)?.passes === true && (bag(e)?.event === "skill.checkpoint" || bag(e)?.event === "skill.check");
      } catch {
        said = null;
      }
    }
    if (said === null) lines.push({ kind: "plain", text: raw });
    else {
      recognized++;
      lines.push({ kind: passed ? "pass" : "event", text: said });
    }
  }
  return { lines, recognized };
}
