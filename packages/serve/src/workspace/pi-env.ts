// pi's file environment over a Workspace: pi's own read, write and edit tools, and its bash, run on a run's Workspace
// (a folder here, the owner's disk, or the folder inside a computer) without knowing which. One environment for every
// place, so a tool's arguments, output and words are pi's wherever the run's folder is.
//
// Paths. The model names the run's folder by `cwd`: the folder's own path on this machine with no computer, /workspace
// in one. A path is resolved against it (posix, no link followed: the port refuses links), and one that leaves it is
// refused as "outside the workspace", which fileTools names by the path the call gave ("../x: outside the workspace").
// `aliases` are other absolute names of the same folder a path may come by (a harness's own working directory, the
// folder's real path), taken as `cwd`. `~` and a `file:` URL are outside.
//
// bash. A command runs as `bash -c <command>` (sh where there is no bash) through Workspace.exec, in the run's folder,
// with the environment it is given and nothing of this process's. Its output streams to pi as it comes; past pi's spill
// thresholds the whole output goes to .agentrun/output/<id> in the run's folder, which the model reads with read (and
// the run's end sweeps). A program a signal ended answers 128 + its number, as pi's own environment does.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { exitCodeOf } from "@parcha/agentrun-kernel/kernel";
import {
  type BinaryReader, err, ExecutionError, type ExecutionEnv, FileError, type FileErrorCode, type FileInfo, LineScanner, ok, type Result,
  type ShellExecOptions, type ShellExecResult, StreamDecoder,
} from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { forModelBlocks } from "../result.js";
import { portPath, relativePath } from "./paths.js";
import { type Stat, type Workspace, WorkspaceError } from "./workspace.js";

/** Where a long bash output is spilled whole, in the run's folder. */
export const OUTPUT_DIR = ".agentrun/output";
/** How much of a spill is held before it is appended to its file. */
const SPILL_FLUSH_BYTES = 1024 * 1024;
/** How much one step of a line scan reads. */
const SCAN_CHUNK = 1024 * 1024;

/** The refusal of a path outside the run's folder: pi's FileError, its message naming no path (fileTools names it by
 *  the path the call gave). */
export class OutsideWorkspace extends FileError {
  constructor(path: string) {
    super("permission_denied", "outside the workspace", path);
    this.name = "OutsideWorkspace";
  }
}
/** OutsideWorkspace, already named by the path the call gave. */
class GivenOutside extends OutsideWorkspace {
  constructor(given: string) {
    super(given);
    this.message = `${given}: outside the workspace`;
  }
}

export type PiEnvOptions = {
  /** The absolute name the model knows the run's folder by: its working directory. */
  readonly cwd: string;
  /** Other absolute names of the same folder, taken as `cwd`. */
  readonly aliases?: readonly string[];
  /** bash's whole environment: nothing of this process's is passed. */
  readonly env: Readonly<Record<string, string>>;
  /** bash's deadline when a call names none, in seconds. */
  readonly defaultTimeoutS: number;
};

const CODES: Partial<Record<WorkspaceError["code"], FileErrorCode>> = { NOT_FOUND: "not_found", REFUSED: "permission_denied", ESCAPE: "permission_denied", TOO_LARGE: "invalid", EXISTS: "invalid" };

let envs = 0;

