// A warm GPU box for an agent's switch (It Walks Home v2). When the run's creature is known (the tab's sketch landed in
// the run), the trainer's compile-only commands run on the box for it, as the run user with its own HOME, so their XLA
// and Warp entries land in the caches the agent's train command reads there.
//
// Measured on one Modal H100 (image v4b, gVisor), from the agent's walker command to its first checkpoint, for the take's
// body: 19.4 s after a finished warm-up (the walker's compile-only takes 56 to 57 s), 54 to 55 s from the image's seed
// alone, 63 s for a body of another topology (18 joints). A command that starts while the warm-up still runs picks up its
// program when it lands: 20.0 s when the warm-up had a 40 s start, 43.5 s with 20 s, 45.3 s with 15 s. So a switch never
// waits for the warm-up. 16 vCPUs instead of 4 change none of these: the compile is not CPU-bound.
//
// The compiled program depends on the creature and on the program-shaping flags (--num-envs, the first --schedule point,
// the universe's env block, --world), so the commands are the trainer's own lines, verbatim, with only the creature's
// files substituted ({mjcf}, {body}): a warm-up of another program warms nothing.
//
// The box is the caller's (the demo's cloud module creates, tracks and deletes it); this file only runs commands on it.
// One warm-up runs at a time (a compile uses every CPU of the box): a call for the creature already being warmed shares
// that warm-up, a call for another creature runs after it.
import { createHash } from "node:crypto";

/** What this needs of the box: run a shell command as root, and write a file. */
export interface WarmBox {
  exec(command: string, timeoutSec: number): Promise<{ exitCode: number; result: string }>;
  upload(path: string, content: Uint8Array): Promise<void>;
}

export interface WarmTrainOptions {
  /** The trainer's compile-only command lines, in order, with {mjcf} and {body} where the creature's files go. */
  readonly commands: readonly string[];
  /** The user the agent's commands run as on the box, with its login HOME. Default "pda". */
  readonly user?: string;
  /** Where the creature's files are written on the box: `<dir>/<sha12>/{creature.xml,body.json}`. Default /var/tmp/pda-warm. */
  readonly dir?: string;
  /**
   * Variables for the commands. sudo drops the image's environment, and a JAX process that preallocates takes most of the
   * GPU, so an agent's command started during a warm-up would run out of memory: on an image whose train.py does not set
   * it, pass { XLA_PYTHON_CLIENT_PREALLOCATE: "false" }.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Per command. Default 600 s. */
  readonly timeoutSec?: number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

export type Creature = { readonly xml: Uint8Array; readonly body: Uint8Array };
export type WarmReport = {
  /** The first 12 hex digits of the creature.xml's SHA-256. */
  readonly creature: string;
  readonly ms: number;
  readonly commands: readonly { readonly ms: number; readonly exitCode: number; readonly tail: string }[];
};

export interface WarmTrain {
  /** Warm the box for this creature; resolves when every command ended. Rejects when one fails (the rest do not run). */
  warm(creature: Creature): Promise<WarmReport>;
  /** The warm-up running or queued now, if any, for logs; null when idle. A switch need not wait for it (see above). */
  pending(): Promise<WarmReport> | null;
  /** The creatures this box is warm for (every command succeeded). */
  warmed(): readonly string[];
}

export const creatureId = (xml: Uint8Array): string => createHash("sha256").update(xml).digest("hex").slice(0, 12);

/** A single-quoted shell word. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function warmTrain(box: WarmBox, o: WarmTrainOptions): WarmTrain {
  const user = o.user ?? "pda";
  const dir = o.dir ?? "/var/tmp/pda-warm";
  const log = o.log ?? (() => {});
  const env = Object.entries(o.env ?? {}).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`a warm-up variable is NAME=value: ${k}`);
    return `${k}=${q(v)}`;
  });
  const now = o.now ?? Date.now;
  if (o.commands.length === 0) throw new Error("warmTrain needs the trainer's compile-only commands");
  for (const c of o.commands) {
    if (!c.includes("{mjcf}") || !c.includes("{body}")) throw new Error(`a warm-up command names the creature with {mjcf} and {body}: ${c.slice(0, 80)}`);
    if (!/(^|\s)--compile-only(\s|$)/.test(c)) throw new Error(`a warm-up command compiles only (--compile-only): ${c.slice(0, 80)}`);
  }
  const done = new Set<string>();
  const inFlight = new Map<string, Promise<WarmReport>>();
  let line: Promise<unknown> = Promise.resolve();
  let last: Promise<WarmReport> | null = null;

  const run = async (id: string, creature: Creature): Promise<WarmReport> => {
    const t0 = now();
    const at = `${dir}/${id}`;
    await box.upload(`${at}/creature.xml`, creature.xml);
    await box.upload(`${at}/body.json`, creature.body);
    // The upload is root's (owner-only); the run user reads the files.
    const own = await box.exec(`chown -R ${q(user)} ${q(dir)} && chmod -R u+rwX ${q(dir)}`, 30);
    if (own.exitCode !== 0) throw new Error(`warm-up: giving ${at} to ${user} failed: ${own.result.trim().slice(0, 200)}`);
    const commands: { ms: number; exitCode: number; tail: string }[] = [];
    for (const c of o.commands) {
      const cmd = c.replaceAll("{mjcf}", `${at}/creature.xml`).replaceAll("{body}", `${at}/body.json`);
      const t1 = now();
      // As the agent's commands run there: the run user, its login HOME (train.py keeps its caches under ~/.cache).
      // pipefail: the command's exit code, not tail's.
      const r = await box.exec(`set -o pipefail; sudo -n -u ${q(user)} -H ${env.length ? `env ${env.join(" ")} ` : ""}bash -c ${q(cmd)} 2>&1 | tail -c 2000`, o.timeoutSec ?? 600);
      const tail = r.result.trim().slice(-400);
      commands.push({ ms: now() - t1, exitCode: r.exitCode, tail });
      log("warm.command", { creature: id, ms: now() - t1, exitCode: r.exitCode });
      if (r.exitCode !== 0) throw new Error(`warm-up for ${id} failed (${r.exitCode}): ${tail}`);
    }
    done.add(id);
    const report = { creature: id, ms: now() - t0, commands };
    log("warm.done", { creature: id, ms: report.ms });
    return report;
  };

  return {
    warm(creature) {
      const id = creatureId(creature.xml);
      const running = inFlight.get(id);
      if (running) return running;
      // One at a time: after whatever runs now, failed or not.
      const p = line.then(() => run(id, creature), () => run(id, creature));
      line = p.catch(() => undefined);
      inFlight.set(id, p);
      last = p;
      void p.then(
        () => inFlight.delete(id),
        () => inFlight.delete(id),
      );
      return p;
    },
    pending() {
      return inFlight.size > 0 ? last : null;
    },
    warmed() {
      return [...done];
    },
  };
}
