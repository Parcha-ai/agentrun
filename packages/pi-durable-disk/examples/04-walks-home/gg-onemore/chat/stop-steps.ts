// The page's stop, in order: first what the take leaves behind (the guard log, the strength record, the served edit and the
// recipes made on the box, the page's events, the run's transcript) is copied into a directory of its own, then the box (unless
// it is kept for the next page), the app's sandboxes and the run's tree go. A step that fails is logged and the rest still
// run: a lost log must never keep a GPU box up.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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

/** The box's logs, read in one root command that prints them as one JSON line (a missing file is null), with each recipe the
 * lab's serve saved on the box (recipe-<name>.json). */
export const BOX_FILES = ["/var/tmp/gg/guard.jsonl", "/var/tmp/gg/run/strength.json", "/var/tmp/gg/run/served.json", "/var/tmp/gg/run/pick.json"];
export const BOX_RECIPES = "/var/tmp/gg/recipes";
const READ_BOX_FILES = `python3 -c 'import json, os; R = "${BOX_RECIPES}"; out = {os.path.basename(p): open(p).read() if os.path.exists(p) else None for p in ${JSON.stringify(BOX_FILES)}}; out.update({"recipe-" + f: open(os.path.join(R, f)).read() for f in (sorted(os.listdir(R)) if os.path.isdir(R) else []) if f.endswith(".json")}); print(json.dumps(out))'`;

/** With `keepBox` the GPU box stays up for the next page on it (live-gg.mjs --reuse-box): `terminateSandboxes` must spare it. */
export function stopSteps(t: StopTools, dir: string, o: { keepBox?: boolean } = {}): StopStep[] {
  return [
    ["keep: the directory", () => (mkdirSync(dir, { recursive: true, mode: 0o700 }), dir)],
    [
      "keep the box's logs",
      () => {
        const files = JSON.parse(t.onBox(READ_BOX_FILES).trim().split("\n").at(-1) ?? "{}") as Record<string, string | null>;
        for (const [name, text] of Object.entries(files)) if (text !== null) writeFileSync(join(dir, basename(name)), text, { mode: 0o600 });
        return Object.entries(files).map(([name, text]) => `${name} ${text === null ? "missing" : `${text.length} chars`}`).join(", ");
      },
    ],
    ["keep the page's events", () => t.pageEvents(dir)],
    ["keep the run's transcript", () => t.pullRun(join(dir, "run"))],
    o.keepBox ? ["box kept", () => "the GPU box stays up for the next page"] : ["box down", () => t.boxDown()],
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