/** pi's ExecutionEnv over `workspace`, the run's folder named `options.cwd`. */
export function piEnv(workspace: Workspace, options: PiEnvOptions): ExecutionEnv {
  const id = `workspace-${++envs}`;
  const cwd = posix.resolve(options.cwd);
  const names = [cwd, ...(options.aliases ?? []).map((alias) => posix.resolve(alias))];

  /** `path` relative to the run's folder, for the port, or the refusal of one outside it. */
  const relative = (path: string): Result<string, FileError> => {
    const port = portPath(path, names);
    if (port === undefined) return err(new OutsideWorkspace(path));
    try {
      return ok(relativePath(port));
    } catch {
      return err(new OutsideWorkspace(path));
    }
  };
  /** `path` as the model's absolute path (under `cwd`), or the refusal of one outside the run's folder. */
  const absolute = (path: string): Result<string, FileError> => {
    const rel = relative(path);
    return rel.ok ? ok(rel.value === "" ? cwd : `${cwd}/${rel.value}`) : rel;
  };
  /** A port failure as pi's FileError, naming the path as the model named it. */
  const failure = (error: unknown, path: string): FileError => {
    if (error instanceof FileError) return error;
    if (error instanceof WorkspaceError) {
      if (error.code === "NOT_FOUND") return new FileError("not_found", `ENOENT: no such file or directory, open '${path}'`, path, error);
      if (error.code === "ESCAPE") return new FileError("permission_denied", `${path}: refused: a link is on the way to it, or it is one, and read, write and edit follow no link in this run's folder (bash can)`, path, error);
      return new FileError(CODES[error.code] ?? "unknown", `${path}: ${error.message}`, path, error);
    }
    return new FileError("unknown", `${path}: ${(error as Error)?.message ?? String(error)}`, path);
  };
  /** `use` on the port's path of `path`, its failure as pi's. */
  async function on<T>(path: string, use: (rel: string, abs: string) => Promise<T>): Promise<Result<T, FileError>> {
    const abs = absolute(path);
    if (!abs.ok) return abs;
    const rel = relative(abs.value);
    if (!rel.ok) return rel;
    try {
      return ok(await use(rel.value, abs.value));
    } catch (error) {
      return err(failure(error, abs.value));
    }
  }
  const infoOf = (stat: Stat, abs: string): FileInfo => ({
    name: posix.basename(abs), path: abs, kind: stat.kind === "dir" ? "directory" : stat.kind === "link" ? "symlink" : "file", size: stat.size, mtimeMs: stat.mtimeMs,
  });
  /** What is at `rel`, a file to read: not there, a folder, a link or anything else is refused as pi's. */
  const fileAt = async (rel: string, abs: string): Promise<Stat> => {
    if (rel === "") throw new FileError("is_directory", `EISDIR: illegal operation on a directory, read '${abs}'`, abs);
    const stat = await workspace.stat(rel);
    if (stat === undefined) throw new FileError("not_found", `ENOENT: no such file or directory, open '${abs}'`, abs);
    if (stat.kind === "dir") throw new FileError("is_directory", `EISDIR: illegal operation on a directory, read '${abs}'`, abs);
    if (stat.kind === "link") throw failure(new WorkspaceError("ESCAPE", "a link"), abs);
    if (stat.kind !== "file") throw new FileError("permission_denied", `${abs}: refused: it is not a regular file`, abs);
    return stat;
  };
  const unoffered = (name: string) => async (): Promise<Result<never, FileError>> =>
    err(new FileError("not_supported", `${name} is not offered here: the run's file tools read, write and edit, and bash runs commands`));

  const reader = (rel: string, abs: string): BinaryReader => ({
    info: async () => {
      try {
        return ok(infoOf(await fileAt(rel, abs), abs));
      } catch (error) {
        return err(failure(error, abs));
      }
    },
    read: async (offset, length) => {
      try {
        return ok(await workspace.read(rel, { offset, length }));
      } catch (error) {
        return err(failure(error, abs));
      }
    },
    scanLines: async ({ startLine, endLine }) => {
      try {
        const scanner = new LineScanner(startLine, endLine);
        for (let offset = 0; ;) {
          const chunk = await workspace.read(rel, { offset, length: SCAN_CHUNK });
          if (chunk.length === 0) break;
          scanner.push(chunk);
          offset += chunk.length;
          if (chunk.length < SCAN_CHUNK) break;
        }
        return ok(scanner.finish());
      } catch (error) {
        return err(failure(error, abs));
      }
    },
    close: async () => undefined,
  });

  async function exec(command: string | readonly string[], given: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const where = relative(given?.cwd ?? cwd);
    if (!where.ok) return err(new ExecutionError("spawn_error", `Working directory is outside the workspace: ${given?.cwd}\nCannot execute bash commands.`));
    const timeoutS = given?.timeout ?? options.defaultTimeoutS;
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    let callbackError: ExecutionError | undefined;
    const emit = (text: string, stream: "stdout" | "stderr"): void => {
      if (text === "" || given?.onOutput === undefined || callbackError !== undefined) return;
      try {
        given.onOutput(text, context, { stream });
      } catch (error) {
        callbackError = new ExecutionError("callback_error", (error as Error)?.message ?? String(error), error as Error);
      }
    };
    // The spill: the output held until it passes pi's thresholds, then all of it appended to its file, in order.
    const spill = given?.spill;
    let seenBytes = 0;
    let seenNewlines = 0;
    let held: Buffer[] = [];
    let heldBytes = 0;
    let spillRel: string | undefined;
    let flushing: Promise<void> = Promise.resolve();
    let spillError: unknown;
    const flush = (): void => {
      if (spillRel === undefined || heldBytes === 0) return;
      const data = Buffer.concat(held);
      held = [];
      heldBytes = 0;
      const to = spillRel;
      flushing = flushing.then(() => workspace.append(to, data)).catch((error: unknown) => { spillError ??= error; });
    };
    const keep = (chunk: Uint8Array): void => {
      if (spill === undefined || chunk.length === 0) return;
      held.push(Buffer.from(chunk));
      heldBytes += chunk.length;
      if (spillRel === undefined) {
        seenBytes += chunk.length;
        for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) seenNewlines++;
        const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
        if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) return;
        spillRel = `${OUTPUT_DIR}/${randomBytes(8).toString("hex")}.log`;
      }
      if (heldBytes >= SPILL_FLUSH_BYTES) flush();
    };
    const run = (argv: readonly string[]) => workspace.exec(argv, {
      cwd: where.value, env: { ...options.env, ...(given?.env ?? {}) }, timeoutMs: Math.max(1, Math.round(timeoutS * 1000)), maxOutput: 0,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      onOutput: ({ stream, data }) => {
        emit(decoders[stream].decode(data), stream);
        keep(data);
      },
    });
    const argvs = typeof command === "string" ? [["bash", "-c", command], ["sh", "-c", command]] : [[...command]];
    let ran: Awaited<ReturnType<typeof run>> | undefined;
    try {
      for (const argv of argvs) {
        try {
          ran = await run(argv);
          break;
        } catch (error) {
          if (!(error instanceof WorkspaceError && error.code === "NOT_FOUND" && argv !== argvs.at(-1))) throw error;
        }
      }
    } catch (error) {
      flush();
      await flushing;
      if (context.abortSignal?.aborted) {
        const aborted = new ExecutionError("aborted", "aborted");
        if (spillRel !== undefined) aborted.spillPath = `${cwd}/${spillRel}`;
        return err(aborted);
      }
      return err(new ExecutionError("spawn_error", (error as Error)?.message ?? String(error), error as Error));
    }
    emit(decoders.stdout.decode(), "stdout");
    emit(decoders.stderr.decode(), "stderr");
    flush();
    await flushing;
    if (callbackError) return err(callbackError);
    const spillPath = spillRel === undefined ? undefined : `${cwd}/${spillRel}`;
    if (ran!.timedOut) {
      const timedOut = new ExecutionError("timeout", `timeout:${given?.timeout}`);
      if (spillPath !== undefined) timedOut.spillPath = spillPath;
      return err(timedOut);
    }
    if (spillError !== undefined) return err(new ExecutionError("unknown", `Failed to preserve complete shell output: ${(spillError as Error)?.message ?? String(spillError)}`, spillError as Error));
    // The kernel's one rule: the code, or 128 + n for signal n; 1 when neither is known, as pi's own environment says.
    const exitCode = exitCodeOf({ exitCode: ran!.code, signal: ran!.signal, timedOut: ran!.timedOut }) ?? 1;
    return ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
  }

  return {
    id,
    cwd,
    absolutePath: async (path) => absolute(path),
    joinPath: async (parts) => ok(posix.join(...parts)),
    // The mutation queue then keys a file by its absolute path: the port follows no link, so that is the file.
    canonicalPath: unoffered("canonicalPath"),
    exists: async (path) => {
      const found = await on(path, async (rel) => (await workspace.stat(rel)) !== undefined);
      // A path refused is there: the operation that follows says why.
      return found.ok ? found : found.error instanceof OutsideWorkspace ? found : ok(true);
    },
    fileInfo: (path) => on(path, async (rel, abs) => {
      const stat = rel === "" ? await workspace.stat("") : await workspace.stat(rel);
      if (stat === undefined) throw new FileError("not_found", `ENOENT: no such file or directory, open '${abs}'`, abs);
      return infoOf(stat, abs);
    }),
    readTextFile: (path) => on(path, async (rel, abs) => {
      await fileAt(rel, abs);
      return Buffer.from(await workspace.read(rel)).toString("utf8");
    }),
    readBinaryFile: (path) => on(path, async (rel, abs) => {
      await fileAt(rel, abs);
      return workspace.read(rel);
    }),
    openBinaryReader: (path) => on(path, async (rel, abs) => {
      await fileAt(rel, abs);
      return reader(rel, abs);
    }),
    openTextLineReader: unoffered("openTextLineReader"),
    readTextLines: unoffered("readTextLines"),
    writeFile: (path, content) => on(path, async (rel, abs) => {
      if (rel === "") throw new FileError("is_directory", `${abs}: is the run's folder, not a file`, abs);
      await workspace.write(rel, content);
    }),
    appendFile: (path, content) => on(path, (rel) => workspace.append(rel, content)),
    createDir: (path) => on(path, (rel) => workspace.mkdir(rel)),
    remove: (path, options) => on(path, (rel) => workspace.remove(rel, { ...(options?.recursive ? { recursive: true } : {}), ...(options?.force ? { force: true } : {}) })),
    listDir: (path) => on(path, async (rel, abs) => (await workspace.list(rel)).map((entry) => ({
      name: entry.name, path: posix.join(abs, entry.name), kind: entry.kind === "dir" ? "directory" as const : "file" as const, size: entry.size, mtimeMs: 0,
    }))),
    truncateFile: unoffered("truncateFile"),
    flushFile: unoffered("flushFile"),
    renameFile: unoffered("renameFile"),
    openDirReader: unoffered("openDirReader"),
    watch: unoffered("watch"),
    createTempDir: unoffered("createTempDir"),
    createTempFile: unoffered("createTempFile"),
    exec,
    cleanup: async () => undefined,
  };
}

