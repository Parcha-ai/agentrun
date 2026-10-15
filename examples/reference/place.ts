// The place seam (settled with the disk lead and pt-modal): where one session lives, and how its process starts, stops and restarts. The supervisor in `demo()` decides when to kill, writes the kill line
// first and is the same for every place; a place decides how: a pid kill for a process, the provider's destroy for a box. Implementations come from the packages
// (pi-durable-disk: a local claim on a plain directory, an Archil claim; pi-transport: a box runner that also moves the session); this file defines the type and the
// one place every machine has, the local one.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunPlace } from './host.ts';

/** How a runner ended. `outcome` is what the child printed: how the run ended, when it got that far. */
export type Exit = { exit: number | string | null; signal: string | null; outcome?: { status: string; generation: number | null; code?: string | null; message?: string }; stderr: string };
/** One process of the session in a place. `epoch` is the place's lease epoch (1 for a place with no lease; a box restore raises it). */
export type Runner = { epoch: number; pid?: number; exited: Promise<Exit> };
/** What a runner is handed: its number in the run, its environment (the run's directory, the kill plan, the mode), and, for a place whose runner opens a claim, the per-attempt
 *  mount token on its standard input: never in argv or env. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };
export type MoveReceipt = Record<string, unknown>;

export type Place = {
  /** For the recording's lines and the README: `local`, `box:docker`, `archil`. */
  name: string;
  /** The session's paths in the place: id, root, work, store. */
  paths: RunPlace;
  /** A place whose runner opens a claim (Archil) needs a mount token for each attempt: the supervisor mints one and hands it on the runner's standard input. */
  token?: boolean;
  /** What this place can lose: `process` always, `box` when it is a machine of its own. */
  kills: ReadonlyArray<'process' | 'box'>;
  start(order: RunnerOrder): Promise<Runner>;
  /** Kills the runner: `process` ends the runner, `box` takes the place's machine away. The supervisor has written the kill line before it calls this. Safe on a runner that is already gone. */
  kill(runner: Runner, kind: 'process' | 'box'): Promise<void>;
  /** How the session stands, read the way the place reads it (a package's status reader), never from the store or `work/`: the supervisor is control-plane only. */
  status?(): Promise<unknown>;
  /** The next runner after a kill: a process kill restarts in the same place with the store intact; a box kill replaces the machine and restores from the last checkpoint, and says what it restored and replayed. */
  recover(last: Runner, kind: 'process' | 'box', order: RunnerOrder): Promise<{ runner: Runner; restored?: { checkpoint: string; head: number }; replayed?: { from: number; to: number } }>;
  /** Takes a checkpoint at rest; reports what held it when it could not. A place that cannot lose its machine has none. */
  checkpoint?(): Promise<{ taken: boolean; heldBy?: string }>;
  /** Moves the session to another place. */
  move?(to: Place): Promise<MoveReceipt>;
  release(): Promise<void>;
};

/** The local place: a child process of this machine on a directory of it, the entry's own `run.ts` started with `--child`. A box kill takes the boxes the run made
 *  with it (`destroyBoxes`), since the machine the box stood for is this machine's. */
export function localPlace(options: { self: string; paths: RunPlace; destroyBoxes?: () => void | Promise<void> }): Place {
  const start = async (order: RunnerOrder): Promise<Runner> => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(options.self), '--child'], { env: { PATH: process.env.PATH!, ...order.env }, stdio: [order.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (order.stdin !== undefined) proc.stdin!.end(order.stdin);
    const exited = new Promise<Exit>((resolve, reject) => {
      let stdout = ''; let stderr = '';
      proc.stdout!.on('data', (chunk) => { stdout += chunk; });
      proc.stderr!.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
        resolve({ exit: signal ?? code, signal, ...(row ? { outcome: row.outcome } : {}), stderr: stderr.trim().slice(0, 600) });
      });
    });
    return { epoch: 1, pid: proc.pid!, exited };
  };
  const kill = async (runner: Runner, kind: 'process' | 'box') => {
    if (runner.pid !== undefined) { try { process.kill(runner.pid, 'SIGKILL'); } catch { /* already gone */ } }
    await runner.exited;
    if (kind === 'box') await options.destroyBoxes?.();
  };
  return {
    name: 'local', paths: options.paths, kills: options.destroyBoxes ? ['process', 'box'] : ['process'],
    start, kill,
    recover: async (last, kind, order) => { await kill(last, kind); return { runner: await start(order) }; },
    release: async () => undefined,
  };
}
