// Whether a Docker computer can be had on this server: its daemon asked (boxes.ts askDockerDaemon, `docker version`)
// within a short bound, the answer kept for a while and asked again after it, so a daemon that comes up after the start
// is seen. Settings → Computers' view, a run's start check and the claim's launch read it, and say one thing when no
// daemon answers (noDockerWords): a hosted server (Render and the like) runs none, so a vendor's computer is the way.
import { askDockerDaemon, type DockerDaemon } from "./boxes.js";

export type { DockerDaemon };

/** How long one ask of the daemon may take: a daemon that does not answer within it is taken as none. */
export const DAEMON_ASK_MS = 3_000;
/** How long an answer is kept before the next read asks again. */
export const DAEMON_TTL_MS = 30_000;

const UP: DockerDaemon = { up: true };

/** One ask of the daemon, bounded by its signal: boxes.ts askDockerDaemon, or a test's stand-in. */
export type DaemonAsk = (signal: AbortSignal) => Promise<DockerDaemon>;

/** The daemon's answer as reads take it: asked at the first read, within `timeoutMs` (no answer in time is none), kept
 *  for `ttlMs`, then asked again at the next read. Reads that come while an ask is out share it. Never rejects. */
export function dockerDaemonCheck({ env = process.env, ask, timeoutMs = DAEMON_ASK_MS, ttlMs = DAEMON_TTL_MS, now = Date.now }: {
  readonly env?: NodeJS.ProcessEnv;
  readonly ask?: DaemonAsk;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
} = {}): () => Promise<DockerDaemon> {
  const asking: DaemonAsk = ask ?? ((signal) => askDockerDaemon(env, signal));
  let kept: { readonly at: number; readonly answer: Promise<DockerDaemon> } | undefined;
  const once = async (): Promise<DockerDaemon> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<DockerDaemon>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ up: false, absent: true, reason: `Docker did not answer within ${timeoutMs} ms` });
      }, timeoutMs);
    });
    try {
      return await Promise.race([asking(controller.signal).catch((): DockerDaemon => ({ up: false, absent: true, reason: "Docker's version could not be read" })), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  return () => {
    const at = now();
    if (!kept || at - kept.at >= ttlMs) kept = { at, answer: once() };
    return kept.answer;
  };
}

/** A daemon that answers: what a server whose Docker is a stand-in (--faux, tests) says. */
export const daemonUp = async (): Promise<DockerDaemon> => UP;

/** A provider as the words read it: its name, the kinds it serves, and the mounts it takes. */
type Named = { readonly label: string; readonly kinds: readonly string[]; readonly mounts: readonly string[] };

/** "A", "A or B", "A, B or C". */
const either = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** What a person is told when no Docker daemon answers here and a computer of `kind` is on Docker, in folder `mode` (1:
 *  run folders on this server's disk; 2: on Archil): Settings → Computers' why, a run's start refusal and the claim's
 *  launch refusal, all alike. It names only what works in the mode, of `providers` (this server's), none needing a local
 *  daemon: a sandbox holds the run's folder, so it is one that mounts Archil, and in Mode 1 those need Archil turned on
 *  first; a desktop, phone or browser holds none, so any that takes no folder of this machine (no bind) does. */
export function noDockerWords(kind: string, providers: readonly Named[], mode: 1 | 2): string {
  const NO_DOCKER = "No Docker on this server: Render and most hosted services run none.";
  const vendors = providers.filter((one) => one.kinds.includes(kind) && (kind === "sandbox" ? one.mounts.includes("archil") : !one.mounts.includes("bind"))).map((one) => one.label);
  if (vendors.length === 0) return `${NO_DOCKER} Pick another kind of computer, or none.`;
  if (kind === "sandbox" && mode === 1) return `${NO_DOCKER} A vendor sandbox (${either(vendors)}) needs Archil turned on in Settings → Workspace.`;
  return `${NO_DOCKER} Use a vendor computer, e.g. ${either(vendors)} for a ${kind}.`;
}
