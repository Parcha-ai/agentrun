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

/** What a person is told when no Docker daemon answers here and a computer of `kind` is on Docker: Settings →
 *  Computers' why, a run's start refusal and the claim's launch refusal, all alike. The vendors named are those of
 *  `providers` that serve the kind and take no folder of this machine (no bind: none of them needs a local daemon). */
export function noDockerWords(kind: string, providers: readonly Named[]): string {
  const vendors = providers.filter((one) => one.kinds.includes(kind) && !one.mounts.includes("bind")).map((one) => one.label);
  const next = vendors.length > 0 ? `Use a vendor computer, e.g. ${either(vendors)} for a ${kind}.` : `Pick another kind of computer, or none.`;
  return `No Docker on this server: Render and most hosted services run none. ${next}`;
}
