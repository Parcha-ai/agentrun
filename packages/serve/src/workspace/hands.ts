// The run's hands, as the kernel's tool registry reaches them (run-adapters kernel/registry Hands), over the run's
// Workspace: what a host tool does with the run's files, its shell and, in a computer, its processes, wherever the run's
// folder is.
//
// The shell: `bash -c <command>` (sh where there is no bash), in the run's folder, stdin at its end, with the run's
// fixed environment (shellEnv) and nothing of this process's: no key, no token, no variable of the server's reaches a
// command. The output goes to onOutput as it comes, decoded per stream; the port keeps none of it.
//
// The processes: in a computer, the attached Workspace's own (attach.ts, computerd's process calls with paths taken in
// the run's folder), as the kernel's narrow port (its Processes: start, read, write, signal, list), which the five
// background tools run on. With no computer there are none, and the registry refuses those tools in words.
import { StringDecoder } from "node:string_decoder";
import type { Hands, ProcessInfo, Processes as KernelProcesses } from "@parcha/agentrun-kernel/kernel";
import type { Result } from "@parcha/agentrun-computer";
import type { Processes } from "./attach.js";
import { type Stat, type Workspace, WorkspaceError } from "./workspace.js";

export type { Hands } from "@parcha/agentrun-kernel/kernel";

/** The longest one exec runs, in seconds: on this machine or a computer; on Archil's serverless exec (its 5 minutes,
 *  less a margin). */
export const MAX_EXEC_S = 600;
export const ARCHIL_MAX_EXEC_S = 295;

/** The programs' folders a command finds: the usual ones, and Homebrew's on a Mac. */
const SHELL_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : [])].join(":");

/** The run's shell environment, fixed: PATH, a UTF-8 locale and a dumb terminal; TMPDIR, a folder in the run's own
 *  folder (never this machine's /tmp), where one is given; and HOME where one is given (the run's folder on this machine;
 *  a computer gives its own). Never a variable of this process's. */
export function shellEnv(options: { readonly home?: string; readonly tmpdir?: string } = {}): Readonly<Record<string, string>> {
  return {
    PATH: SHELL_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
    ...(options.tmpdir === undefined ? {} : { TMPDIR: options.tmpdir }), ...(options.home === undefined ? {} : { HOME: options.home }),
  };
}

const kindOf = (stat: Stat): "file" | "dir" | "link" => (stat.kind === "dir" ? "dir" : stat.kind === "link" ? "link" : "file");

/** A computer call's value, or its refusal thrown as the kernel's port says: an error with the computer's `code` and words. */
async function valueOf<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

/** The attached Workspace's processes as the kernel's port: only the fields the five background tools use. Each start's
 *  output goes to its log (the "log" stream is what a read reads); a listing is read to its last page. */
export function processesOf(processes: Processes): KernelProcesses {
  return {
    async start(spec) {
      const started = await valueOf(processes.start({
        argv: [...spec.argv], cwd: spec.cwd, log: spec.log, waitGroup: spec.waitGroup, orphans: spec.orphans,
        ...(spec.stdin ? { stdin: true } : {}), ...(spec.pty ? { pty: { cols: spec.pty.cols, rows: spec.pty.rows } } : {}),
      }));
      return { handle: started.id, pid: started.pid };
    },
    async read(handle, range) {
      const page = await valueOf(processes.read({ id: handle, stream: "log", offset: range.offset, maxBytes: range.maxBytes }));
      return { data: Buffer.from(page.data, "base64"), size: page.size, capped: page.capped === true };
    },
    async write(handle, input) {
      await valueOf(processes.write({ id: handle, ...(input.data ? { data: Buffer.from(input.data).toString("base64") } : {}), ...(input.close ? { close: true } : {}) }));
    },
    async signal(handle, name) {
      const sent = await valueOf(processes.signal({ id: handle, signal: name }));
      return sent.note === undefined ? {} : { note: sent.note };
    },
    async list() {
      const out: ProcessInfo[] = [];
      for (let from = 0; ;) {
        const page = await valueOf(processes.list({ from }));
        for (const one of page.processes) {
          out.push({ handle: one.id, argv: one.argv, running: one.running, exitCode: one.exitCode, signal: one.signal, startedAt: one.startedAt, pty: one.pty });
        }
        if (!page.truncated || page.processes.length === 0) return out;
        from = page.next;
      }
    },
  };
}

/** The run's hands over `workspace`: its files, its shell with `env` for at most `maxExecS` a command, and the
 *  computer's processes when it has one (`processes`, the attached Workspace's). */
export function handsOf(workspace: Workspace, options: { readonly maxExecS: number; readonly env: Readonly<Record<string, string>>; readonly processes?: Processes }): Hands {
  return {
    maxExecS: options.maxExecS,
    ...(options.processes ? { processes: processesOf(options.processes) } : {}),
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
