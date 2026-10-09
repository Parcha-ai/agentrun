// What a universe runs on its machine: the stand-in trainer (trainer.ts), or D2's train.py (../train) as a child
// process. Either way a checkpoint is made durable (`checkpointed`: the claim's barrier on a mount, a write-through on a
// pipe) before the orchestrator can read it as progress:
//   - stand-in: it writes, then calls the barrier, then names the checkpoint in work/universe/progress.json.
//   - train.py: it renames work/train/<u>/state.json exactly once per finished checkpoint, after the checkpoint, the
//     newest policy.json and its progress.jsonl line; each rename here runs the barrier, one at a time. The
//     orchestrator reads that state.json and progress.jsonl (train-progress.ts).
// Resume is the same command on the same work directory: train.py restores its newest complete checkpoint.
//   UNIVERSE_WORKLOAD          "stand-in" (default) or "train"
//   UNIVERSE_TRAIN_PY          train.py's path in the box; UNIVERSE_PYTHON (default python3)
//   UNIVERSE_MJCF, UNIVERSE_BODY   the creature, relative to the run's work/ (default creature/creature.xml, creature/body.json)
//   UNIVERSE_SCALES            the universe's reward scales, JSON; UNIVERSE_MINUTES its time budget
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTrainer } from "./trainer.ts";

export interface WorkloadOptions {
  /** The run's work directory, as this machine sees it (the mount, or the runner's copy). */
  readonly work: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The incarnation (direct) or the pipe's epoch: the stand-in writes it into its progress. */
  readonly generation: number;
  /** The machine's label, written into progress so the orchestrator knows who trains. */
  readonly host: string;
  /** Make what the workload wrote durable on the disk. */
  checkpointed(): Promise<void>;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

export interface Workload {
  /** Stop now (the drain); resolves when the workload wrote its last file. */
  stop(): Promise<void>;
  readonly done: Promise<unknown>;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function startWorkload(o: WorkloadOptions): Workload {
  if ((o.env.UNIVERSE_WORKLOAD ?? "stand-in") === "train") return startTrain(o);
  return startTrainer({
    work: o.work,
    total: num(o.env.UNIVERSE_TOTAL_STEPS, 120),
    stepMs: num(o.env.UNIVERSE_STEP_MS, 1_000),
    checkpointEvery: num(o.env.UNIVERSE_CHECKPOINT_EVERY, 5),
    seed: num(o.env.UNIVERSE_SEED, 1),
    generation: o.generation,
    host: o.host,
    barrier: () => o.checkpointed(),
    log: o.log,
  });
}

/** The universe's directory under work/: `train/<universe>`. */
export const trainDir = (universe: string) => join("train", universe);

function startTrain(o: WorkloadOptions): Workload {
  const universe = o.env.UNIVERSE_ID ?? "u1";
  const dir = join(o.work, trainDir(universe));
  const trainPy = o.env.UNIVERSE_TRAIN_PY;
  if (!trainPy) throw new Error("UNIVERSE_TRAIN_PY names train.py in this box");
  let child: ReturnType<typeof spawn> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  // One barrier at a time, and one more after a rename that came in while one ran: none is lost, none overlaps.
  let line: Promise<void> = Promise.resolve();
  let pending = false;
  const onRename = () => {
    if (pending) return;
    pending = true;
    line = line.then(async () => {
      pending = false;
      const t0 = performance.now();
      await o.checkpointed().catch((error: Error) => o.log("checkpoint.barrier-failed", { error: error.message }));
      o.log("checkpoint.durable", { ms: Math.round(performance.now() - t0) });
    });
  };
  const done = (async () => {
    await mkdir(dir, { recursive: true });
    const spec = { name: universe, reward_scales: JSON.parse(o.env.UNIVERSE_SCALES ?? "{}") as unknown, env: {}, ppo: {} };
    await writeFile(join(dir, "universe.json"), `${JSON.stringify(spec, null, 2)}\n`);
    watcher = watch(dir, (event, name) => {
      if (name === "state.json") onRename();
    });
    const args = [
      trainPy,
      "--mjcf", join(o.work, o.env.UNIVERSE_MJCF ?? "creature/creature.xml"),
      "--body", join(o.work, o.env.UNIVERSE_BODY ?? "creature/body.json"),
      "--universe", join(dir, "universe.json"),
      "--work", dir,
      ...(o.env.UNIVERSE_MINUTES ? ["--minutes", o.env.UNIVERSE_MINUTES] : []),
      ...(o.env.UNIVERSE_TRAIN_ARGS ? (JSON.parse(o.env.UNIVERSE_TRAIN_ARGS) as string[]) : []),
    ];
    o.log("train.start", { universe, dir, generation: o.generation });
    child = spawn(o.env.UNIVERSE_PYTHON ?? "python3", args, { env: { ...process.env, TRAIN_HOST_LABEL: o.host }, stdio: ["ignore", "inherit", "inherit"] });
    const code = await new Promise<number | null>((resolve) => child!.once("exit", (c) => resolve(c)));
    watcher.close();
    // train.py's last state.json (paused or done) is durable before the workload says it ended.
    onRename();
    await line;
    o.log("train.end", { code });
    return code;
  })();
  return {
    async stop() {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        const killer = setTimeout(() => child?.kill("SIGKILL"), 20_000);
        await done.catch(() => undefined);
        clearTimeout(killer);
      } else {
        await done.catch(() => undefined);
      }
    },
    done,
  };
}
