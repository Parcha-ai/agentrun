// A local install's note in its data directory, so a runner in its own process on the same machine can take the
// operator's loopback opt-in (AGENTRUN_MCP_ALLOW_LOOPBACK=1) as the runner beside the server takes it (runner/beside.ts).
//
// The opt-in says loopback is this machine and the operator alone uses it. A runner reaches an MCP server on loopback
// only when its loopback is the server's: the same network namespace on the same booted kernel. The runner beside the
// server shares its process, so it is told directly. A standalone runner is told nothing by its server, so the server
// leaves this note where its runners already meet it (the data directory they share): its own addresses (Serve.own,
// whose ports a runner's loopback read never goes to) and where its loopback is (loopbackMark). A runner then reaches
// loopback only when its own operator set the same opt-in, it does not say it is on another host
// (AGENTRUN_RUNNER_LIVE_HOST), and the note's mark is its own. A runner on another machine, or in another container on a
// shared volume, reads another mark and stays refused: its loopback is another machine's. The note is never the store's,
// so a runner sharing only a Postgres store never sees one.
import { readFileSync, readlinkSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isLiveHost, LOOPBACK } from "./live-reach.js";

/** The operator's opt-in: a server started with it is a local install (cli.ts), and a standalone runner started with it
 *  shares that server's loopback when the note says so (standaloneLoopback). */
export const MCP_ALLOW_LOOPBACK_ENV = "AGENTRUN_MCP_ALLOW_LOOPBACK";

/** The note's file in the data directory. */
export const LOCAL_INSTALL_NOTE = "mcp-local-install.json";

/** What the note holds: where the server's loopback is (loopbackMark), and its own addresses (Serve.own). */
export type LocalInstallNote = { readonly mark: string; readonly own: readonly string[] };

/** Where this process's loopback is. On Linux, the booted kernel (its boot id, the same in every container on a host and
 *  new at each boot) and this process's network namespace (the loopback interface is the namespace's): two processes
 *  share a loopback exactly when both match. Undefined on Linux when either can't be read (a sandbox that hides /proc):
 *  the host's name is no stand-in there, as two containers may share one, so nothing is shared. Elsewhere (macOS has no
 *  network namespaces), the host's name. `read`: a test's stand-in for the files; `platform`: a test's for the OS. */
export function loopbackMark(read: (path: string) => string = (path) => (path.startsWith("/proc/self/ns/") ? readlinkSync(path) : readFileSync(path, "utf8")), platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "linux") return `host ${hostname()}`;
  try {
    const boot = read("/proc/sys/kernel/random/boot_id").trim();
    const net = read("/proc/self/ns/net").trim();
    return boot && net ? `linux boot ${boot} ${net}` : undefined;
  } catch {
    return undefined;
  }
}

/** The server's start (server.ts): a local install leaves its note, any other server takes one an earlier start left
 *  away, so a runner never keeps an opt-in the server no longer has. A local install whose loopback can't be told
 *  (loopbackMark undefined) leaves none: no runner can show it shares it. Written whole (a file beside, then renamed
 *  over), 0600. */
export async function noteLocalInstall(data: string, local: boolean, own: readonly string[], markOf: () => string | undefined = loopbackMark): Promise<void> {
  const file = join(data, LOCAL_INSTALL_NOTE);
  const mark = local ? markOf() : undefined;
  if (!local || mark === undefined) return void (await rm(file, { force: true }));
  const next = `${file}.${process.pid}.next`;
  await writeFile(next, `${JSON.stringify({ mark, own } satisfies LocalInstallNote)}\n`, { mode: 0o600 });
  await rename(next, file);
}

/** The note in `data`, or undefined with none or one that is not a note. */
export function readLocalInstallNote(data: string): LocalInstallNote | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(data, LOCAL_INSTALL_NOTE), "utf8"));
  } catch {
    return undefined;
  }
  const { mark, own } = (parsed ?? {}) as { mark?: unknown; own?: unknown };
  if (typeof mark !== "string" || !Array.isArray(own) || !own.every((one) => typeof one === "string")) return undefined;
  return { mark, own };
}

/** What a standalone runner (runner/main.ts runnerLoop) may reach on loopback, read at each claim: undefined when it may
 *  not, else the own addresses of the local-install server it shares a loopback with (AdapterSpecDeps.mcpLocal).
 *  Undefined as a whole (no read at any claim) unless its operator set AGENTRUN_MCP_ALLOW_LOOPBACK=1 for it, and when it
 *  says it is on another host than its server (AGENTRUN_RUNNER_LIVE_HOST, a host off loopback), or when it can't tell
 *  where its own loopback is (loopbackMark undefined). `log`: each change of
 *  what a claim found, said once. `markOf`: a test's stand-in for loopbackMark. */
export function standaloneLoopback(env: NodeJS.ProcessEnv, data: string, log: (line: string) => void, markOf: () => string | undefined = loopbackMark): (() => { readonly own: readonly string[] } | undefined) | undefined {
  if (env[MCP_ALLOW_LOOPBACK_ENV] !== "1") return undefined;
  const live = env.AGENTRUN_RUNNER_LIVE_HOST?.trim().toLowerCase();
  if (isLiveHost(live) && live !== LOOPBACK) {
    log(`${MCP_ALLOW_LOOPBACK_ENV}=1 is not taken: this runner is on another host than its server (AGENTRUN_RUNNER_LIVE_HOST=${live}), where loopback is another machine; an MCP server on loopback stays refused`);
    return undefined;
  }
  const mark = markOf();
  if (mark === undefined) {
    log(`${MCP_ALLOW_LOOPBACK_ENV}=1 is not taken: this runner can't read where its loopback is (/proc/sys/kernel/random/boot_id and /proc/self/ns/net), so it can't show it shares the server's; an MCP server on loopback stays refused`);
    return undefined;
  }
  let said: string | undefined;
  const say = (line: string) => {
    if (line !== said) log((said = line));
  };
  return () => {
    const note = readLocalInstallNote(data);
    if (!note) return void say(`${MCP_ALLOW_LOOPBACK_ENV}=1, but the server on ${data} has not said it is a local install (started with ${MCP_ALLOW_LOOPBACK_ENV}=1): an MCP server on loopback stays refused`);
    if (note.mark !== mark) return void say(`${MCP_ALLOW_LOOPBACK_ENV}=1, but the server on ${data} is on another machine or network namespace than this runner, where loopback is not its own: an MCP server on loopback stays refused`);
    say(`${MCP_ALLOW_LOOPBACK_ENV}=1: this runner shares the local-install server's loopback, so its runs may reach an MCP server there, never at the server's own ports`);
    return { own: note.own };
  };
}
