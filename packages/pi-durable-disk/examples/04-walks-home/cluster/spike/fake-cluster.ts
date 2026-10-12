// A fake GPU cluster for the teach_skills spike: a pool of boxes that outlives the host process (its state is files),
// boxes whose exec simulates D2's trainer (no process runs, nothing the model wrote is executed), and an artifact
// mirror shaped like D0's ArtifactSync.
//
// The trainer follows D2's contract: JSON lines skill.start / skill.checkpoint / skill.done on stdout, files written by
// rename under the out dir, exit 0 passed, 3 never passed. A relaunch of a skill that is done returns 0 at once; one
// that is not starts over from the warm start. D0's pi-run guard is simulated too: a relaunch while an earlier run of
// the same skill is marked running stops it first (here it already died with the host, so it is only recorded).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ThreadArtifacts, ThreadBoxes } from "../teach-skills.ts";

type ExecArgs = Parameters<NodeExecutionEnv["exec"]>;
type ExecReturn = ReturnType<NodeExecutionEnv["exec"]>;

/** Checkpoints a skill needs before it passes (D2's measured seconds / ~7 s per checkpoint); wave never passes here. */
export const PASS_AT: Record<string, number | null> = { walk: 3, sprint: 3, backwards: 6, "turn-left": 5, "turn-right": 5, spin: 6, "get-up": 6, wave: null };
export const MAX_CHECKPOINTS = 8;
/** D2's worked skills, as the image ships them: skill name → its directory in /opt/pda/train/skills/ (get-up's has no hyphen). */
export const EXAMPLES: Readonly<Record<string, string>> = { walk: "walk", sprint: "sprint", backwards: "backwards", "turn-left": "turn-left", "turn-right": "turn-right", spin: "spin", wave: "wave", "get-up": "getup" };

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** The pool: one box per thread, idempotent per thread, waiting while `capacity` boxes are out. State is on disk. */
export class FakePool implements ThreadBoxes {
  readonly root: string;
  readonly capacity: number;
  readonly log: (line: object) => void;
  /** Skills whose new box already holds a finished run (as after a host died between the trainer's end and the result). */
  readonly doneBefore: Record<string, { checkpoint: number; seconds: number }>;
  constructor(root: string, capacity = 8, log: (line: object) => void = () => {}, doneBefore: Record<string, { checkpoint: number; seconds: number }> = {}) {
    this.root = root;
    this.capacity = capacity;
    this.log = log;
    this.doneBefore = doneBefore;
    mkdirSync(join(root, "pool"), { recursive: true });
  }
  private held(): string[] {
    return readdirSync(join(this.root, "pool")).filter((f) => f.endsWith(".box"));
  }
  boxDir(boxId: string): string {
    return join(this.root, "boxes", boxId);
  }
  async acquire(thread: { threadId: string; skill: string; gpu: number }, context: Context): Promise<string> {
    const file = join(this.root, "pool", `${thread.threadId.replace(/[^\w-]/g, "_")}.box`);
    for (;;) {
      if (existsSync(file)) {
        const boxId = readFileSync(file, "utf8");
        this.event({ event: "pool.reacquire", threadId: thread.threadId, boxId });
        return boxId;
      }
      if (this.held().length < this.capacity) {
        const boxId = `sb-${thread.skill}-${Date.now().toString(36)}`;
        mkdirSync(join(this.boxDir(boxId), "workspace"), { recursive: true });
        const done = this.doneBefore[thread.skill];
        if (done !== undefined) {
          writeAtomic(join(this.boxDir(boxId), "workspace", "skills", thread.skill, "skill.json"),
            JSON.stringify({ skill: thread.skill, label: thread.skill, status: "done", passed_at: done.checkpoint, wall_s: done.seconds }));
        }
        writeAtomic(file, boxId);
        this.event({ event: "pool.create", threadId: thread.threadId, skill: thread.skill, gpu: thread.gpu, boxId });
        return boxId;
      }
      if (context.abortSignal?.aborted) throw new Error("acquire aborted");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async release(thread: { threadId: string }): Promise<void> {
    const file = join(this.root, "pool", `${thread.threadId.replace(/[^\w-]/g, "_")}.box`);
    if (!existsSync(file)) return;
    const boxId = readFileSync(file, "utf8");
    // Log, then give the box up: a host killed in between releases again on resume (the box file is still there) and
    // logs twice, where the other order would lose the release for good.
    this.event({ event: "pool.release", threadId: thread.threadId, boxId });
    rmSync(file);
  }
  private event(line: object): void {
    const full = { at: Date.now(), pid: process.pid, ...line };
    appendFileSync(join(this.root, "pool", "log.jsonl"), `${JSON.stringify(full)}\n`);
    this.log(full);
  }
}

/** A box: its files are a directory standing in for the box's /workspace; exec runs the simulated trainer. */
export class FakeBoxEnv extends NodeExecutionEnv {
  override readonly id: string;
  readonly boxId: string;
  readonly dir: string;
  readonly tickMs: number;
  constructor(boxId: string, dir: string, tickMs: number) {
    super({ cwd: join(dir, "workspace") });
    this.id = boxId;
    this.boxId = boxId;
    this.dir = dir;
    this.tickMs = tickMs;
  }
  private local(path: string): string {
    return path.startsWith("/workspace") ? join(this.dir, path) : path;
  }
  override readTextFile(path: string, context: Context): ReturnType<NodeExecutionEnv["readTextFile"]> {
    return super.readTextFile(this.local(path), context);
  }
  /** The coding tools resolve every path here first: the box's /workspace is this box's directory. */
  override absolutePath(path: string, context: Context): ReturnType<NodeExecutionEnv["absolutePath"]> {
    return super.absolutePath(this.local(path), context);
  }
  override exec(command: ExecArgs[0], options: ExecArgs[1], context: ExecArgs[2]): ExecReturn {
    appendFileSync(join(this.dir, "exec.log"), `${JSON.stringify(command)}\n`); // what the box was asked to run, for a failing test
    if (typeof command === "string") return this.shell(command, options, context);
    if (!Array.isArray(command) || command[0] !== "pi-run" || command[3] !== "train-skill") {
      return Promise.resolve({ ok: false, error: { code: "unsupported", message: "this fake box runs only pi-run <skill> -- train-skill" } } as never);
    }
    return this.train(command as string[], options, context);
  }
  /**
   * The bash tool's commands, simulated: D2's `pi-run <skill> -- train-skill --skill-dir DIR --body DIR --out DIR
   * [--compile-only | --check POLICY | --steps N]` runs the fake trainer, `cp -r /opt/pda/train/skills/<name> DIR` copies a
   * worked skill, and `cat FILE` prints a file. Nothing else runs (no command from a
   * model ever executes on this machine).
   */
  private async shell(command: string, options: ExecArgs[1], context: Context): ExecReturn {
    const say = (text: string) => options?.onOutput?.(text, context, { stream: "stdout" } as never);
    const t = command.trim().split(/\s+/);
    if (t[0] === "pi-run" && t[2] === "--" && t[3] === "train-skill") {
      const flag = (name: string) => (t.includes(name) ? t[t.indexOf(name) + 1] : undefined);
      const skillDir = flag("--skill-dir");
      const out = flag("--out");
      if (skillDir === undefined || flag("--body") === undefined || out === undefined) {
        say(`${JSON.stringify({ event: "skill.refused", error: "train-skill needs --skill-dir, --body and --out" })}\n`);
        return { ok: true, value: { exitCode: 2 } } as never;
      }
      // The skill dir the thread wrote: skill.json naming this skill, and test.py.
      const config = await this.readTextFile(`${skillDir}/skill.json`, context);
      const test = await this.readTextFile(`${skillDir}/test.py`, context);
      let name: unknown;
      try {
        name = config.ok ? JSON.parse(config.value).name : undefined;
      } catch {
        name = undefined;
      }
      const outJson = join(this.local(out), "skill.json");
      if (name !== t[1] || !test.ok) {
        const why = `${skillDir} needs skill.json with "name": "${t[1]}" and test.py`;
        writeAtomic(outJson, JSON.stringify({ skill: t[1], status: "refused", error: why, passed_at: null }));
        say(`${JSON.stringify({ event: "skill.refused", error: why })}\n`);
        return { ok: true, value: { exitCode: 2 } } as never;
      }
      if (t.includes("--compile-only")) {
        writeAtomic(outJson, JSON.stringify({ skill: t[1], status: "compiled", passed_at: null }));
        say("compiled: the skill dir and the body are fine\n");
        return { ok: true, value: { exitCode: 0 } } as never;
      }
      if (t.includes("--check")) {
        // test.py once on the policy: it passes when the trainer's run passed.
        const saved = await this.readTextFile(`${out}/skill.json`, context);
        const passes = saved.ok && JSON.parse(saved.value).status === "done";
        say(`${JSON.stringify({ event: "skill.check", passes, metric: null })}\n`);
        return { ok: true, value: { exitCode: passes ? 0 : 3 } } as never;
      }
      // --steps caps the try: 12M reaches 5 checkpoints here, 40M all of them.
      const steps = /^(\d+)M$/.exec(flag("--steps") ?? "");
      const cap = steps ? Math.min(MAX_CHECKPOINTS, Math.ceil(Number(steps[1]) / 2.5)) : MAX_CHECKPOINTS;
      return this.train(["pi-run", t[1]!, "--", "train-skill", t[1]!, "--out", out], options, context, cap);
    }
    // The library's worked skills (/opt/pda/train/skills/<name>/ in D2's image): `cp -r` one into the workspace.
    const example = t[0] === "cp" && t[1] === "-r" && t.length === 4 ? /^\/opt\/pda\/train\/skills\/([\w-]+)\/?$/.exec(t[2]!)?.[1] : undefined;
    if (example !== undefined) {
      const name = Object.entries(EXAMPLES).find(([, dir]) => dir === example)?.[0];
      if (name === undefined) {
        say(`cp: cannot stat '${t[2]}': No such file or directory\n`);
        return { ok: true, value: { exitCode: 1 } } as never;
      }
      const dest = this.local(t[3]!.startsWith("/") ? t[3]! : `/workspace/${t[3]}`);
      writeAtomic(join(dest, "skill.json"), JSON.stringify({ name, label: name, command: 0, reward_scales: {}, env: {} }));
      writeAtomic(join(dest, "test.py"), `def test(sim):\n    r = sim.rollout(seconds=10)\n    return r.fell_at is None, {"name": "${name}", "value": 0, "unit": "", "target": ">= 1.0"}\n`);
      return { ok: true, value: { exitCode: 0 } } as never;
    }
    if (t[0] === "cat" && t.length === 2) {
      const r = await this.readTextFile(t[1]!, context);
      if (!r.ok) return { ok: true, value: { exitCode: 1 } } as never;
      say(r.value);
      return { ok: true, value: { exitCode: 0 } } as never;
    }
    say(`fake box: only "pi-run <skill> -- train-skill ...", "cp -r /opt/pda/train/skills/<name> <dir>" and "cat <file>" are simulated\n`);
    return { ok: true, value: { exitCode: 127 } } as never;
  }
  private async train(argv: string[], options: ExecArgs[1], context: Context, cap = MAX_CHECKPOINTS): ExecReturn {
    const skill = argv[4]!;
    const out = this.local(argv[argv.indexOf("--out") + 1]!);
    const say = (line: object) => options?.onOutput?.(`${JSON.stringify(line)}\n`, context, { stream: "stdout" } as never);
    const runs = join(this.dir, "runs.jsonl");
    // pi-run: one trainer per skill per box.
    const marker = join(this.dir, `pi-run-${skill}.pid`);
    if (existsSync(marker)) appendFileSync(runs, `${JSON.stringify({ at: Date.now(), event: "pi-run.stopped-previous", previousPid: Number(readFileSync(marker, "utf8")), pid: process.pid })}\n`);
    writeFileSync(marker, String(process.pid));
    const skillJson = join(out, "skill.json");
    const done = existsSync(skillJson) && JSON.parse(readFileSync(skillJson, "utf8")).status === "done";
    appendFileSync(runs, `${JSON.stringify({ at: Date.now(), event: done ? "train.already-done" : "train.start", skill, pid: process.pid })}\n`);
    if (done) {
      say({ event: "skill.done", skill, passed: true, already: true });
      rmSync(marker, { force: true });
      return { ok: true, value: { exitCode: 0 } };
    }
    // Start over from the warm start: no half-written run is mixed in.
    rmSync(join(out, "checkpoints"), { recursive: true, force: true });
    rmSync(join(out, "skill-progress.jsonl"), { force: true });
    writeAtomic(skillJson, JSON.stringify({ skill, label: skill, status: "training" }));
    say({ event: "skill.start", skill });
    const passAt = PASS_AT[skill] ?? null;
    const started = Date.now();
    for (let n = 1; n <= cap; n++) {
      // Aborting the call stops this run, and exec reports it as an error result, as a real environment does.
      const stopped = await new Promise<boolean>((resolve) => {
        if (context.abortSignal?.aborted) return resolve(true);
        const timer = setTimeout(() => resolve(false), this.tickMs);
        context.abortSignal?.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      if (stopped) {
        rmSync(marker, { force: true });
        return { ok: false, error: { code: "aborted", message: "the run was aborted" } } as never;
      }
      const passes = passAt !== null && n >= passAt;
      const t = (Date.now() - started) / 1000;
      writeAtomic(join(out, "checkpoints", `ckpt-${n}.json`), JSON.stringify({ checkpoint: n, steps: n * 4096 }));
      writeAtomic(join(out, "policy.json"), JSON.stringify({ skill, checkpoint: n }));
      appendFileSync(join(out, "skill-progress.jsonl"), `${JSON.stringify({ checkpoint: n, passes, t })}\n`);
      say({ event: "skill.checkpoint", checkpoint: n, steps: n * 4096, t, passes });
      if (passes) {
        writeAtomic(skillJson, JSON.stringify({ skill, label: skill, status: "done", passed_at: { checkpoint: n, steps: n * 4096, t, passes: true, metric: null }, policy_checkpoint: n, wall_s: t }));
        say({ event: "skill.done", skill, passed: true, checkpoint: n });
        rmSync(marker, { force: true });
        return { ok: true, value: { exitCode: 0 } };
      }
    }
    // D2's diagnosis: a try cut short by its --steps is still changing; one that used every checkpoint plateaued.
    const diagnosis = cap < MAX_CHECKPOINTS ? "still changing at the last checkpoint: train longer" : `plateaued from checkpoint ${MAX_CHECKPOINTS - 2}: strengthen the term or check the test's target`;
    writeAtomic(skillJson, JSON.stringify({ skill, label: skill, status: "failed", passed_at: null, diagnosis }));
    say({ event: "skill.done", skill, passed: false });
    rmSync(marker, { force: true });
    return { ok: true, value: { exitCode: 3 } };
  }
}

/** D0's ArtifactSync, simplified: mirror a box folder (the trainer's output) to the host's work/skills/<skill>/, skipping same size + mtime. */
export class FakeArtifacts implements ThreadArtifacts {
  /** Mirrors started and not yet stopped, in this process. */
  static active = 0;
  private timer: NodeJS.Timeout | undefined;
  copied = 0;
  readonly remote: string;
  readonly local: string;
  readonly intervalMs: number;
  constructor(remote: string, local: string, intervalMs = 250) {
    this.remote = remote;
    this.local = local;
    this.intervalMs = intervalMs;
  }
  start(): void {
    if (this.timer !== undefined) return;
    FakeArtifacts.active++;
    this.timer = setInterval(() => this.copy(), this.intervalMs);
  }
  async flush(): Promise<void> {
    this.copy();
  }
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    FakeArtifacts.active--;
  }
  private copy(dir = ""): void {
    const from = join(this.remote, dir);
    if (!existsSync(from)) return;
    for (const name of readdirSync(from)) {
      if (name.endsWith(".tmp")) continue;
      const source = join(from, name);
      const target = join(this.local, dir, name);
      const s = statSync(source);
      if (s.isDirectory()) {
        this.copy(join(dir, name));
        continue;
      }
      if (existsSync(target)) {
        const t = statSync(target);
        if (t.size === s.size && t.mtimeMs === s.mtimeMs) continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      utimesSync(target, s.atime, s.mtime);
      this.copied++;
    }
  }
}
