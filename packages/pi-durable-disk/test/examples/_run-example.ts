// Runs an example the way a reader does: `node <entry>` from a fresh scratch directory, so the run directory it makes lands
// there. The example leads a process group of its own (detached), so whatever ends the run (its exit, the timeout, a
// failed assertion after it) the instances it started go with it before the directory is removed.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoot } from "../_run-support.ts";

export const EXAMPLES = fileURLToPath(new URL("../../examples/", import.meta.url));

export interface ExampleRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The timeout ended the run (its whole process group was killed). */
  readonly timedOut: boolean;
}

/** Signals the process group `leader` leads. Only a real pid: `kill(-0)` would be this process's own group. */
function signalGroup(leader: number, signal: NodeJS.Signals | 0): boolean {
  if (!(leader > 0)) return false;
  try {
    process.kill(-leader, signal);
    return true;
  } catch {
    return false; // ESRCH: nothing left in the group
  }
}

/** SIGKILL what is left of the group `leader` led and wait until it is empty. */
export async function reapGroup(leader: number): Promise<void> {
  signalGroup(leader, "SIGKILL");
  for (let i = 0; i < 500 && signalGroup(leader, 0); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * `node examples/<name>/main.ts [args]` (or `entry`, relative to examples/) from a scratch directory that is removed
 * afterwards. Resolves once the example and every process of its group are gone.
 */
export async function runExample(
  name: string,
  options: { readonly entry?: string; readonly args?: readonly string[]; readonly timeoutMs?: number } = {},
): Promise<ExampleRun> {
  const dir = scratchRoot(`example-${name}`);
  let leader = 0;
  try {
    const child = spawn(process.execPath, [join(EXAMPLES, options.entry ?? join(name, "main.ts")), ...(options.args ?? [])], {
      cwd: dir.root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    leader = child.pid ?? 0;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(leader, "SIGKILL");
    }, options.timeoutMs ?? 110_000);
    // `close`, not `exit`: the output is read to the end, and an instance still holding the pipes keeps it open until the
    // timeout kills the group.
    const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("error", (error) => {
        stderr += String(error);
        resolve([null, null]);
      });
      child.once("close", (code, sig) => resolve([code, sig]));
    });
    clearTimeout(timer);
    return { status, signal, stdout, stderr, timedOut };
  } finally {
    await reapGroup(leader);
    dir.remove();
  }
}
