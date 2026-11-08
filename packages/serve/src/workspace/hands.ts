// The run's hands, as the kernel's tool registry reaches them, over the run's Workspace: what a host tool does with the
// run's files and shell, wherever the run's folder is. The registry's types are structural here until it lands where
// serve builds against it; its Hands (packages/run-adapters kernel/registry/hands.ts) is this shape.
//
// The shell: `bash -c <command>` (sh where there is no bash), in the run's folder, stdin at its end, with the run's
// fixed environment (shellEnv) and nothing of this process's: no key, no token, no variable of the server's reaches a
// command. The output goes to onOutput as it comes, decoded per stream; the port keeps none of it.
import { StringDecoder } from "node:string_decoder";
import { type Stat, type Workspace, WorkspaceError } from "./workspace.js";

/** How one exec ended: its exit code, or the signal that ended it (exitCode null), and whether its timeout did. */
export type HandsExecResult = { readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean };

/** The kernel registry's Hands. */
export type Hands = {
  readonly maxExecS: number;
  stat(path: string): Promise<{ kind: "file" | "dir" | "link"; size: number; mtimeMs: number } | undefined>;
  read(path: string, range?: { offset?: number; length?: number }): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<readonly { name: string; kind: "file" | "dir" | "link"; size: number }[]>;
  grep(pattern: string, path: string, options?: { glob?: string; ignoreCase?: boolean; maxMatches?: number }): Promise<string>;
  exec(command: string, options: { timeoutS: number; onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void }, signal?: AbortSignal): Promise<HandsExecResult>;
};

/** The longest one exec runs, in seconds: on this machine or a computer; on Archil's serverless exec (its 5 minutes,
 *  less a margin). */
export const MAX_EXEC_S = 600;
export const ARCHIL_MAX_EXEC_S = 295;

/** The programs' folders a command finds: the usual ones, and Homebrew's on a Mac. */
const SHELL_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : [])].join(":");

/** The run's shell environment, fixed: PATH, a UTF-8 locale and a dumb terminal, and HOME where one is given (the run's
 *  folder on this machine; a computer gives its own). Never a variable of this process's. */
export function shellEnv(options: { readonly home?: string } = {}): Readonly<Record<string, string>> {
  return { PATH: SHELL_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", ...(options.home === undefined ? {} : { HOME: options.home }) };
}

const kindOf = (stat: Stat): "file" | "dir" | "link" => (stat.kind === "dir" ? "dir" : stat.kind === "link" ? "link" : "file");

/** The run's hands over `workspace`: its files, and its shell with `env`, for at most `maxExecS` a command. */
export function handsOf(workspace: Workspace, options: { readonly maxExecS: number; readonly env: Readonly<Record<string, string>> }): Hands {
  return {
    maxExecS: options.maxExecS,
    async stat(path) {
      const stat = await workspace.stat(path);
      return stat === undefined ? undefined : { kind: kindOf(stat), size: stat.size, mtimeMs: stat.mtimeMs };
    },
    read: (path, range) => workspace.read(path, range),
    write: (path, bytes) => workspace.write(path, bytes),
    append: (path, bytes) => workspace.append(path, bytes),
    list: (path) => workspace.list(path),
    async grep(pattern, path, grepOptions = {}) {
      if (grepOptions.ignoreCase) throw new WorkspaceError("REFUSED", "grep here takes a JavaScript regex as it is: ignoreCase is not offered");
      const found = await workspace.grep(pattern, { path, ...(grepOptions.glob === undefined ? {} : { glob: grepOptions.glob }), ...(grepOptions.maxMatches === undefined ? {} : { max: grepOptions.maxMatches }) });
      return found.matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n");
    },
    async exec(command, execOptions, signal) {
      if (!Number.isFinite(execOptions.timeoutS) || execOptions.timeoutS <= 0) throw new WorkspaceError("REFUSED", "exec's timeoutS is a number above 0");
      const timeoutMs = Math.round(Math.min(execOptions.timeoutS, options.maxExecS) * 1000);
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const onOutput = execOptions.onOutput;
      const emit = (stream: "stdout" | "stderr", data: string): void => {
        if (data !== "" && onOutput) onOutput({ stream, data });
      };
      const run = (shell: string) => workspace.exec([shell, "-c", command], {
        env: options.env, timeoutMs, maxOutput: 0, ...(signal ? { signal } : {}),
        onOutput: ({ stream, data }) => emit(stream, decoders[stream].write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))),
      });
      let ran;
      try {
        ran = await run("bash");
      } catch (error) {
        if (!(error instanceof WorkspaceError && error.code === "NOT_FOUND")) throw error;
        ran = await run("sh");
      }
      emit("stdout", decoders.stdout.end());
      emit("stderr", decoders.stderr.end());
      return { exitCode: ran.code, signal: ran.signal, timedOut: ran.timedOut };
    },
  };
}
