// Reads D2's per-skill files from the run's disk, about once a second, and says what is new (skills.ts). A file not written yet (the disk answers 204) and a failed read are both "nothing new".
import { parseHomeSkills } from "../relearn.ts";
import { SKILLS, parseSkillJson, parseSkillProgress, skillEvents } from "../skills.ts";
import type { ShowEvent, Thread } from "../types.ts";

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
  private last = new Map<string, { n: number; json: string; status: Thread["status"] | undefined }>();
  private busy = false;
  /** The robot's body last said. */
  private body = "";
  /** Counts the runs: a tick that started in an earlier one drops what it read. */
  private gen = 0;

  constructor(o: SkillsPollerOptions) {
    this.o = o;
  }

  /** A new run (the feed started over): what was said about the old one is not true of this one, and a tick still reading the old one says nothing more. */
  reset(): void {
    this.last.clear();
    this.body = "";
    this.gen++;
    this.busy = false;
  }

  /** One read of every skill's two files, one at a time (a tick that arrives while one is running is skipped). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const gen = this.gen;
    try {
      // The robot's own body, so the stage can tell a skill trained for another body (a relearn).
      const homeText = await this.o.read("home/skills.json").catch(() => undefined);
      if (gen !== this.gen) return;
      const home = homeText !== undefined ? parseHomeSkills(homeText) : null;
      if (home && home.bodySha !== this.body) {
        this.body = home.bodySha;
        this.o.emit({ t: "body", at: this.o.now(), sha: home.bodySha });
      }
      for (const dir of this.o.skills ?? SKILLS) {
        const [jsonText, progressText] = [await this.o.read(`skills/${dir}/skill.json`).catch(() => undefined), await this.o.read(`skills/${dir}/skill-progress.jsonl`).catch(() => undefined)];
        if (gen !== this.gen) return;
        const seen = this.last.get(dir) ?? { n: 0, json: "", status: undefined };
        const json = jsonText !== undefined ? parseSkillJson(jsonText) : null;
        const points = progressText !== undefined ? parseSkillProgress(progressText).points : [];
        // The status is said when skill.json changed (a read that failed is not a change); checkpoints are said once each; a status only moves forward.
        const changed = jsonText !== undefined && jsonText !== seen.json;
        const events = skillEvents(dir, changed ? json : null, points, this.o.now(), seen.n, seen.status);
        let status = seen.status;
        for (const e of events) {
          if (e.t === "thread" && e.patch.status) status = e.patch.status;
          this.o.emit(e);
        }
        this.last.set(dir, { n: Math.max(seen.n, ...points.map((p) => p.checkpoint)), json: jsonText ?? seen.json, status });
      }
    } finally {
      if (gen === this.gen) this.busy = false;
    }
  }
}
