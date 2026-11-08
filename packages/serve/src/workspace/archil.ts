// ArchilWorkspace: a Workspace on a folder of the owner's Archil disk, through the disk's file API and its serverless
// exec (archil-disk.ts, archil-exec.ts). Nothing is mounted on the server or a runner, and no program runs here.
//
// Keys. The workspace's root is a folder of the disk ("agents/<agent>/runs/<run>/work"); every key, prefix, directory
// and checkout it sends is the root or under it, built from paths paths.ts has checked.
//
// Durability. Archil commits a put, an append or a delete before it answers 200, so each call returns once the API
// has answered. A write is one put: Archil's S3 gateway publishes the object when the put completes (a multipart one,
// above 16 MiB, when it is assembled), so a reader sees the old file or the new one. The API has no rename, so there is
// no temporary key: that guarantee is the gateway's. An append is cut into calls of at most 1 MiB, made in order; a
// reader during it can see part of it (the port allows that), and once it returns all of it is there.
//
// Links. The file API cannot make a symbolic link. An exec can (the folder is a filesystem in the container), and exec
// refuses one on the way to its cwd. Whether the file API follows a link an exec made is not documented.
//
// The queue. While an exec runs it holds the root checked out, and Archil refuses a write under it (409). So this
// workspace runs its execs one at a time and makes its writes wait for them; a 409 from another client's checkout is
// tried again for up to queueMs. Reads do not wait.
//
// Not yet: mountSpec and attach (an Archil folder in a computer is mounted by the computer's helper, module D6, with a
// disk mount token this workspace has no way to make), and background programs, which need a computer (`process`
// refuses every call, cause no-computer, as with any workspace that has none).
import { randomBytes } from "node:crypto";
import type { MountSpec } from "@parcha/agentrun-computer";
import type { ArchilDisk, ArchilListPage } from "./archil-disk.js";
import { archilExec, DEFAULT_QUEUE_MS, MAX_EXEC_MS, STDIN_PREFIX } from "./archil-exec.js";
import { type AttachableComputer, type MountCheck, noProcesses } from "./attach.js";
import { globRegex } from "./glob.js";
import { relativeSegments } from "./paths.js";
import {
  EXEC_OUTPUT_MAX, type Entry, type ExecOptions, type ExecResult, GREP_LINE_MAX, GREP_MAX, GREP_TIME_MS, type GrepMatch,
  type GrepOptions, type GrepResult, READ_MAX, type Workspace, WorkspaceError,
} from "./workspace.js";

/** The most bytes one append call takes. */
export const APPEND_MAX = 1024 * 1024;

export type ArchilWorkspaceOptions = {
  /** How long a call waits for another client's checkout of the folder (default 60 s). */
  readonly queueMs?: number;
};

/** Why an Archil workspace is not yet put in a computer. */
const NOT_IN_A_COMPUTER = "an Archil folder in a computer is mounted by the computer's helper (module D6), not yet: this workspace has no disk mount token to give it";

const show = (path: string): string => JSON.stringify(path === "" ? "." : path);
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};
const describe = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A disk API failure as a WorkspaceError. */
function failed(error: unknown, path: string, what: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const status = statusOf(error);
  const at = { path, cause: error };
  if (status === 404) return new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, at);
  if (status === 413 || (error as { code?: unknown })?.code === "EntityTooLarge") return new WorkspaceError("TOO_LARGE", `${what} ${show(path)}: more than the disk takes in one call`, at);
  if (status === 401 || status === 403) return new WorkspaceError("UNAVAILABLE", `${what} ${show(path)}: Archil refused the key: ${describe(error)}`, at);
  return new WorkspaceError("UNAVAILABLE", `${what} ${show(path)}: ${describe(error)}`, at);
}

const bytesOf = (data: Uint8Array | string): Uint8Array => {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return data;
  throw new WorkspaceError("REFUSED", "data is bytes (a Uint8Array) or a string");
};

/** A grep glob as ripgrep reads it, every special character taken as itself. */
const literalGlob = (name: string): string => name.replace(/[\\*?[\]{}!]/g, "\\$&");

