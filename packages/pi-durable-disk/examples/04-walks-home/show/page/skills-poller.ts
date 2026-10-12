// Reads D2's per-skill files from the run's disk, about once a second, and says what is new (skills.ts). A file not written yet (the disk answers 204) and a failed read are both "nothing new".
import { SKILLS, parseSkillJson, parseSkillProgress, skillEvents } from "../skills.ts";
import type { ShowEvent } from "../types.ts";

export type SkillsPollerOptions = {
  /** The text of a file of the run's disk (a path under work/), or undefined when it is not there (yet) or cannot be read. */
  read: (path: string) => Promise<string | undefined>;
  emit: (event: ShowEvent) => void;
  /** The stage's clock for the events it makes. */
  now: () => number;
  skills?: readonly string[];
};

export class SkillsPoller {
  private readonly o: SkillsPollerOptions;
  private last = new Map<string, { n: number; json: string }>();
  private busy = false;

  constructor(o: SkillsPollerOptions) {
    this.o = o;
  }

  /** A new run (the feed started over): what was said about the old one is not true of this one. */
  reset(): void {
    this.last.clear();
  }

  /** One read of every skill's two files, one at a time (a tick that arrives while one is running is skipped). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const dir of this.o.skills ?? SKILLS) {
        const [jsonText, progressText] = [await this.o.read(`skills/${dir}/skill.json`).catch(() => undefined), await this.o.read(`skills/${dir}/skill-progress.jsonl`).catch(() => undefined)];
        const seen = this.last.get(dir) ?? { n: 0, json: "" };
        const json = jsonText !== undefined ? parseSkillJson(jsonText) : null;
        const points = progressText !== undefined ? parseSkillProgress(progressText).points : [];
        const jsonKey = jsonText ?? "";
        // The status is said when skill.json changed; checkpoints are said once each.
        const events = skillEvents(dir, jsonKey !== seen.json ? json : null, points, this.o.now(), seen.n);
        for (const e of events) this.o.emit(e);
        this.last.set(dir, { n: Math.max(seen.n, ...points.map((p) => p.checkpoint)), json: jsonKey });
      }
    } finally {
      this.busy = false;
    }
  }
}