/** The image types read opens anywhere in a computer, by extension; the bytes must say the same (imageTypeOf). */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The largest image read hands the model, in bytes: 3.75 MiB, whose base64 is the 5 MiB the strictest platform a
 *  harness sends images to takes (the claude-agent adapter's CLAUDE_AGENT_MAX_IMAGE_BYTES, Amazon Bedrock's). */
export const READ_IMAGE_MAX_BYTES = 3_932_160;
/** The computer's side of an image read: at most `$2` bytes of `$1`. A file over the bound never leaves the computer
 *  whole: the server holds one byte past it at most, and refuses it. */
const READ_IMAGE_SCRIPT = '[ -f "$1" ] && [ -r "$1" ] || exit 6; head -c "$2" -- "$1"';
/** The image type the bytes say they are, or undefined: the magic bytes of PNG, JPEG, GIF and WebP. */
function imageTypeOf(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}
/** A path read may open as an image anywhere in a computer: an absolute path (not `~`, not a URL) whose extension is an
 *  image's. */
const imagePath = (path: string): boolean => path.startsWith("/") && !path.startsWith("//") && IMAGE_EXTENSIONS[posix.extname(path).slice(1).toLowerCase()] !== undefined;

/**
 * pi's read (from fileTools), which in a computer also opens an image at any path there, such as one rendered to /tmp:
 * read through the computer itself (Workspace.exec, the attached workspace's), never on this machine, and only when the
 * bytes are an image's; anything else outside the run's folder is refused as before. `names` are the folder's names
 * (portPath), `env` the shell environment the read runs with. Only for a run with a computer: with none, a path outside
 * the folder is this machine's, and read never opens it.
 */