/** A JavaScript regex that ripgrep's engine cannot run: lookaround or a backreference. */
const NOT_RIPGREP = /\(\?<?[=!]|\\[1-9]|\\k</;

class ArchilWorkspace implements Workspace {
  readonly #disk: ArchilDisk;
  readonly #root: string;
  readonly #queueMs: number;
  /** The last exec asked for, settled either way: the next exec, and every write, starts after it. */
  #execs: Promise<unknown> = Promise.resolve();
  #rooted = false;

  constructor(disk: ArchilDisk, root: string, options: ArchilWorkspaceOptions = {}) {
    if (relativeSegments(root).length === 0) throw new WorkspaceError("REFUSED", "an Archil workspace's root is a folder of the disk, not its root");
    this.#disk = disk;
    this.#root = root;
    this.#queueMs = options.queueMs ?? DEFAULT_QUEUE_MS;
  }

  /** The key of relative path `rel` ("" for the root). */
  #key(rel: string): string {
    return rel === "" ? this.#root : `${this.#root}/${rel}`;
  }

  /** The segments of `path`, which must name something below the root. */
  static #below(path: string, what: string): string[] {
    const segments = relativeSegments(path);
    if (segments.length === 0) throw new WorkspaceError("REFUSED", `the workspace's root is a directory, not ${what}`, { path: "" });
    return segments;
  }

  /** `call`, again while another client holds the path checked out (409), for up to queueMs. A 409 because a file is
   *  on the way to `rel` is not waited on. */
  async #settle<T>(rel: string, call: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#queueMs;
    for (let first = true; ; first = false) {
      try {
        return await call();
      } catch (error) {
        if (statusOf(error) !== 409 || Date.now() >= deadline) throw error;
        if (first && (await this.#fileOnTheWay(rel).catch(() => undefined)) !== undefined) throw error;
        await pause(200);
      }
    }
  }

  /** A mutating call made after this workspace's execs are done. */
  async #write<T>(rel: string, call: () => Promise<T>): Promise<T> {
    await this.#execs;
    return this.#settle(rel, call);
  }

  /** Every page of the listing of `prefix`. */
  async *#pages(prefix: string, recursive: boolean): AsyncGenerator<ArchilListPage> {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.#disk.listPage(prefix, { recursive, ...(token === undefined ? {} : { token }) });
      yield page;
      token = page.next;
      if (token !== undefined && seen.has(token)) break;
      if (token !== undefined) seen.add(token);
    } while (token !== undefined);
  }

  /** What `rel` is on the disk: a file, a directory, or nothing. The root is a directory. */
  async #kind(rel: string): Promise<"file" | "dir" | undefined> {
    if (rel === "") return "dir";
    const key = this.#key(rel);
    for await (const page of this.#pages(key, false)) {
      if (page.commonPrefixes.includes(`${key}/`) || page.objects.some((o) => o.key === `${key}/`)) return "dir";
      if (page.objects.some((o) => o.key === key)) return "file";
    }
    return undefined;
  }

  /** The first folder on the way to `rel` (not `rel` itself) that is a file. */
  async #fileOnTheWay(rel: string): Promise<string | undefined> {
    const segments = rel === "" ? [] : rel.split("/");
    for (let i = 1; i < segments.length; i++) {
      const at = segments.slice(0, i).join("/");
      const kind = await this.#kind(at);
      if (kind === "file") return at;
      if (kind === undefined) return undefined;
    }
    return undefined;
  }

  /** Why a write, an append or a mkdir of `rel` failed, in the port's words: the disk's code for it is not documented,
   *  so on a refusal what is there is looked at. */
  async #writeFailed(error: unknown, rel: string, making: "file" | "dir", what: string): Promise<WorkspaceError> {
    if (error instanceof WorkspaceError) return error;
    const status = statusOf(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 413) {
      const way = await this.#fileOnTheWay(rel).catch(() => undefined);
      if (way !== undefined) return new WorkspaceError("EXISTS", `${show(way)} is a file, in the way of ${show(rel)}`, { path: rel, cause: error });
      const kind = await this.#kind(rel).catch(() => undefined);
      if (kind === "file" && making === "dir") return new WorkspaceError("EXISTS", `${show(rel)} is a file, in the way`, { path: rel, cause: error });
      if (kind === "dir" && making === "file") return new WorkspaceError("REFUSED", `${show(rel)} is a directory`, { path: rel, cause: error });
    }
    return failed(error, rel, what);
  }

  async read(path: string, range?: { readonly offset?: number; readonly length?: number }): Promise<Uint8Array> {
    const offset = range?.offset ?? 0;
    const length = range?.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
      throw new WorkspaceError("REFUSED", "a read's offset and length are whole numbers, 0 or more", { path });
    }
    if (length !== undefined && length > READ_MAX) throw new WorkspaceError("TOO_LARGE", `a read returns at most ${READ_MAX} bytes`, { path });
    const rel = ArchilWorkspace.#below(path, "a file").join("/");
    // With no length, one byte past the cap is asked for, so a file too big to read whole is seen without a HEAD.
    const last = length === undefined ? offset + READ_MAX : offset + Math.max(length, 1) - 1;
    let answer;
    try {
      answer = await this.#disk.getRange(this.#key(rel), `bytes=${offset}-${last}`);
    } catch (error) {
      if (statusOf(error) === 404 && (await this.#kind(rel).catch(() => undefined)) === "dir") {
        throw new WorkspaceError("REFUSED", `${show(rel)} is a directory`, { path: rel, cause: error });
      }
      throw failed(error, rel, "read");
    }
    if (answer.status === 416) return new Uint8Array(0);
    // A gateway that ignored the range sent the whole object.
    let body = answer.status === 200 ? answer.body.subarray(offset, last + 1) : answer.body;
    if (length === undefined && body.length > READ_MAX) {
      throw new WorkspaceError("TOO_LARGE", `${show(rel)} is more than ${READ_MAX} bytes from ${offset}; a read returns at most that (read it in ranges)`, { path: rel });
    }
    if (length !== undefined) body = body.subarray(0, length);
    return body;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const rel = ArchilWorkspace.#below(path, "a file").join("/");
    try {
      await this.#write(rel, () => this.#disk.putObject(this.#key(rel), bytes));
    } catch (error) {
      throw await this.#writeFailed(error, rel, "file", "write");
    }
  }

  async append(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const rel = ArchilWorkspace.#below(path, "a file").join("/");
    try {
      // An empty append still makes the file. Each call is acknowledged before the next is made, so they land in order.
      for (let at = 0; at === 0 || at < bytes.length; at += APPEND_MAX) {
        const part = bytes.subarray(at, at + APPEND_MAX);
        await this.#write(rel, () => this.#disk.appendObject(this.#key(rel), part));
      }
    } catch (error) {
      throw await this.#writeFailed(error, rel, "file", "append");
    }
  }

  async list(dir: string): Promise<Entry[]> {
    const rel = relativeSegments(dir).join("/");
    const prefix = `${this.#key(rel)}/`;
    const entries = new Map<string, Entry>();
    try {
      for await (const page of this.#pages(prefix, false)) {
        for (const common of page.commonPrefixes) {
          const name = common.slice(prefix.length).replace(/\/$/, "");
          if (name !== "" && !name.includes("/")) entries.set(name, { name, kind: "dir", size: 0 });
        }
        for (const { key, size } of page.objects) {
          if (!key.startsWith(prefix) || key === prefix) continue;
          const rest = key.slice(prefix.length);
          if (rest.endsWith("/")) entries.set(rest.slice(0, -1), { name: rest.slice(0, -1), kind: "dir", size: 0 });
          else if (!rest.includes("/")) entries.set(rest, { name: rest, kind: "file", size });
        }
      }
    } catch (error) {
      throw failed(error, rel, "list");
    }
    if (entries.size === 0 && rel !== "") {
      const kind = await this.#kind(rel).catch((error: unknown) => { throw failed(error, rel, "list"); });
      if (kind === undefined) throw new WorkspaceError("NOT_FOUND", `${show(rel)} is not there`, { path: rel });
      if (kind === "file") throw new WorkspaceError("REFUSED", `${show(rel)} is not a directory`, { path: rel });
    }
    return [...entries.values()].sort((a, b) => byName(a.name, b.name));
  }

  async mkdir(dir: string): Promise<void> {
    const rel = relativeSegments(dir).join("/");
    try {
      // A directory is a key ending in "/"; its parents are made with it, and one already there is left as it is.
      await this.#write(rel, () => this.#disk.putObject(`${this.#key(rel)}/`, new Uint8Array(0)));
    } catch (error) {
      throw await this.#writeFailed(error, rel, "dir", "mkdir");
    }
    if (rel === "") this.#rooted = true;
  }

  async grep(pattern: string, options: GrepOptions = {}): Promise<GrepResult> {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new WorkspaceError("REFUSED", `${JSON.stringify(pattern)} is not a regex: ${(error as Error).message}`, { cause: error });
    }
    if (NOT_RIPGREP.test(pattern)) {
      throw new WorkspaceError("REFUSED", `${JSON.stringify(pattern)}: the disk's grep runs ripgrep's regex, which has no lookaround and no backreference`);
    }
    const max = options.max ?? GREP_MAX;
    if (!Number.isSafeInteger(max) || max < 1) throw new WorkspaceError("REFUSED", "grep's max is a whole number, 1 or more");
    const timeMs = options.timeMs ?? GREP_TIME_MS;
    if (!Number.isFinite(timeMs) || timeMs <= 0) throw new WorkspaceError("REFUSED", "grep's timeMs is a number above 0");
    const from = relativeSegments(options.path ?? "").join("/");
    const kind = await this.#kind(from).catch((error: unknown) => { throw failed(error, from, "grep"); });
    if (kind === undefined) throw new WorkspaceError("NOT_FOUND", `${show(from)} is not there`, { path: from });
    const limit = Math.min(max, GREP_MAX);
    // ripgrep matches a glob with no "/" against a file's name, and one with a "/" against its path from the directory
    // searched; the port's "/" glob is from the root, so under a path it is matched here instead.
    let globs: string[] | undefined;
    let only: ((path: string) => boolean) | undefined;
    let directory = this.#key(from);
    let recursive = true;
    if (kind === "file") {
      // One file: its folder, not walked down, with a glob of its name; a glob given too is matched here.
      const cut = from.lastIndexOf("/");
      const name = from.slice(cut + 1);
      if (options.glob !== undefined && !globRegex(options.glob).test(options.glob.includes("/") ? from : name)) return { matches: [], truncated: false };
      directory = this.#key(cut === -1 ? "" : from.slice(0, cut));
      globs = [literalGlob(name)];
      recursive = false;
      only = (path) => path === from;
    } else if (options.glob !== undefined) {
      if (!options.glob.includes("/") || from === "") globs = [options.glob];
      else {
        const regex = globRegex(options.glob);
        only = (path) => regex.test(path);
      }
    }
    let answer;
    try {
      answer = await this.#disk.grep({
        directory, pattern, recursive,
        maxResults: only === undefined || kind === "file" ? limit : GREP_MAX,
        maxDurationSeconds: Math.max(1, Math.ceil(Math.min(timeMs, GREP_TIME_MS) / 1000)),
        ...(globs === undefined ? {} : { globs }),
      });
    } catch (error) {
      if (statusOf(error) === 400) throw new WorkspaceError("REFUSED", `the disk's grep refused ${JSON.stringify(pattern)}: ${describe(error)}`, { path: from, cause: error });
      throw failed(error, from, "grep");
    }
    const truncatedBy = answer.stoppedReason === "completed" ? false : answer.stoppedReason === "max_results" ? "max" : answer.stoppedReason === "deadline" ? "time" : undefined;
    if (truncatedBy === undefined) {
      throw new WorkspaceError("UNAVAILABLE", `the disk's grep stopped "${answer.stoppedReason}": part of it failed (a pattern ripgrep cannot run, or a file it could not read)`, { path: from });
    }
    const base = `${this.#root}/`;
    const matches: GrepMatch[] = [];
    for (const { file, line, text } of answer.matches) {
      if (!file.startsWith(base)) continue;
      const path = file.slice(base.length);
      if (only !== undefined && !only(path)) continue;
      matches.push({ path, line, text: text.replace(/\r?\n$/, "").slice(0, GREP_LINE_MAX) });
    }
    matches.sort((a, b) => byName(a.path, b.path) || a.line - b.line);
    if (matches.length > max) return { matches: matches.slice(0, max), truncated: "max" };
    return { matches, truncated: truncatedBy };
  }

  async remove(path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): Promise<void> {
    const segments = relativeSegments(path);
    if (segments.length === 0) throw new WorkspaceError("REFUSED", "the workspace's root is never removed", { path: "" });
    const rel = segments.join("/");
    const key = this.#key(rel);
    try {
      await this.#execs;
      const kind = await this.#kind(rel);
      if (kind === undefined) {
        if (options.force) return;
        throw new WorkspaceError("NOT_FOUND", `${show(rel)} is not there`, { path: rel });
      }
      if (kind === "file") {
        await this.#settle(rel, () => this.#disk.deleteObject(key));
        return;
      }
      const files: string[] = [];
      const folders = new Set<string>([`${key}/`]);
      for await (const page of this.#pages(`${key}/`, true)) {
        for (const { key: found } of page.objects) {
          if (found.endsWith("/")) folders.add(found);
          else files.push(found);
          // Every folder between the directory and what is in it, whether or not the listing names it.
          for (let cut = found.indexOf("/", key.length + 1); cut !== -1 && cut < found.length - 1; cut = found.indexOf("/", cut + 1)) folders.add(found.slice(0, cut + 1));
        }
        if (!options.recursive && (files.length > 0 || folders.size > 1)) {
          throw new WorkspaceError("REFUSED", `${show(rel)} is a directory that is not empty (remove it with recursive)`, { path: rel });
        }
      }
      if (files.length > 0) {
        const errors = await this.#settle(rel, () => this.#disk.deleteObjects(files));
        if (errors.length > 0) throw new WorkspaceError("UNAVAILABLE", `${errors.length} of ${files.length} files under ${show(rel)} were not removed: ${errors[0]!.key}: ${errors[0]!.code ?? ""} ${errors[0]!.message ?? ""}`.trim(), { path: rel });
      }
      // Folders deepest first, so each is empty when it goes.
      for (const folder of [...folders].sort((a, b) => b.split("/").length - a.split("/").length || byName(b, a))) {
        await this.#settle(rel, () => this.#disk.deleteObject(folder));
      }
    } catch (error) {
      throw failed(error, rel, "remove");
    }
  }

  async exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) || argv[0] === "") {
      throw new WorkspaceError("REFUSED", "exec takes argv: a program and its arguments, strings with no NUL");
    }
    if (argv[0]!.includes("=")) throw new WorkspaceError("REFUSED", `${JSON.stringify(argv[0])}: a program's name here has no "="`);
    const env = options.env;
    if (typeof env !== "object" || env === null || !Object.entries(env).every(([key, value]) => key !== "" && !/[=\0]/.test(key) && typeof value === "string" && !value.includes("\0"))) {
      throw new WorkspaceError("REFUSED", "exec's env is the whole environment: names and string values, with no NUL or \"=\" in a name");
    }
    const { timeoutMs } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkspaceError("REFUSED", "exec's timeoutMs is a number above 0");
    if (timeoutMs > MAX_EXEC_MS) throw new WorkspaceError("REFUSED", `an Archil exec is cut at ${MAX_EXEC_MS / 1000} s: ${timeoutMs} ms is more than a call may run`);
    const maxOutput = options.maxOutput ?? EXEC_OUTPUT_MAX;
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new WorkspaceError("REFUSED", "exec's maxOutput is a whole number, 0 or more");
    const cwd = relativeSegments(options.cwd ?? "");
    const run = async (): Promise<ExecResult> => {
      if (!this.#rooted) await this.#makeRoot();
      const stdinName = options.stdin === undefined ? undefined : `${STDIN_PREFIX}${randomBytes(8).toString("hex")}`;
      try {
        if (stdinName !== undefined) {
          const stdin = options.stdin!;
          await this.#settle("", () => this.#disk.putObject(this.#key(stdinName), stdin)).catch((error: unknown) => { throw failed(error, "", "exec's stdin"); });
        }
        const result = await archilExec(this.#disk, { root: this.#root, cwd, argv, env, timeoutMs, maxOutput, queueMs: this.#queueMs, ...(stdinName === undefined ? {} : { stdinName }) });
        // Archil answers once the command has ended: each stream once, whole (and capped). An error the caller's
        // callback throws is not the call's.
        for (const chunk of [{ stream: "stdout", data: result.stdout }, { stream: "stderr", data: Buffer.from(result.stderr, "utf8") }] as const) {
          try { options.onOutput?.(chunk); } catch { /* the caller's callback */ }
        }
        return result;
      } finally {
        // The line moves it into the container first; this is for a line that never ran.
        if (stdinName !== undefined) await this.#disk.deleteObject(this.#key(stdinName)).catch(() => undefined);
      }
    };
    const done = this.#execs.then(run, run);
    this.#execs = done.catch(() => undefined);
    return done;
  }

  /** The root made on the disk: an exec checks it out, so it has to be there. Called inside the exec queue, so it does
   *  not wait for it. */
  async #makeRoot(): Promise<void> {
    await this.#settle("", () => this.#disk.putObject(`${this.#root}/`, new Uint8Array(0))).catch((error: unknown) => { throw failed(error, "", "mkdir"); });
    this.#rooted = true;
  }

  /** No computer: every background call is REFUSED, cause no-computer. */
  readonly process = noProcesses;

  // TODO(D6): the archil MountSpec ({ kind: "archil", disk, region, folder, token }) and attach through attach.ts's
  // checkReadBack and attachedWorkspace, once a disk mount token for the run is passed in (its source decided with D6).
  async mountSpec(): Promise<MountSpec> {
    throw new WorkspaceError("REFUSED", NOT_IN_A_COMPUTER);
  }

  async attach(_computer: AttachableComputer, _check: MountCheck): Promise<Workspace> {
    throw new WorkspaceError("REFUSED", NOT_IN_A_COMPUTER);
  }
}

/** A Workspace on folder `root` of Archil disk `disk` (a relative key, e.g. agents/<agent>/runs/<run>/work). */
export const archilWorkspace = (disk: ArchilDisk, root: string, options?: ArchilWorkspaceOptions): ArchilWorkspace => new ArchilWorkspace(disk, root, options);
export type { ArchilWorkspace };
