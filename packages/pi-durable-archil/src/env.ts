// The execution environment: pi's NodeExecutionEnv rooted at the run's work/ directory, with an environment id
// that names the run, commands that cannot gain privilege (no_new_privs), file operations confined to work/ (confine.ts),
// read-only built-in tools declared replay-safe, and the hook point for the workspace barrier. Tools run
// on the host that holds the claim, against the claimed mount.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult, ToolHooks, ToolRegistration } from "@earendil-works/pi-durable";
import { err, ExecutionError, FileError, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import type {
  BinaryReader,
  DirReader,
  FileInfo,
  FileWatcher,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
  WatchChange,
  WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv, type NodeWatchOptions } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { canonicalizeSync, Confinement, fileError, inside } from "./confine.ts";
import type { Pin, PinSpec } from "./confine.ts";
import { PdaError } from "./errors.ts";

type ToolCall = Parameters<ToolHooks["afterTool"]>[0];
type ExecCommand = string | readonly string[];

/** What the environment needs of a claim; the claim satisfies it structurally. */
export interface ArchilEnvClaim {
  /** Absolute mount path of the run directory; the same on every host that claims the run. */
  readonly root: string;
  /** Absolute path of the workspace the tools write: `<root>/work`. */
  readonly work: string;
  /** The disk's id; part of the environment id when present. */
  readonly disk?: string;
}

export interface ArchilEnvOptions {
  /** How `watch` runs. Polling is the default because a FUSE mount does not report changes made elsewhere. */
  readonly watch?: NodeWatchOptions;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
  /**
   * Run every command with no_new_privs (`setpriv --no-new-privs --`): setuid programs and file capabilities stop
   * granting privilege, so a command cannot `sudo` even when the run user has a sudo rule (the host needs one for the
   * archil verbs). Default true. Set false on a host that already confines commands, or where util-linux is absent.
   */
  readonly noNewPrivs?: boolean;
  /** The util-linux `setpriv` that `noNewPrivs` runs; default `/usr/bin/setpriv`. */
  readonly setprivPath?: string;
  /**
   * Confine every file operation to the workspace (`PathOutsideWorkError` otherwise): read, write, edit and every other
   * path pi's file system takes. Default true. Set false only where the paths are confined some other way, or where
   * `/proc/self/fd` is unavailable (the confinement walks paths through it).
   */
  readonly confineFiles?: boolean;
  /**
   * Directories file operations may read but never write, besides the workspace and the claim's `tmp/` (where a bash
   * command's spilled output lives and which the bash tool names to the model). For an app's own skills or reference
   * material.
   */
  readonly readRoots?: readonly string[];
}

export type EnvErrorCode = "SETPRIV_UNAVAILABLE" | "PROC_UNAVAILABLE";

/**
 * What `exec` returns once the factory's `cleanup()` ran: no command was started. Its `code` is pi's `spawn_error`
 * (the command could not start), `reason` tells it apart from a program that failed to spawn.
 */
export class EnvClosedError extends ExecutionError {
  readonly reason = "env_closed";
  constructor() {
    super("spawn_error", "The environment is closed (its run released or was fenced): no command was started");
    this.name = "EnvClosedError";
  }
}

/** The environment cannot be built as asked. Exit 1. */
export class EnvError extends PdaError {
  constructor(code: EnvErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

/**
 * A `HarnessOptions.env` that builds a fresh environment per use, plus the identity and shutdown of the run's
 * environments. The environment id is `archil:<disk>:<root>`, so file-mutation serialization keys on the run and a
 * resumed run on another host has the same identity. Temporary files and directories (a bash command's spilled
 * `pi-output-*.log` among them) live under `<root>/tmp/`, inside the claim and outside `work/`, so a path a result
 * names still exists after a takeover on another host. Commands run under no_new_privs unless `noNewPrivs` is false, and
 * every file operation is confined to the workspace (reads also to `tmp/` and `readRoots`) unless `confineFiles` is false.
 */
export interface ArchilEnvFactory {
  /** Rooted at the claim's `work/`; an agent `cwd` is resolved against it. */
  (target: { readonly cwd?: string }): NodeExecutionEnv;
  readonly id: string;
  /**
   * Closes the factory and kills every command still running in an environment it built. pi starts each command as
   * the leader of its own process group, so killing the instance's group does not reach it: a fenced or released
   * instance calls this before it exits. From the first moment of the call, `exec` on the factory's environments, those
   * built before and after it, returns `EnvClosedError` without spawning, so nothing starts between the kill and the
   * exit. A command that had passed that check but not yet spawned is killed at spawn, and ends `aborted` like the
   * commands that were running; calling it again does nothing.
   */
  cleanup(context: Context): Promise<void>;
}

const POLL_INTERVAL_MS = 1000;

const SETPRIV = "/usr/bin/setpriv";
const DEFAULT_PATH = "/usr/bin:/bin";

/** Temporary directories are created under `<root>/tmp/`; the directory itself is 0755 whatever the umask. */
const TEMP_DIR = "tmp";

interface RunScope {
  readonly id: string;
  readonly tempRoot: string;
  /** The `setpriv` that confines every command; undefined when `noNewPrivs` is off. */
  readonly setpriv: string | undefined;
  readonly shellPath: string | undefined;
  readonly shellEnv: NodeJS.ProcessEnv | undefined;
  /** Environments with a command in flight, so `cleanup` reaches commands of environments built per use. */
  readonly running: Set<ArchilExecutionEnv>;
  /** Aborted by `cleanup`: closes the factory, and ends every command that is running or about to spawn. */
  readonly closing: AbortController;
  /** Contains the file operations; undefined when `confineFiles` is off. */
  readonly confinement: Confinement | undefined;
}

class ArchilExecutionEnv extends NodeExecutionEnv {
  declare readonly id: string;
  readonly #scope: RunScope;
  #active = 0;

  constructor(scope: RunScope, options: ConstructorParameters<typeof NodeExecutionEnv>[0]) {
    super(options);
    this.id = scope.id;
    this.#scope = scope;
  }

  override async exec(
    command: ExecCommand,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const { closing } = this.#scope;
    // Checked before anything touches the file system, so a refusal is immediate even when the mount is hung.
    if (closing.signal.aborted) return err(new EnvClosedError());
    this.#active++;
    this.#scope.running.add(this);
    try {
      const confined = await this.#confine(command, options, context);
      if (!confined.ok) return confined;
      // Again after the confinement lookups, which await; the signal then covers pi's own pre-spawn work: pi refuses
      // before spawning once it is aborted, and kills a command that spawns after.
      if (closing.signal.aborted) return err(new EnvClosedError());
      return await super.exec(confined.value, options, withAbortSignal(closing.signal, context));
    } finally {
      if (--this.#active === 0) this.#scope.running.delete(this);
    }
  }

  // `setpriv` replaces itself with the command (execvp), so the process, its group and its exit status are the
  // command's own. A string command becomes the argv of the shell pi would have run it through, which is how
  // setpriv gets in front of the shell; failures pi reports before spawning (no such program, no such shell) are
  // reported the same way here instead of as setpriv's exit status.
  async #confine(
    command: ExecCommand,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ExecCommand, ExecutionError>> {
    const { setpriv, shellPath, shellEnv } = this.#scope;
    if (setpriv === undefined) return ok(command);
    const confine = [setpriv, "--no-new-privs", "--"];
    const cwd = options?.cwd === undefined ? this.cwd : getOrDefault(await this.absolutePath(options.cwd, context), this.cwd);
    const env = options?.inheritEnv === false ? { ...options.env } : { ...process.env, ...shellEnv, ...options?.env };
    if (typeof command === "string") {
      const shell = await resolveShell(shellPath, cwd, env);
      return shell.ok ? ok([...confine, shell.value, "-c", command]) : shell;
    }
    const [program] = command;
    if (program === undefined) return ok(command);
    if (!(await findProgram(program, cwd, env))) return err(new ExecutionError("spawn_error", `spawn ${program} ENOENT`));
    return ok([...confine, ...command]);
  }

  // File operations. Each one resolves its path to the file the kernel would reach and refuses it unless it lies in the
  // workspace (reads may also use the read-only roots); the work is then done on handles held from the root down, so a
  // component swapped for a symlink after the check is refused, not followed (confine.ts). Commands are not file
  // operations: they run arbitrary code, and `exec`'s `cwd` is not confined. Methods not listed are lexical
  // (`absolutePath`, `joinPath`), derived from these (`exists`, `readTextLines`), or not path-taking.

  async #abs(path: string, context: Context): Promise<string> {
    return getOrThrow(await this.absolutePath(path, context));
  }

  async #pinned<T>(
    path: string,
    context: Context,
    pin: (confinement: Confinement, abs: string) => Promise<Pin>,
    run: (pin: Pin) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    let held: Pin | undefined;
    try {
      held = await pin(this.#scope.confinement!, await this.#abs(path, context));
      return await run(held);
    } catch (error) {
      return err(held === undefined ? fileError(error, path) : held.error(error, path));
    } finally {
      await held?.close();
    }
  }

  #entry<T>(path: string, context: Context, spec: PinSpec, run: (pin: Pin) => Promise<Result<T, FileError>>) {
    return this.#pinned(path, context, (confinement, abs) => confinement.pinEntry(abs, path, spec), run);
  }

  /** Opens the file at `path` (a last symlink is resolved by the check, never by the open) and runs `run` on it. */
  #file<T>(
    path: string,
    context: Context,
    spec: { access: "read" | "write"; flags: number; parents?: boolean },
    run: (handle: FileHandle) => Promise<Result<T, FileError>>,
  ) {
    return this.#entry(path, context, { access: spec.access, follow: true, ...(spec.parents ? { parents: true } : {}) }, async (pin) => {
      const handle = await pin.openFile(spec.flags);
      try {
        return await run(handle);
      } finally {
        await handle.close().catch(() => undefined);
      }
    });
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    if (this.#scope.confinement === undefined) return super.readTextFile(path, context);
    return this.#file(path, context, { access: "read", flags: constants.O_RDONLY }, async (handle) =>
      ok(await handle.readFile({ encoding: "utf8", signal: context.abortSignal })),
    );
  }

  override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    if (this.#scope.confinement === undefined) return super.readBinaryFile(path, context);
    return this.#file(path, context, { access: "read", flags: constants.O_RDONLY }, async (handle) =>
      ok(await handle.readFile({ signal: context.abortSignal })),
    );
  }

  override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    if (this.#scope.confinement === undefined) return super.openTextLineReader(path, context);
    // pi opens the file again through the handle's own `/proc/self/fd` entry, which names that inode and no path.
    return this.#file(path, context, { access: "read", flags: constants.O_RDONLY }, (handle) =>
      super.openTextLineReader(`/proc/self/fd/${handle.fd}`, context),
    );
  }

  override async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    if (this.#scope.confinement === undefined) return super.openBinaryReader(path, options, context);
    return this.#entry(path, context, { access: "read", follow: options?.noFollow !== true }, async (pin) => {
      // The target's last component was resolved by the check; pi must not follow it again.
      const opened = await super.openBinaryReader(pin.entry, { noFollow: true }, context);
      return opened.ok ? ok(pin.binaryReader(opened.value)) : pin.restore(opened);
    });
  }

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.writeFile(path, content, context);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
    return this.#file(path, context, { access: "write", flags, parents: true }, async (handle) => {
      await handle.writeFile(content, { signal: context.abortSignal });
      return ok(undefined);
    });
  }

  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.appendFile(path, content, context);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND;
    return this.#file(path, context, { access: "write", flags, parents: true }, async (handle) => {
      await handle.appendFile(content);
      return ok(undefined);
    });
  }

  override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.truncateFile(path, size, context);
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(new FileError("invalid", "File size must be a non-negative safe integer", path));
    }
    return this.#file(path, context, { access: "write", flags: constants.O_RDWR }, async (handle) => {
      await handle.truncate(size);
      return ok(undefined);
    });
  }

  override async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.flushFile(path, context);
    return this.#file(path, context, { access: "write", flags: constants.O_RDWR }, async (handle) => {
      await handle.sync();
      return ok(undefined);
    });
  }

  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.renameFile(sourcePath, destinationPath, context);
    const spec: PinSpec = { access: "write", follow: false, strict: true };
    return this.#entry(sourcePath, context, spec, (source) =>
      this.#entry(destinationPath, context, spec, async (destination) =>
        destination.restore(source.restore(await super.renameFile(source.entry, destination.entry, context))),
      ),
    );
  }

  override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    if (this.#scope.confinement === undefined) return super.fileInfo(path, context);
    return this.#entry(path, context, { access: "read", follow: false }, async (pin) => pin.restore(await super.fileInfo(pin.entry, context)));
  }

  override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    if (this.#scope.confinement === undefined) return super.listDir(path, context);
    return this.#pinned(
      path,
      context,
      (confinement, abs) => confinement.pinDir(abs, path, { access: "read" }),
      async (pin) => pin.restore(await super.listDir(pin.dir, context)),
    );
  }

  override async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    if (this.#scope.confinement === undefined) return super.openDirReader(path, context);
    // The reader names its entries through the held directory as it pages, so the pin lives until the reader closes.
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    let held: Pin | undefined;
    try {
      held = await this.#scope.confinement.pinDir(await this.#abs(path, context), path, { access: "read" });
      const opened = await super.openDirReader(held.dir, context);
      if (!opened.ok) {
        const failure = err<DirReader, FileError>(held.error(opened.error, path));
        await held.close();
        return failure;
      }
      return ok(held.dirReader(opened.value));
    } catch (error) {
      const failure = err<DirReader, FileError>(held === undefined ? fileError(error, path) : held.error(error, path));
      await held?.close();
      return failure;
    }
  }

  override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const confinement = this.#scope.confinement;
    if (confinement === undefined) return super.canonicalPath(path, context);
    try {
      await confinement.locate(await this.#abs(path, context), path, "read", true);
      const canonical = await super.canonicalPath(path, context);
      if (canonical.ok && ![confinement.work, ...confinement.readOnly].some((root) => inside(canonical.value, root))) {
        await confinement.locate(canonical.value, path, "read", true);
      }
      return canonical;
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.createDir(path, options, context);
    if (options?.recursive === false) {
      return this.#entry(path, context, { access: "write", follow: false }, async (pin) => pin.restore(await super.createDir(pin.entry, options, context)));
    }
    return this.#pinned(
      path,
      context,
      (confinement, abs) => confinement.pinDir(abs, path, { access: "write", create: true }),
      async () => ok(undefined),
    );
  }

  override async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (this.#scope.confinement === undefined) return super.remove(path, options, context);
    const removed = await this.#entry(path, context, { access: "write", follow: false, strict: true }, async (pin) =>
      pin.restore(await super.remove(pin.entry, options, context)),
    );
    // `force` ignores a missing target, a missing directory above it included.
    return !removed.ok && removed.error.code === "not_found" && options?.force === true ? ok(undefined) : removed;
  }

  override async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const confinement = this.#scope.confinement;
    if (confinement === undefined) return super.watch(targets, onChange, context);
    // A watch reports that something changed, never contents, and pi's watcher re-reads its paths on its own schedule
    // (and reports a watched symlink's target under the symlink's name): the targets are checked once, here, and handed
    // over as named, not held.
    try {
      for (const target of targets) await confinement.locate(await this.#abs(target.path, context), target.path, "read", true);
      return await super.watch(targets, onChange, context);
    } catch (error) {
      return err(fileError(error, targets[0]?.path ?? "."));
    }
  }

  // pi's `createTempFile` and the spill of a command's output both go through this method.
  override async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
    const { tempRoot } = this.#scope;
    try {
      if ((await mkdir(tempRoot, { recursive: true, mode: 0o755 })) !== undefined) await chmod(tempRoot, 0o755);
      return ok(await mkdtemp(join(tempRoot, prefix ?? "tmp-")));
    } catch (error) {
      return err(fileError(error, tempRoot));
    }
  }
}