export function readAnywhereInComputer(read: ToolRegistration, workspace: Workspace, names: readonly string[], env: Readonly<Record<string, string>>): ToolRegistration {
  return {
    ...read,
    async execute(args, api, context) {
      const path = (args as { path?: unknown } | null)?.path;
      if (typeof path !== "string" || !imagePath(path) || portPath(path, names) !== undefined) return read.execute(args, api, context);
      const ran = await workspace.exec(["sh", "-c", READ_IMAGE_SCRIPT, "agentrun-read-image", path, String(READ_IMAGE_MAX_BYTES + 1)], {
        env, timeoutMs: 30_000, maxOutput: READ_IMAGE_MAX_BYTES + 1, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      }).catch(() => undefined);
      // Said as what it is: a path the computer could not read (no such file, no permission), or bytes that are no image's.
      if (!ran || ran.code !== 0) throw new Error(`${path} could not be read in the box`);
      const bytes = ran.stdout;
      const mimeType = imageTypeOf(bytes);
      if (!mimeType) throw new Error(`${path} is not an image`);
      if (bytes.byteLength > READ_IMAGE_MAX_BYTES) throw new Error(`${path} is an image over read's ${READ_IMAGE_MAX_BYTES} bytes: scale it down first (for example with ffmpeg in bash).`);
      // A line naming it, then the image: an answer is never an empty text, on pi or on another harness.
      return forModelBlocks([{ type: "text", text: `${path}: ${mimeType}, ${bytes.byteLength} bytes` }, { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }]);
    },
  };
}

