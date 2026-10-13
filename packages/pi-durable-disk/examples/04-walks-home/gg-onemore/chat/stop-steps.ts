// The page's stop, in order: first what the take leaves behind (the guard log, the strength record, the page's events, the
// run's transcript) is copied into a directory of its own, then the box, the app's sandboxes and the run's tree go. A step
// that fails is logged and the rest still run: a lost log must never keep a GPU box up.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StopTools {
  /** a root command's stdout on the GPU box */
  onBox(cmd: string): string;
  /** the page server's events, copied into `dir` */
  pageEvents(dir: string): string;
  /** the run's tree on the disk (work/ and store/), copied into `dir` */
  pullRun(dir: string): string;
  boxDown(): string;
  terminateSandboxes(): string;
  cleanRun(): string;
}

export type StopStep = readonly [string, () => string];

export function stopSteps(t: StopTools, dir: string): StopStep[] {
  const keep = (name: string, path: string): StopStep => [`keep ${name}`, () => (writeFileSync(join(dir, name), t.onBox(`cat ${path}`), { mode: 0o600 }), join(dir, name))];
  return [
    keep("guard.jsonl", "/var/tmp/gg/guard.jsonl"),
    keep("strength.json", "/var/tmp/gg/run/strength.json"),
    keep("served.json", "/var/tmp/gg/run/served.json"),
    keep("pick.json", "/var/tmp/gg/run/pick.json"),
    ["keep the page's events", () => t.pageEvents(dir)],
    ["keep the run's transcript", () => t.pullRun(join(dir, "run"))],
    ["box down", () => t.boxDown()],
    ["the app's sandboxes", () => t.terminateSandboxes()],
    ["the run's tree", () => t.cleanRun()],
  ];
}

export function runStopSteps(steps: StopStep[], say: (event: string, data: Record<string, unknown>) => void): void {
  for (const [step, fn] of steps) {
    try {
      say("stop", { step, out: String(fn()).trim().split("\n").at(-1) });
    } catch (e) {
      const err = e as Error & { output?: string };
      say("stop.failed", { step, error: String(err.message).slice(0, 600), ...(err.output ? { output: err.output } : {}) });
    }
  }
}