function getOrDefault<T>(result: Result<T, unknown>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** The shell pi runs a string command through: `shellPath`, else /bin/bash, else bash on PATH, else sh. */
async function resolveShell(
  shellPath: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Result<string, ExecutionError>> {
  if (shellPath !== undefined && shellPath !== "") {
    return (await exists(shellPath))
      ? ok(shellPath)
      : err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${shellPath}`));
  }
  if (await exists("/bin/bash")) return ok("/bin/bash");
  return ok((await findProgram("bash", cwd, env)) ? "bash" : "sh");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether execvp would find an executable regular file for `program`: with a slash relative to `cwd`, else on PATH. */
async function findProgram(program: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = program.includes("/")
    ? [resolve(cwd, program)]
    : (env.PATH ?? DEFAULT_PATH).split(delimiter).map((dir) => resolve(cwd, dir === "" ? "." : dir, program));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Not here; execvp tries the next directory.
    }
  }
  return false;
}

function requireSetpriv(path: string): string {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
    return path;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new EnvError(
      "SETPRIV_UNAVAILABLE",
      `commands run under no_new_privs through setpriv (util-linux), which is not usable at ${path}: ${reason}. ` +
        "Install util-linux, point setprivPath at it, or pass noNewPrivs: false on a host that already confines commands.",
      { cause },
    );
  }
}

/**
 * The roots, canonical once here: file operations may use the workspace, the claim's `tmp/` (read only) and `readRoots`.
 * Taken at construction, before any agent runs, so a symlink an agent puts in place of `work` or `tmp` later cannot widen
 * them: it resolves outside the roots and is refused.
 */
function requireConfinement(claim: ArchilEnvClaim, readRoots: readonly string[]): Confinement {
  if (!existsSync("/proc/self/fd")) {
    throw new EnvError(
      "PROC_UNAVAILABLE",
      "file operations are confined by walking paths through /proc/self/fd, which is not available here. " +
        "Mount /proc, or pass confineFiles: false where the file paths are confined some other way.",
    );
  }
  const tmp = join(canonicalizeSync(claim.root), TEMP_DIR);
  return new Confinement(canonicalizeSync(claim.work), [tmp, ...readRoots.map((root) => canonicalizeSync(root))]);
}

export function archilEnv(claim: ArchilEnvClaim, options: ArchilEnvOptions = {}): ArchilEnvFactory {
  const id = ["archil", claim.disk, claim.root].filter((part) => part !== undefined && part !== "").join(":");
  const running = new Set<ArchilExecutionEnv>();
  const setpriv = options.noNewPrivs === false ? undefined : requireSetpriv(options.setprivPath ?? SETPRIV);
  const confinement = options.confineFiles === false ? undefined : requireConfinement(claim, options.readRoots ?? []);
  const scope: RunScope = {
    id,
    tempRoot: join(claim.root, TEMP_DIR),
    setpriv,
    shellPath: options.shellPath,
    shellEnv: options.shellEnv,
    running,
    closing: new AbortController(),
    confinement,
  };
  const build = (target: { readonly cwd?: string }) =>
    new ArchilExecutionEnv(scope, {
      cwd: target.cwd === undefined ? claim.work : resolve(claim.work, target.cwd),
      watch: { mode: "polling", pollIntervalMs: POLL_INTERVAL_MS, ...options.watch },
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
    });
  const cleanup = async (context: Context) => {
    scope.closing.abort();
    await Promise.all([...running].map((env) => env.cleanup(context)));
  };
  return Object.assign(build, { id, cleanup });
}

/** Built-in tools that only read. A tool in this set is declared `replay: "safe"`. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"]);
/** Built-in tools that can change the workspace; their results follow the workspace barrier. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash", "powershell"]);

/** The tool declared `replay: "safe"`: an interrupted call reruns on recovery instead of reporting `interrupted`. */
export function replaySafe<T extends ToolRegistration>(tool: T): T {
  return { ...tool, replay: "safe" };
}

/** `tools` with every read-only one declared replay-safe; the others, and the input array, are untouched. */
export function markReadOnlySafe<T extends ToolRegistration>(
  tools: readonly T[],
  readOnly: ReadonlySet<string> = READ_ONLY_TOOLS,
): T[] {
  return tools.map((tool) => (readOnly.has(tool.name) ? replaySafe(tool) : tool));
}

/**
 * pi's `CodingTools` with `read` declared replay-safe. It keeps pi's extension name, so installing it replaces
 * `CodingTools` in place. `write`, `edit` and `bash` stay as pi ships them (unsafe). pi 1.0.4 ships no ls, find or
 * grep; an app that adds them declares them safe with `markReadOnlySafe`.
 */
export const ArchilCodingTools: Extension = defineExtension({
  name: CodingTools.name,
  tools: markReadOnlySafe(CodingTools.tools ?? []),
});

export interface WorkspaceBarrierOptions {
  /** Tools whose result follows a barrier; default `WRITING_TOOLS`. An app adds its own writing tools here. */
  readonly tools?: Iterable<string>;
}

/**
 * The hook point for the rule that the workspace changes a tool made are durable before its result is committed.
 * Install this extension only when the result commit's own fsync does not already satisfy the rule; with it
 * not installed nothing runs. `barrier` is the claim's (`claim.barrier()`), called after a writing tool ran and before
 * pi appends its result entry, for the calls whose tool name is in `options.tools`.
 *
 * pi reports and ignores an `afterTool` hook that throws, so a failed barrier cannot hold the result back by throwing.
 * It replaces the result with an error result carrying the diagnostic `workspace_not_durable`: a success never commits
 * for a workspace that is not durable. The host decides separately whether a failed barrier means the claim is fenced.
 */
export function workspaceBarrier(
  barrier: (call: ToolCall, context: Context) => Promise<void>,
  options: WorkspaceBarrierOptions = {},
): Extension {
  const writing = new Set(options.tools ?? WRITING_TOOLS);
  return defineExtension({
    name: "archil-workspace-barrier",
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (!writing.has(call.name)) return undefined;
          try {
            await barrier(call, context);
            return undefined;
          } catch (error) {
            // An aborted invocation must propagate: pi rethrows hook errors only while it is aborted.
            if (context.abortSignal?.aborted) throw error;
            return notDurable(result, error);
          }
        },
      }),
    ],
  });
}

function notDurable(result: ToolExecutionResult, error: unknown): ToolExecutionResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ...result,
    isError: true,
    diagnostics: [
      ...(result.diagnostics ?? []),
      { severity: "error", code: "workspace_not_durable", message: `The workspace could not be made durable: ${reason}` },
    ],
  };
}