/** A failed call's error with what the environment said, where pi's message gives only its code (edit's "Error code:
 *  permission_denied."), so the model reads why and what it can do. */
const withCause = (error: unknown): unknown => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return error instanceof Error && cause instanceof FileError && !(cause instanceof OutsideWorkspace) && !error.message.includes(cause.message) ? new Error(`${error.message} ${cause.message}`, { cause }) : error;
};

/** pi's bash, as pi ships it: the kernel's registry bounds its timeout and says so. */
export function bashTool(): ToolRegistration {
  const bash = (CodingTools.tools ?? []).find((tool) => tool.name === "bash");
  if (bash === undefined) throw new Error("pi's coding tools carry no bash");
  return bash;
}

/** pi's read, write and edit, each refusal of a path outside the run's folder named by the path the call gave, as it
 *  gave it ("../../.token: outside the workspace"), and nothing else of a tool changed but read's replay: safe, as it
 *  always was (a read changes nothing, so a call a crash cut off runs again). */
export function fileTools(): ToolRegistration[] {
  return ((CodingTools.tools ?? []) as readonly ToolRegistration[]).filter((tool) => tool.name !== "bash").map((tool): ToolRegistration => ({
    ...tool,
    ...(tool.name === "read" ? { replay: "safe" as const } : {}),
    async execute(args, api, context) {
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        const given = (args as { path?: unknown } | undefined)?.path;
        if (!(error instanceof OutsideWorkspace) || error instanceof GivenOutside || typeof given !== "string" || given === "") throw withCause(error);
        throw new GivenOutside(given);
      }
    },
  }));
}
