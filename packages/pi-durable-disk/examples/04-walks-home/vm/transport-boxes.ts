// The robot cluster's GPU boxes, made, run in and ended through pi-transport (`modalBoxes`, the published package) instead of this folder's own sandbox client. The pool (gpu-pool.ts) keeps
// its contract (N boxes and spares, start at attach or now, idle and retry, every log line); what it calls to create a box, run a command on it, read whether it lives and end it comes from here.
// Nothing here holds a Modal key: the host's own Modal client is handed to `modalBoxes` by modal-cloud.ts, and a box is only ever a handle.
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Box, BoxError, BoxSpec } from "@parcha/pi-transport";
import type { GpuProcess } from "../../03-tab-to-cloud/pipe/gpu-rpc.ts";

/** What one cluster box is, for the labels a sweep and a check find it by. */
export const GPU_ROLE = "gpu";

/** The labels on every GPU box: the fleet (this server's), the run, the role, and the pool slot. `modalBoxes` puts them in Modal tags in the create call, so `list` finds a run's boxes. */
export function boxLabels(run: string, fleet: string, index: number): Record<string, string> {
  return { "pda-fleet": fleet, "pda-run": run, "pda-role": GPU_ROLE, "pda-slot": String(index) };
}

export interface ClusterShape {
  readonly image: string;
  /** The GPU type as Modal is asked for it. Default "H100!" (the exact type: plain H100 can be served as an H200). */
  readonly type?: string;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  readonly ttlMinutes?: number;
}

/** Where a box's programs start, and where the trainer's files and the body are put. */
export const BOX_WORKSPACE = "/workspace";
export const DEFAULT_TTL_MINUTES = 20;

/** What one cluster box must be: the exact type on gVisor (the only runtime Modal puts a GPU on), the sizes, a lifetime Modal enforces whatever becomes of this host, and its labels. */
export function clusterSpec(cluster: ClusterShape, labels: Record<string, string>): BoxSpec {
  return {
    image: cluster.image,
    gpu: cluster.type ?? "H100!",
    isolation: "gvisor",
    cpus: cluster.cpu ?? 8,
    memoryMb: cluster.memoryMiB ?? 65536,
    workspace: BOX_WORKSPACE,
    maxLifetimeMs: (cluster.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000,
    labels,
  };
}

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BoxError };

/** The value of a provider's answer; an error becomes a thrown Error that names the provider's code. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const decoder = new TextDecoder();
async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

/** A command run to its end: its exit code and what it printed (the ready command's last line is the box's own report of what it is). */
export async function runToEnd(box: Box, argv: readonly string[], timeoutMs: number, context: Context): Promise<{ exitCode: number; result: string }> {
  const proc = unwrap(await box.exec(argv, { timeoutMs }, context));
  proc.stdin.close().catch(() => undefined);
  const [out, err, code] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.wait()]);
  const exit = unwrap(code);
  return { exitCode: exit, result: `${out}${err}` };
}

/**
 * A command a thread asked for, in the box it holds: its own session, with its group's id in a file on the box, so that when the link that asked for it is gone the group is killed by a second command
 * (the way a box's docs say a caller kills: a program is killed through its own process group). A trainer nobody reads is only a cost.
 */
export async function gpuProcess(box: Box, argv: readonly string[], options: { timeoutMs?: number }, context: Context): Promise<GpuProcess> {
  const pidFile = `/tmp/.pda-rpc/${randomBytes(6).toString("hex")}`;
  const wrapped = ["sh", "-c", 'mkdir -p /tmp/.pda-rpc && exec setsid -w sh -c \'echo $$ > "$0"; "$@"; c=$?; rm -f "$0"; exit $c\' "$0" "$@"', pidFile, ...argv];
  const proc = unwrap(await box.exec(wrapped, options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs }, context));
  return {
    stdin: { writeBytes: (bytes) => proc.stdin.write(bytes), close: () => proc.stdin.close() },
    stdout: proc.stdout,
    stderr: proc.stderr,
    wait: async () => unwrap(await proc.wait()),
    kill: async () => {
      const k = unwrap(await box.exec(["sh", "-c", 'p=$(cat "$0" 2>/dev/null); [ -n "$p" ] || exit 0; kill -TERM -- -$p 2>/dev/null; sleep 2; kill -KILL -- -$p 2>/dev/null; rm -f "$0"', pidFile], { timeoutMs: 30_000 }, context));
      await Promise.allSettled([drain(k.stdout), drain(k.stderr), k.wait()]);
    },
  };
}
