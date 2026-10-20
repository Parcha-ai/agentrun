// The environment port: where a source's bytes are read, derivations are written and programs run. It is the part of
// pi-durable's `ExecutionEnv` this package uses, declared structurally so the core imports no pi package: a pi-durable
// host passes its `api.env` as it is, a host with its own `read` passes the Node one from `./node`. Methods return a
// result and never throw for an expected failure, as pi's do; a binary's output is written to a file and read back,
// since a shell's output is text.

/** A result that is never thrown for an expected failure: the value, or the error to act on. */
export type VisionResult<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** The shape of pi's `FileError` and `ExecutionError`: a code to act on and a message for people. */
export type VisionEnvError = Error & { readonly code: string };

/** pi's chord `Context`: the call's cancellation and its scoped values. */
export interface VisionContext {
  readonly abortSignal: AbortSignal | undefined;
  value<T>(key: { readonly token: symbol }): T | undefined;
  toString(): string;
}

/** What the environment knows of a file: its name, path, kind, size in bytes and modification time in milliseconds. */
export interface VisionFileInfo {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mtimeMs: number;
}

/** Positional reads from one opened file; every call sees the same file even if its path is renamed. */
export interface VisionBinaryReader {
  info(context: VisionContext): Promise<VisionResult<VisionFileInfo, VisionEnvError>>;
  read(offset: number, length: number, context: VisionContext): Promise<VisionResult<Uint8Array, VisionEnvError>>;
  close(context: VisionContext): Promise<void>;
}

/** The environment a source is read in and a program runs in: the part of pi-durable's `ExecutionEnv` this package uses.
 *  A pi-durable host passes its `api.env`; `nodeVisionEnv` from `./node` is the one for a host whose `read` is its own. */
export interface VisionEnv {
  /** Equal ids see the same files at the same paths; a cache keyed by a provider's detection uses it. */
  readonly id: string;
  cwd: string;
  readBinaryFile(path: string, context: VisionContext): Promise<VisionResult<Uint8Array, VisionEnvError>>;
  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: VisionContext): Promise<VisionResult<VisionBinaryReader, VisionEnvError>>;
  writeFile(path: string, content: string | Uint8Array, context: VisionContext): Promise<VisionResult<void, VisionEnvError>>;
  renameFile(sourcePath: string, destinationPath: string, context: VisionContext): Promise<VisionResult<void, VisionEnvError>>;
  createDir(path: string, options: { recursive?: boolean } | undefined, context: VisionContext): Promise<VisionResult<void, VisionEnvError>>;
  createTempDir(prefix: string | undefined, context: VisionContext): Promise<VisionResult<string, VisionEnvError>>;
  fileInfo(path: string, context: VisionContext): Promise<VisionResult<VisionFileInfo, VisionEnvError>>;
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: VisionContext): Promise<VisionResult<void, VisionEnvError>>;
  /** An array runs its first element with the rest as arguments, through no shell. `timeout` is in SECONDS, as pi's
   *  environments read it: past it the program is killed and the result is an error with code `timeout`. Only the exit
   *  code comes back; a program's output is written to a file and read back. */
  exec(command: string | readonly string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } | undefined, context: VisionContext): Promise<VisionResult<{ exitCode: number }, VisionEnvError>>;
}

/** A context for one call that has only a signal: no scoped values, and a context chord derives from it does not see
 *  the signal. A pi-durable host passes the call's own context instead. */
export function visionContext(signal?: AbortSignal): VisionContext {
  return { abortSignal: signal, value: () => undefined, toString: () => "pi-vision" };
}
