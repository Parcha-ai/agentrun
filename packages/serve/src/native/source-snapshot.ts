/** Source-side exporter. No service, native CLI, model or network calls; credentials are never copied/exported. */
import { constants } from "node:fs";
import { open, opendir, mkdtemp, mkdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse as toml } from "smol-toml";
import { parseDocument } from "yaml";
import { secretsIn, keyShaped } from "../secret-cut.js";
import { secretShapes } from "../learn/secrets.js";
import type { SourceSnapshot, SourceSnapshotOptions, SourceSnapshotEntry } from "./source-snapshot-types.js";
import { removeOwnedCaptureHooks } from "./source-capture-hooks.js";
import { sourceRuntimeProtocol } from "./source-snapshot-types.js";
import { isNativeRuntime } from "./runtimes.js";
import { SOURCE_CODEX_FEATURES, sourceNativeTools } from "./source-runtime-tools.js";
import { claudeMcpSelector, nativeToolNames, selectedMcpServer, sourceMcpSelection } from "./source-mcp-selection.js";
import { sourceSnapshotDigest } from "./source-snapshot-types.js";
import { sourceAccountContainsSecret, sourceAccountMetadata } from "./source-account.js";
import { capturePiSetup, PI_CONTEXT_FILES } from "./source-pi.js";
import { PosixSourceReader, PosixSourceHandle } from "./source-posix.js";
import { SourceSnapshotError } from "./source-snapshot-error.js";
export { SourceSnapshotError } from "./source-snapshot-error.js";
type SourceHandle = FileHandle | PosixSourceHandle;
export type * from "./source-snapshot-types.js";
export { sourceSnapshotDigest } from "./source-snapshot-types.js";

const SYSTEM_POLICY_PATHS = ["/etc/codex/config.toml", "/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"] as const;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const canonical = (value: any): string => JSON.stringify(value, function (_key, item) {
  return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const credentialPath = (path: string) => path.split(/[\\/]/).some(part => /^(?:\.env(?:\..*)?|(?:mcp-)?auth\.json|credentials(?:\.json)?|\.credentials\.json|\.claude\.json|id_(?:rsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.gnupg)$/i.test(part)) || /\.(?:pem|p12|pfx|key)$/i.test(path);
const portable = (path: string) => path.length > 0 && Buffer.byteLength(path) <= 4096 && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
  && !isAbsolute(path) && path.split("/").every(part => part && part !== "." && part !== "..");
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const signature = (s: Awaited<ReturnType<FileHandle["stat"]>>) => [s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs].join(":");

/** Open every component with NOFOLLOW, including the authorized root. /proc fd paths anchor subsequent
 * reads to already-open directories: swapping a parent for a link cannot redirect a read outside the grant. */
async function noLinks(path: string, expectedRoots: SourceSnapshotOptions["expectedRoots"] = []): Promise<FileHandle> {
  const parts = resolve(path).split(sep).filter(Boolean);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  const checkIdentity = async (opened: string) => {
    const expected = expectedRoots.find(root => root.path === opened);
    if (!expected) return;
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || info.dev.toString() !== expected.device || info.ino.toString() !== expected.inode)
      throw new SourceSnapshotError("source_changed", "An approved source folder was replaced; reconnect it on the source machine.");
  };
  try {
    await checkIdentity("/");
    for (let i = 0; i < parts.length; i++) {
      const opened = sep + parts.slice(0, i + 1).join(sep);
      let next: FileHandle;
      try { next = await open(`/proc/self/fd/${handle.fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (i < parts.length - 1 ? constants.O_DIRECTORY : 0)); }
      catch (error) {
        if (expectedRoots.some(root => within(root.path, resolve(path)) && within(opened, root.path)))
          throw new SourceSnapshotError("source_changed", "An approved source folder is no longer safely available.");
        throw error;
      }
      await handle.close(); handle = next;
      // Check the descriptor before opening any descendant. A path restored after export cannot
      // retroactively authorize bytes read through a different directory inode.
      await checkIdentity(opened);
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

class Reader {
  readonly records = new Map<string, { stamp: string; bytes?: Buffer; names?: string[] } | null>();
  readonly policyStamps = new Map<string, string | null>();
  private readonly accountStamps = new Map<string, string>();
  private readonly checkedContents = new Map<string, string>();
  private checkedContentBytes = 0;
  readonly objectStamps = new Map<string, string>();
  readonly deadline: number;
  readonly limits: Required<NonNullable<SourceSnapshotOptions["limits"]>>;
  private readBytes = 0;
  readonly portable?: PosixSourceReader;
  isolatedGit?: { directory: string; worktree: SourceHandle };
  constructor(readonly options: SourceSnapshotOptions) {
    this.limits = { files: 10_000, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, gitBytes: 32 * 1024 * 1024, timeoutMs: 30_000, ...options.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new SourceSnapshotError("limit", "Snapshot limits must be positive safe integers.");
    if (options.expectedRoots && (options.expectedRoots.some(root => !isAbsolute(root.path) || resolve(root.path) !== root.path
        || !/^\d+$/.test(root.device) || !/^\d+$/.test(root.inode))
      || new Set(options.expectedRoots.map(root => root.path)).size !== options.expectedRoots.length
      || options.authorizedRoots.some(path => !options.expectedRoots!.some(root => root.path === resolve(path)))))
      throw new SourceSnapshotError("source_unavailable", "Source consent must bind every authorized root exactly.");
    this.deadline = Date.now() + this.limits.timeoutMs;
    if (process.platform === "darwin") this.portable = new PosixSourceReader(this.deadline, options.signal);
  }
  private open(path: string): Promise<SourceHandle> { return this.portable ? this.portable.open(path, this.options.expectedRoots) : noLinks(path, this.options.expectedRoots); }
  async names(handle: SourceHandle): Promise<string[]> {
    if (handle instanceof PosixSourceHandle) return handle.names(this.limits.files);
    const names: string[] = [], directory = await opendir(`/proc/self/fd/${handle.fd}`, { bufferSize: 16 });
    try { for (;;) { const entry = await directory.read(); if (!entry) break; names.push(entry.name); if (names.length > this.limits.files) throw new SourceSnapshotError("limit", "A source directory exceeds the file limit."); } }
    finally { await directory.close(); }
    return names;
  }
  async verifyRoots() {
    for (const root of this.options.expectedRoots ?? []) {
      this.check(); const handle = await this.open(root.path); await handle.close();
    }
  }
  check() { this.options.signal?.throwIfAborted(); if (Date.now() > this.deadline) throw new SourceSnapshotError("limit", "The source snapshot exceeded its time limit."); }
  granted(path: string) { return this.options.authorizedRoots.some(root => isAbsolute(root) && within(resolve(root), resolve(path))); }
  async read(path: string, fresh = false, fileLimit = this.limits.fileBytes): Promise<{ stamp: string; bytes?: Buffer; names?: string[] } | null> {
    this.check(); path = resolve(path);
    if (this.options.secretValues?.some(secret => secret && path.includes(secret))) throw new SourceSnapshotError("source_unavailable", "A source path contains a held credential and cannot be exported.");
    if (!this.granted(path)) throw new SourceSnapshotError("source_unavailable", "A required source path is outside the authorized roots.");
    if (!fresh && this.records.has(path)) return this.records.get(path)!;
    if (!fresh && this.records.size >= this.limits.files * 3) throw new SourceSnapshotError("limit", "The source snapshot contains too many paths.");
    let handle: SourceHandle;
    try { handle = await this.open(path); }
    catch (error) {
      if (error instanceof SourceSnapshotError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (!fresh) this.records.set(path, null); return null; }
      throw new SourceSnapshotError("source_unavailable", "A source path cannot be read safely; links and special files need an explicit portable equivalent.");
    }
    try {
      const before = await handle.stat(); let value: { stamp: string; bytes?: Buffer; names?: string[] };
      if (before.isDirectory()) {
        const names = await this.names(handle);
        value = { stamp: signature(before), names: names.sort() };
      } else {
        if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o6000)) throw new SourceSnapshotError("source_unavailable", "Special, linked or privileged files need an explicit portable equivalent.");
        if (before.size > fileLimit) throw new SourceSnapshotError("limit", "A source file exceeds the per-file byte limit.");
        if (!fresh) { if (this.readBytes + before.size > this.limits.bytes) throw new SourceSnapshotError("limit", "Source reads exceed the total byte limit."); this.readBytes += before.size; }
        const bytes = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; this.check(); }
        if (offset !== before.size) throw new SourceSnapshotError("source_changed", "A source file changed while it was read.");
        value = { stamp: signature(before), bytes: bytes.subarray(0, offset) };
      }
      if (signature(await handle.stat()) !== value.stamp) throw new SourceSnapshotError("source_changed", "A source path changed while it was read.");
      if (!fresh) this.records.set(path, value);
      return value;
    } finally { await handle.close(); }
  }
  /** Presence-only probes for required native policy. Fixed system paths are inspected without
   * reading content or broadening the project's export grant; account files stay opaque too. */
  async policyPresent(path: string, fresh = false): Promise<boolean> {
    this.check();
    const piMetadata = sourceRuntimeProtocol(this.options.target.runtime) === "pi-settings" && ((PI_CONTEXT_FILES as readonly string[]).includes(basename(path)) && within(dirname(path), this.options.target.project)
      || basename(path) === ".git" && within(dirname(path), this.options.target.project)
      || basename(path) === "skills" && basename(dirname(path)) === ".agents" && within(dirname(dirname(path)), this.options.target.project));
    if (!this.granted(path) && !(SYSTEM_POLICY_PATHS as readonly string[]).includes(path) && !piMetadata) throw new SourceSnapshotError("source_unavailable", "A required policy path is outside the source grant.");
    let handle: SourceHandle | undefined, stamp: string | null = null;
    try { handle = await this.open(path); stamp = signature(await handle.stat()); }
    catch (error) { if (error instanceof SourceSnapshotError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SourceSnapshotError("source_unavailable", "Required native policy could not be checked safely."); }
    finally { await handle?.close(); }
    if (!fresh) this.policyStamps.set(path, stamp);
    else if (this.policyStamps.get(path) !== stamp) throw new SourceSnapshotError("source_changed", "Native policy changed during export.");
    return stamp !== null;
  }
  keepSecretCheck(bytes: Buffer) {
    const id = hash(bytes); if (this.checkedContents.has(id)) return;
    this.checkedContentBytes += bytes.length;
    if (this.checkedContentBytes > this.limits.bytes + this.limits.gitBytes) throw new SourceSnapshotError("limit", "Source credential checks exceed the snapshot byte limit.");
    this.checkedContents.set(id, bytes.toString("utf8"));
  }
  async verify(metadata?: string) {
    await this.verifyRoots();
    for (const path of this.policyStamps.keys()) await this.policyPresent(path, true);
    for (const path of this.accountStamps.keys()) await this.accountMetadata(path, true, metadata);
    for (const [path, stamp] of this.objectStamps) {
      this.check();
      let handle: SourceHandle | undefined;
      try { handle = await this.open(path); if (signature(await handle.stat()) !== stamp) throw new Error(); }
      catch { throw new SourceSnapshotError("source_changed", "Git objects changed during export."); }
      finally { await handle?.close(); }
    }
    for (const [path, old] of this.records) {
      let current: Awaited<ReturnType<Reader["read"]>>;
      try { current = await this.read(path, true, Math.max(this.limits.fileBytes, old?.bytes?.length ?? 0)); } catch (error) { if (error instanceof SourceSnapshotError && error.code === "limit") throw error; throw new SourceSnapshotError("source_changed", "Source paths changed during export; retry from fresh discovery."); }
      if (!old !== !current || (old && current && (old.stamp !== current.stamp || (old.bytes ? !current.bytes?.equals(old.bytes) : canonical(old.names) !== canonical(current.names)))))
        throw new SourceSnapshotError("source_changed", "Source content changed during export; retry from fresh discovery.");
    }
  }
  /** A separate private read: never puts credentials in records, blobs, provenance or diagnostics.
   * The descriptor, bytes fingerprint and classification are checked again before publication. */
  async accountMetadata(path: string, fresh = false, metadata?: string) {
    this.check();
    if (!this.granted(path)) throw new SourceSnapshotError("source_unavailable", "Source account metadata is outside the source grant.");
    let handle: SourceHandle | undefined, bytes: Buffer | undefined, stamp = "missing", projection = sourceAccountMetadata(null);
    try {
      handle = await this.open(path);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o6000)) throw new SourceSnapshotError("source_unavailable", "Source account metadata cannot be inspected safely.");
      stamp = signature(before);
      if (before.size <= 65_536) {
        bytes = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; this.check(); }
        if (offset !== before.size || signature(await handle.stat()) !== stamp) throw new SourceSnapshotError("source_changed", "Source account metadata changed during export.");
        projection = sourceAccountMetadata(bytes.subarray(0, offset)); stamp += ":" + hash(bytes.subarray(0, offset));
        if (fresh && this.accountStamps.get(path) !== stamp + ":" + canonical(projection)) throw new SourceSnapshotError("source_changed", "Source account metadata changed during export.");
        if (fresh && sourceAccountContainsSecret(bytes.subarray(0, offset), function* (contents: Iterable<string>) { if (metadata) yield metadata; yield* contents; }(this.checkedContents.values()), this.options.target.runtime))
          throw new SourceSnapshotError("source_unavailable", "Source content contains a native credential and cannot be exported.");
      } else {
        if (sourceRuntimeProtocol(this.options.target.runtime) === "pi-settings") throw new SourceSnapshotError("source_unavailable", "Pi authentication metadata exceeds its private inspection bound.");
        projection = sourceAccountMetadata(new Uint8Array(65_537));
      }
    } catch (error) {
      if (error instanceof SourceSnapshotError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SourceSnapshotError("source_unavailable", "Source account metadata cannot be inspected safely.");
    } finally { bytes?.fill(0); await handle?.close(); }
    const state = stamp + ":" + canonical(projection);
    if (!fresh) this.accountStamps.set(path, state);
    else if (this.accountStamps.get(path) !== state) throw new SourceSnapshotError("source_changed", "Source account metadata changed during export.");
    return projection;
  }
  /** Git never consumes live source configuration or path indirections. Copy only its bounded data database
   * through the same no-link reader, synthesize safe config, and inherit an already-open worktree descriptor. */
  async isolateGit(directory: string, common: string): Promise<void> {
    const temporary = await mkdtemp(join(tmpdir(), "agentrun-source-git-"));
    let worktree: SourceHandle | undefined, copied = 0;
    try {
      worktree = await this.open(this.options.target.project);
      const copy = async (source: string, target: string): Promise<void> => {
        const value = await this.read(source, false, this.limits.gitBytes); if (!value) return;
        if (value.names) {
          await mkdir(target, { recursive: true, mode: 0o700 });
          for (const name of value.names) await copy(join(source, name), join(target, name));
        } else if (value.bytes) {
          copied += value.bytes.length;
          if (copied > this.limits.gitBytes) throw new SourceSnapshotError("limit", "The private Git database exceeds the snapshot bound.");
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, value.bytes, { mode: 0o600, flag: "wx" });
        }
      };
      for (const name of ["objects", "refs", "packed-refs", "shallow", "info/exclude"]) await copy(join(common, name), join(temporary, name));
      for (const name of ["HEAD", "index"]) await copy(join(directory, name), join(temporary, name));
      await copy(join(this.options.home, ".config", "git", "ignore"), join(temporary, "source-ignore"));
      await writeFile(join(temporary, "config"), "[core]\n repositoryformatversion = 0\n bare = false\n filemode = true\n", { mode: 0o600, flag: "wx" });
      this.isolatedGit = { directory: temporary, worktree };
    } catch (error) {
      await worktree?.close(); await rm(temporary, { recursive: true, force: true }); throw error;
    }
  }
  async closeGit(): Promise<void> {
    const held = this.isolatedGit; this.isolatedGit = undefined;
    if (held) { try { await held.worktree.close(); } finally { await rm(held.directory, { recursive: true, force: true }); } }
  }
  async inspectObjects(path: string): Promise<void> {
    this.check();
    if (!this.granted(path)) throw new SourceSnapshotError("source_unavailable", "Git objects are outside the source grant.");
    const handle = await this.open(path);
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory() && !stat.isFile()) throw new SourceSnapshotError("source_unavailable", "Git has an unsupported object path.");
      if (this.objectStamps.size >= this.limits.files) throw new SourceSnapshotError("limit", "Git object paths exceed the snapshot bound.");
      this.objectStamps.set(path, signature(stat));
      if (stat.isDirectory()) {
        for (const name of await this.names(handle)) await this.inspectObjects(join(path, name));
      }
    } finally { await handle.close(); }
  }
}

/** stdout is bounded while streaming, and the entire process group is killed on timeout/overflow. Git
 * receives no inherited credentials or runtime environment. No fetch, checkout, filters or native hooks run. */
async function git(reader: Reader, args: string[], max = reader.limits.gitBytes): Promise<Buffer> {
  reader.check();
  const isolated = reader.isolatedGit; if (!isolated) throw new SourceSnapshotError("source_unavailable", "Git source data was not safely isolated.");
  const worktree = isolated.worktree;
  const workPath = worktree instanceof PosixSourceHandle ? "." : "/proc/self/fd/3";
  const gitArgs = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "pack.threads=1", "-c", `core.excludesFile=${join(isolated.directory, "source-ignore")}`, "--git-dir", isolated.directory, "--work-tree", workPath, "-C", workPath, ...args];
  const env = { PATH: "/usr/bin:/bin", HOME: reader.options.home, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  if (worktree instanceof PosixSourceHandle) return worktree.git(gitArgs, env, max);
  return new Promise((accept, reject) => {
    const child = spawn("git", gitArgs, {
      env, detached: true, stdio: ["ignore", "pipe", "ignore", worktree.fd],
    });
    const chunks: Buffer[] = []; let length = 0, settled = false, failure: Error | undefined;
    const finish = (error?: Error, closed = false) => {
      if (settled) return;
      if (error && !failure) { failure = error; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} }
      // Keep the fd and private Git database alive until no process can still use them.
      if (!closed) return;
      settled = true; clearTimeout(timer); reader.options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure); else accept(Buffer.concat(chunks));
    };
    const abort = () => finish(new SourceSnapshotError("source_unavailable", "Source snapshot was cancelled."));
    const timer = setTimeout(() => finish(new SourceSnapshotError("limit", "Git snapshot exceeded its time limit.")), Math.max(1, reader.deadline - Date.now()));
    reader.options.signal?.addEventListener("abort", abort, { once: true });
    if (reader.options.signal?.aborted) abort();
    child.stdout!.on("data", (chunk: Buffer) => { length += chunk.length; if (length > max) finish(new SourceSnapshotError("limit", "Git snapshot exceeded its byte limit.")); else chunks.push(chunk); });
    child.once("error", () => finish(new SourceSnapshotError("source_unavailable", "Git snapshot could not be read.")));
    child.once("close", code => finish(code === 0 ? undefined : new SourceSnapshotError("source_unavailable", "Git snapshot command failed; source history was not exported."), true));
  });
}

export async function exportSourceSnapshot(options: SourceSnapshotOptions): Promise<SourceSnapshot> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new SourceSnapshotError("unsupported_platform", "Whole-setup capture requires Linux or macOS (with Python 3).");
  if (![options.target.project, options.home, ...options.authorizedRoots].every(isAbsolute)) throw new SourceSnapshotError("source_unavailable", "Snapshot roots must be explicit absolute paths.");
  const reader = new Reader(options), target = options.target;
  reader.check();
  try {
  await reader.verifyRoots();
  const sourceIdentity = { runtime: target.runtime, machine_id: target.machine_id, project: target.project, selector: target.selector };
  if (options.secretValues?.some(secret => secret && JSON.stringify(sourceIdentity).includes(secret))) throw new SourceSnapshotError("source_unavailable", "Source identity contains a held credential and cannot be exported.");
  const result: Omit<SourceSnapshot, "digest" | "complete"> = {
    version: 1, source: { runtime: target.runtime, machine_id: target.machine_id, project: target.project, selector: target.selector }, entries: [], blobs: {},
    instructions: { text: "", layers: [] }, skills: [], configuration: { model: target.model, tools: [], permissions: {}, credentials: ["model-provider"] }, project: { git: null }, blockers: [], transforms: [],
  };
  const block = (code: string, message: string, path?: string) => { if (path && (options.secretValues?.some(secret => secret && path!.includes(secret)) || secretShapes(path).length)) path = undefined; if (!result.blockers.some(x => x.code === code && x.path === path)) result.blockers.push({ code, message, ...(path ? { path } : {}) }); };
  const runtimeConfiguration: Record<string, any> = {}; let modelCache: unknown, selectedAgentModel = false, piSkillRoots: string[] = [];
  let bytes = 0, expandedBytes = 0;
  const blob = (body: Buffer) => { const sha = hash(body); if (!Object.hasOwn(result.blobs, sha)) { if (bytes + body.length > reader.limits.bytes) throw new SourceSnapshotError("limit", "Snapshot exceeds its total byte limit."); bytes += body.length; result.blobs[sha] = body.toString("base64"); } return sha; };
  const safe = async (body: Buffer, path: string) => {
    reader.keepSecretCheck(body);
    reader.keepSecretCheck(Buffer.from(path));
    const content = body.toString("utf8");
    // Refuse structured literal credentials even when they have no provider-specific token shape.
    // References name a destination requirement; they never expose a source environment value.
    const reference = (value: string) => /^(?:Bearer )?\$\{[A-Z_][A-Z_0-9]*\}$/.test(value);
    const literal = (value: unknown, key = "", parent = ""): boolean => {
      if (typeof value === "string") return !!value && !reference(value) && (keyShaped(key) || /^(?:authorization|bearer|oauth|accessToken|refreshToken)$/i.test(key) || ["env", "headers", "http_headers"].includes(parent));
      if (Array.isArray(value)) return value.some(item => literal(item, key, parent));
      return value !== null && typeof value === "object" && Object.entries(value).some(([name, item]) => literal(item, name, key));
    };
    let structuredSecret = false;
    try {
      if (/\.json$/i.test(path) || /^\s*[\[{]/.test(content)) structuredSecret = literal(JSON.parse(content));
      else if (/\.toml$/i.test(path)) structuredSecret = literal(toml(content));
      else if (/\.ya?ml$/i.test(path)) structuredSecret = literal(parseDocument(content).toJS({ maxAliasCount: 0 }));
    } catch { /* Invalid source configuration is separately a blocker when it is active policy. */ }
    if (credentialPath(path) || structuredSecret || options.secretValues?.some(secret => secret && (content.includes(secret) || path.includes(secret) || content.includes(JSON.stringify(secret).slice(1, -1)))) || secretShapes(content).length || (await secretsIn(content)).length) {
      block("secret_content", "Credential-bearing content was withheld. Resolve the destination secret through its owner-authorized sign-in flow.", path); return false;
    }
    return true;
  };
  const read = async (source: string, label: string) => {
    try { return await reader.read(source); }
    catch (error) { if (error instanceof SourceSnapshotError && error.code === "source_changed") throw error; block(error instanceof SourceSnapshotError ? error.code : "source_unavailable", "Required source content could not be captured safely and completely.", label); return null; }
  };
  const add = async (source: string, path: string, role: SourceSnapshotEntry["role"]): Promise<Buffer | undefined> => {
    if (!portable(path)) { block("path", "A source filename is not portable."); return; }
    const value = await read(source, path); if (!value) return;
    if (result.entries.some(entry => entry.path === path)) return value.bytes;
    if (result.entries.length >= reader.limits.files) { block("limit", "The source file count exceeds the snapshot limit."); return; }
    const mode = Number(value.stamp.split(":")[3]) & 0o777;
    if (value.names) { if (!await safe(Buffer.alloc(0), path)) return; result.entries.push({ path, role, type: "directory", mode, bytes: 0 }); return; }
    if (!value.bytes || !await safe(value.bytes, path)) return;
    const discovered = target.configuration.find(file => file.path === source);
    if (discovered && hash(value.bytes) !== discovered.sha256) throw new SourceSnapshotError("source_changed", "A source policy or authored skill changed after discovery.");
    if (expandedBytes + value.bytes.length > reader.limits.bytes) { block("limit", "Expanded destination files exceed the snapshot byte limit.", path); return; }
    expandedBytes += value.bytes.length;
    result.entries.push({ path, role, type: "file", mode, bytes: value.bytes.length, sha256: blob(value.bytes) }); return value.bytes;
  };
  const tree = async (source: string, path: string, role: SourceSnapshotEntry["role"]) => {
    const value = await read(source, path); if (!value) return;
    await add(source, path, role);
    if (value.names) for (const name of value.names) {
      if (name === ".git") { block("nested_git", "Nested repositories require their own complete Git export.", path); continue; }
      await tree(join(source, name), `${path}/${name}`, role);
    }
  };
  const instructionTexts: string[] = [];
  const instruction = async (source: string, contents?: string) => {
    const path = `instructions/${String(result.instructions.layers.length).padStart(3, "0")}/${basename(source)}`;
    const body = contents === undefined ? await add(source, path, "instruction") : Buffer.from(contents);
    if (!body) return;
    if (contents !== undefined) {
      if (!await safe(body, path)) return;
      if (expandedBytes + body.length > reader.limits.bytes) { block("limit", "Expanded destination files exceed the snapshot byte limit.", path); return; }
      expandedBytes += body.length; result.entries.push({ path, role: "instruction", type: "file", mode: 0o644, bytes: body.length, sha256: blob(body) });
    }
    let decoded: string; try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); } catch { block("instruction_encoding", "Instructions must be valid UTF-8.", path); return; }
    if (sourceRuntimeProtocol(target.runtime) === "claude-json" && /(^|\s)@[^\s]/m.test(decoded)) block("instruction_import", "Claude instruction imports require explicit closure and approval; they were not silently omitted.", path);
    result.instructions.layers.push({ path, precedence: result.instructions.layers.length, source }); if (decoded.length) instructionTexts.push(decoded);
  };
  const config = async (path: string) => {
    const value = await read(path, "configuration"); if (!value?.bytes) return {};
    const expected = target.configuration.find(x => x.path === path)?.sha256;
    if (expected && hash(value.bytes) !== expected) throw new SourceSnapshotError("source_changed", "Configuration changed after discovery; discover the selected target again.");
    try { return object(path.endsWith(".toml") ? toml(text(value.bytes)) : JSON.parse(text(value.bytes))); }
    catch { block("configuration_parse", "Required configuration could not be parsed.", basename(path)); return {}; }
  };
  const captureHooks = async (path: string, value: Record<string, any>): Promise<Record<string, any>> => {
    if (!isNativeRuntime(target.runtime) || !Object.keys(object(value.hooks)).length) return value;
    const receiptPath = join(target.project, ".agentrun", "cli-learning", `${target.runtime}.json`);
    const receipt = await read(receiptPath, "configuration/capture-receipt"), original = await read(path, "configuration/hooks");
    if (!receipt?.bytes || !original?.bytes) return value;
    try {
      const transformed = removeOwnedCaptureHooks(original.bytes, receipt.bytes, result.source);
      const expected = join(transformed.configRoot, sourceRuntimeProtocol(target.runtime) === "codex-json" ? ".codex/hooks.json" : ".claude/settings.local.json");
      if (resolve(path) !== resolve(expected) || transformed.configRoot !== target.project && (!gitCommonDirectory || resolve(transformed.configRoot) !== dirname(gitCommonDirectory))) return value;
      const projectPath = within(resolve(target.project), resolve(path)) ? `project/${relative(target.project, path).split(sep).join("/")}` : undefined;
      const sourceEntry = projectPath ?? `instructions/capture-hooks/${hash(path).slice(0, 12)}/${basename(path)}`;
      const receiptEntry = `project/.agentrun/cli-learning/${target.runtime}.json`;
      for (const directory of [".agentrun", ".agentrun/cli-learning"]) await add(join(target.project, directory), `project/${directory}`, "project");
      if (!await add(receiptPath, receiptEntry, "project") || !await add(path, sourceEntry, projectPath ? "project" : "instruction")) return value;
      const originalEntry = result.entries.find(entry => entry.path === sourceEntry)!;
      const heldReceipt = result.entries.find(entry => entry.path === receiptEntry)!;
      if (!await safe(transformed.bytes, sourceEntry) || transformed.bytes.length > reader.limits.fileBytes) return value;
      if (expandedBytes + transformed.bytes.length > reader.limits.bytes) { block("limit", "Transformed capture metadata exceeds the snapshot byte limit."); return value; }
      expandedBytes += transformed.bytes.length;
      const transformedHash = blob(transformed.bytes);
      result.transforms!.push({ kind: "agentrun-capture-hooks", path: sourceEntry, original_sha256: originalEntry.sha256!, original_bytes: originalEntry.bytes,
        destination_sha256: transformedHash, destination_bytes: transformed.bytes.length, receipt: { path: receiptEntry, sha256: heldReceipt.sha256! } });
      return object(JSON.parse(text(transformed.bytes)));
    } catch { return value; } // An unproven installation remains required source policy, never an exemption.
  };
  const toolDefinitions = new Map<string, Record<string, any>>(), handledTools = new Set<string>();
  const codexTools = sourceRuntimeProtocol(target.runtime) === "codex-json";
  const mergeTable = (prior: Record<string, any>, next: Record<string, any>): Record<string, any> => {
    const merged: Record<string, any> = Object.assign(Object.create(null), prior);
    for (const [key, value] of Object.entries(next)) merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeTable(object(Object.hasOwn(prior, key) ? prior[key] : undefined), value) : value;
    return merged;
  };
  const tools = async (servers: unknown, label: string) => {
    for (const [name, raw] of Object.entries(object(servers))) {
      if (!await safe(Buffer.alloc(0), `${label}/${name}`)) continue;
      handledTools.add(name);
      // Codex config tables merge from lower to higher precedence. Claude scope entries are
      // selected whole before reaching this function, rather than merging credentials across scopes.
      const value = codexTools ? { ...toolDefinitions.get(name), ...object(raw) } : object(raw), credentials: string[] = [];
      toolDefinitions.set(name, value);
      if (codexTools && value.enabled === false) { result.configuration.tools = result.configuration.tools.filter(tool => tool.name !== name); continue; }
      const supported = new Set(["url", "type", "env_vars", "required_env_vars", "bearer_token_env_var", "env", "headers", "http_headers", "command", ...(codexTools ? ["enabled", "enabled_tools", "disabled_tools"] : [])]);
      if (Object.keys(value).some(key => !supported.has(key)) || value.type !== undefined && value.type !== "http"
          || codexTools && value.enabled !== undefined && typeof value.enabled !== "boolean"
          || ["env_vars", "required_env_vars"].some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item: unknown) => typeof item !== "string")))
          || value.bearer_token_env_var !== undefined && typeof value.bearer_token_env_var !== "string")
        block("tool_configuration", "A tool has capability, transport or policy settings without a supported destination equivalent.", `${label}/${name}`);
      for (const key of ["headers", "http_headers"]) for (const [header, setting] of Object.entries(object(value[key]))) {
        if (header.toLowerCase() !== "authorization" || typeof setting !== "string" || !/^Bearer \$\{[A-Z_][A-Z_0-9]*\}$/.test(setting))
          block("tool_configuration", "A custom tool header needs an explicit destination equivalent.", `${label}/${name}`);
      }
      for (const field of ["env_vars", "required_env_vars"]) if (Array.isArray(value[field])) for (const name of value[field]) if (typeof name === "string") credentials.push(name);
      if (typeof value.bearer_token_env_var === "string") credentials.push(value.bearer_token_env_var);
      let literalCredential = false;
      for (const [key, setting] of Object.entries({ ...object(value.env), ...object(value.headers ?? value.http_headers) })) {
        const reference = typeof setting === "string" && setting.match(/^(?:Bearer )?\$\{([A-Z_][A-Z_0-9]*)\}$/);
        if (reference) credentials.push(reference[1]); else literalCredential = true;
      }
      if (literalCredential || Object.keys(value).some(key => keyShaped(key) && key !== "bearer_token_env_var"))
        block("tool_secret", "A tool has literal environment/authentication settings. Use destination secret setup; source values were not exported.", `${label}/${name}`);
      const transport = value.command ? "stdio" : "http";
      if (transport === "stdio") block("stdio_tool", "A required stdio tool needs a supported destination equivalent.", `${label}/${name}`);
      let url: string | undefined;
      if (typeof value.url === "string") try {
        const parsed = new URL(value.url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !await safe(Buffer.from(value.url), `${label}/${name}`)) throw new Error();
        url = parsed.toString();
      } catch { block("tool_url", "The tool URL cannot be exported without preserving or exposing unsupported authentication.", `${label}/${name}`); }
      if (transport === "http" && !url) block("tool_transport", "A tool endpoint could not be resolved.", `${label}/${name}`);
      const selection = { dialect: "exact" as const, allow: value.enabled_tools === undefined ? null : value.enabled_tools, deny: value.disabled_tools ?? [] };
      if (codexTools && !sourceMcpSelection(selection)) block("tool_selection", "An MCP tool allow/deny list needs valid exact names.", `${label}/${name}`);
      const tool = { name, transport, ...(url ? { url } : {}), credentials: [...new Set(credentials)].sort(),
        ...(codexTools && sourceMcpSelection(selection) ? { selection: { ...selection, allow: selection.allow === null ? null : [...selection.allow].sort(), deny: [...selection.deny].sort() }, resources: ["list", "templates", "read"] } : {}) } as SourceSnapshot["configuration"]["tools"][number];
      const existing = result.configuration.tools.findIndex(x => x.name === name); if (existing >= 0) result.configuration.tools[existing] = tool; else result.configuration.tools.push(tool);
    }
  };

  // Discover the working tree from explicit authorized paths; .git pointers outside the grant block Git reads.
  let root = resolve(target.project), gitRoot: string | undefined, gitControl: string | undefined, gitDirectory: string | undefined, gitCommonDirectory: string | undefined;
  for (let cursor = root; reader.granted(cursor); cursor = dirname(cursor)) {
    const control = await read(join(cursor, ".git"), "project/.git");
    if (control) { gitRoot = cursor; gitControl = join(cursor, ".git"); gitDirectory = gitControl; if (control.bytes) { const match = text(control.bytes).match(/^gitdir: (.+)\r?\n?$/); if (!match) block("git_control", "Git worktree control could not be resolved."); else { const dir = resolve(cursor, match[1]); gitDirectory = dir; if (!reader.granted(dir) || !(await read(dir, "project/.git"))?.names) block("git_control", "The Git directory is outside the source grant or cannot be read safely."); } } break; }
    if (dirname(cursor) === cursor) break;
  }
  // Check Git's own path indirections before invoking it. No hooks, filters, external object alternates,
  // included configuration or ungranted common worktree database may silently enlarge the source grant.
  if (gitDirectory && !result.blockers.some(x => x.code === "git_control")) try {
    const common = await reader.read(join(gitDirectory, "commondir"));
    const commonDirectory = common?.bytes ? resolve(gitDirectory, text(common.bytes).trim()) : gitDirectory; gitCommonDirectory = commonDirectory;
    if (!reader.granted(commonDirectory)) throw new Error();
    for (const directory of new Set([gitDirectory, commonDirectory])) {
      for (const name of ["HEAD", "packed-refs", "index", "shallow", "config", "config.worktree"]) {
        const file = await reader.read(join(directory, name));
        if (name.startsWith("config") && file?.bytes && /^\s*\[\s*(?:include|includeIf|filter|extensions|submodule)(?:\s|\]|\")/mi.test(text(file.bytes)))
          throw new Error();
        if (name.startsWith("config") && file?.bytes && /^\s*(?:worktree\s*=|bare\s*=\s*true|excludesfile\s*=|sparsecheckout\s*=)/mi.test(text(file.bytes))) throw new Error();
      }
      for (const name of ["refs", "objects"]) if (await reader.read(join(directory, name))) await reader.inspectObjects(join(directory, name));
      for (const name of ["alternates", "http-alternates"]) if ((await reader.read(join(directory, "objects", "info", name)))?.bytes?.length) throw new Error();
    }
    await reader.isolateGit(gitDirectory, commonDirectory);
  } catch (error) { if (error instanceof SourceSnapshotError && error.code === "source_changed") throw error; block("git_control", "Git links, filters, included settings, extensions or external object stores need an explicit safe export."); }
  let gitStart: { head: string | null; status: string; index: string; untracked: string } | undefined;
  const gitState = async () => {
    let head: string | null = null; try { head = text(await git(reader, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { /* unborn HEAD is handled explicitly */ }
    return { head, status: text(await git(reader, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])), index: text(await git(reader, ["ls-files", "--stage", "-z"])), untracked: text(await git(reader, ["ls-files", "--others", "--exclude-standard", "-z"])) };
  };
  if (gitRoot && gitControl && !result.blockers.some(x => x.code === "git_control")) {
    if (gitRoot !== root) block("git_subdirectory", "Select the repository root so its history and working tree have the same portable paths.");
    else try {
      gitStart = await gitState(); let branch: string | null = null; try { branch = text(await git(reader, ["symbolic-ref", "--short", "HEAD"])).trim(); } catch { /* detached HEAD */ }
      if (branch !== null && !await safe(Buffer.from(branch), "Git branch")) branch = null;
      result.project.git = { head: gitStart.head, branch, dirty: !!gitStart.status, deleted: [], history: "unavailable" };
      const files = new Set<string>();
      for (const record of gitStart.index.split("\0").filter(Boolean)) {
        const match = record.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/); if (!match || match[3] !== "0") { block("git_index", "An unresolved Git index cannot be exported faithfully."); continue; }
        if (match[1] === "160000") { block("git_submodule", "Submodule history and worktrees need an explicit export.", `project/${match[4]}`); continue; }
        files.add(match[4]);
      }
      for (const path of gitStart.untracked.split("\0").filter(Boolean)) files.add(path);
      await add(root, "project", "project");
      for (const path of [...files].sort()) {
        if (!portable(path)) { block("path", "A Git path is not portable."); continue; }
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
          const parent = parts.slice(0, index).join("/"); await add(join(root, parent), `project/${parent}`, "project");
        }
        if (!await read(join(root, path), `project/${path}`)) result.project.git.deleted.push(path);
        else await add(join(root, path), `project/${path}`, "project");
      }
      // Staged content differs from both HEAD and the current worktree in general. Do not claim index fidelity.
      if (gitStart.status.split("\0").some(line => line && ![" ", "?"].includes(line[0]))) block("git_staging", "Commit or unstage index changes before moving; the working files are captured but index staging is not portable yet.");
      const localConfig = text(await git(reader, ["config", "--local", "--null", "--list"]));
      if (/(?:^|\0)(?:filter\.|include(?:if)?\.|extensions\.|core\.(?:worktree|sparsecheckout)|submodule\.)/i.test(localConfig)) block("git_configuration", "Git filters, includes, extensions or submodules need an explicit portable configuration.");
      if (!gitStart.head) block("git_unborn", "A Git repository with no commit needs an initial commit before its history can be exported.");
      else {
        const objects = text(await git(reader, ["rev-list", "--objects", "HEAD"])).split("\n").filter(Boolean);
        let historyBytes = 0, historySafe = true;
        for (const row of objects) {
          const match = row.match(/^([a-f0-9]{40,64})(?: (.*))?$/); if (!match || (match[2] && (!portable(match[2]) || credentialPath(match[2])))) { historySafe = false; break; }
          const body = await git(reader, ["cat-file", "-p", match[1]], reader.limits.fileBytes); historyBytes += body.length;
          // Tree records name every historical path, even when rev-list chose another path for a shared blob.
          const historicalCredential = body.toString("utf8").split("\n").some(line => { const entry = line.match(/^\d{6} (?:blob|tree|commit) [a-f0-9]+\t(.+)$/); return entry && credentialPath(entry[1]); });
          if (historyBytes > reader.limits.gitBytes || historicalCredential || !await safe(body, match[2] ? `Git history/${match[2]}` : "Git history")) { historySafe = false; break; }
          if (text(await git(reader, ["cat-file", "-t", match[1]])).trim() === "commit") {
            // Pretty tree output quotes non-ASCII names, and rev-list names shared blobs once.
            // Inspect every commit's actual unquoted paths before its compressed bundle can leave.
            const listing = await git(reader, ["ls-tree", "-r", "-z", match[1]], reader.limits.fileBytes); historyBytes += listing.length;
            if (historyBytes > reader.limits.gitBytes) { historySafe = false; break; }
            reader.keepSecretCheck(listing);
            for (const entry of text(listing).split("\0").filter(Boolean)) {
              const found = /^(100644|100755) blob [a-f0-9]{40,64}\t([\s\S]+)$/.exec(entry);
              if (!found || !portable(found[2]!) || credentialPath(found[2]!)) { historySafe = false; break; }
              reader.keepSecretCheck(Buffer.from(found[2]!));
            }
            if (!historySafe) break;
          }
        }
        if (historySafe) {
          // A temporary owned directory is the only exporter write; stdout streaming bounds the bundle itself.
          const temp = await mkdtemp(join(tmpdir(), "agentrun-source-bundle-"));
          try {
            const bundle = await git(reader, ["bundle", "create", "-", "HEAD"]);
            if (expandedBytes + bundle.length > reader.limits.bytes) throw new SourceSnapshotError("limit", "Expanded project and Git history exceed the snapshot byte limit.");
            await writeFile(join(temp, "repository.bundle"), bundle, { mode: 0o600 }); expandedBytes += bundle.length;
            result.project.git.bundle = { sha256: blob(bundle), bytes: bundle.length }; result.project.git.history = "complete";
          }
          finally { await rm(temp, { recursive: true, force: true }); }
        } else block("git_history", "Git history contains excluded credentials, unsupported paths, or exceeds the export limit; no bundle was exported.");
      }
    } catch (error) { if (error instanceof SourceSnapshotError && error.code === "source_changed") throw error; block("git_export", "The complete Git project could not be exported within its safe bounds."); }
  } else if (!gitRoot) await tree(root, "project", "project");

  const ancestors: string[] = [];
  for (let path = root; ; path = dirname(path)) { ancestors.unshift(path); if (path === (gitRoot ?? root) || dirname(path) === path) break; }
  if (sourceRuntimeProtocol(target.runtime) === "pi-settings") {
    const agentDir = options.piHome ?? join(options.home, ".pi", "agent");
    // Register both private credential stores for the final held-secret check. Their bytes and
    // Codex-specific classification never enter Pi's public snapshot.
    await reader.accountMetadata(join(agentDir, "auth.json"));
    await reader.accountMetadata(join(agentDir, "mcp-auth.json"));
    piSkillRoots = await capturePiSetup({ target, home: options.home, agentDir, result,
      read, config, instruction, tools, block,
      context: async path => {
        if (reader.granted(path)) return Boolean(await read(path, "instructions"));
        if (await reader.policyPresent(path)) block("source_scope", "A required Pi instruction or resource lies outside the approved source folders.", "configuration/source_roots");
        return false;
      } });
  } else if (sourceRuntimeProtocol(target.runtime) === "codex-json") {
    const home = options.codexHome ?? join(options.home, ".codex");
    for (const path of SYSTEM_POLICY_PATHS) if (await reader.policyPresent(path))
      block("native_managed_policy", "This source has managed system policy that needs a verified destination equivalent before Move.", "configuration/managed_policy");
    // Only fixed, nonsecret labels leave the private auth reader. Saved claims establish source
    // policy eligibility, never destination authentication; managed/unknown accounts still block.
    const account = await reader.accountMetadata(join(home, "auth.json"));
    result.configuration.native_account = account;
    if (account.plan === "managed" || account.plan === "unknown")
      block("native_account_policy", "The source account policy is managed or unresolved. Resolve it locally before Move; native sign-in is never copied.", "configuration/account_policy");
    const accountPaths = [join(home, "cloud-config-bundle-cache.json")];
    const homeNames = (await reader.read(home))?.names ?? [];
    accountPaths.push(...homeNames.filter(name => /^managed-config-.*\.json$/.test(name)).map(name => join(home, name)));
    for (const path of accountPaths) if (await reader.policyPresent(path))
      block("native_account_policy", "The source account may supply managed policy. Resolve its effective policy without copying native sign-in before Move.", "configuration/account_policy");
    for (const dir of [home, ...ancestors]) {
      const override = join(dir, "AGENTS.override.md"), normal = join(dir, "AGENTS.md");
      if ((await read(override, "instructions"))?.bytes) await instruction(override); else if ((await read(normal, "instructions"))?.bytes) await instruction(normal);
    }
    const receiptMetadata = await config(join(root, ".agentrun", "cli-learning", `${target.runtime}.json`));
    const sharedHooks = receiptMetadata.version === 2 && typeof receiptMetadata.configRoot === "string" && isAbsolute(receiptMetadata.configRoot)
      ? [join(receiptMetadata.configRoot, ".codex", "hooks.json")] : [];
    for (const path of new Set([join(home, "hooks.json"), ...ancestors.map(dir => join(dir, ".codex", "hooks.json")), ...sharedHooks])) {
      const hooks = await captureHooks(path, await config(path));
      if (Object.keys(hooks).length) block("hooks", "Source hooks need an explicit destination equivalent; they were not silently dropped.", "configuration/hooks");
    }
    const configs = [join(home, "config.toml"), ...ancestors.map(dir => join(dir, ".codex", "config.toml")), ...(target.selector.kind === "profile" ? [join(home, `${target.selector.name}.config.toml`)] : [])];
    for (const file of target.configuration) if (basename(file.path) === "config.toml" && !configs.includes(file.path))
      block("configuration_precedence", "A discovered configuration layer has unresolved precedence or lies outside the selected project scope.", "configuration");
    const userConfig = await config(join(home, "config.toml"));
    const selectedTrust = object(object(userConfig.projects)[root]).trust_level;
    for (const path of configs) {
      const value = path === join(home, "config.toml") ? userConfig : await config(path);
      // Codex gates project layers using trusted configuration, before loading the layer itself.
      // A project cannot make its own disabling settings effective by declaring itself trusted.
      if (ancestors.some(dir => path === join(dir, ".codex", "config.toml")) && Object.keys(value).length && selectedTrust !== "trusted") {
        block("project_configuration_trust", "The selected project's configuration needs a verified source trust decision before it can be applied.", "configuration/project_trust");
        continue;
      }
      for (const [key, setting] of Object.entries(value)) {
        if (key === "model" && typeof setting === "string") result.configuration.model = setting;
        else if (key === "projects") {
          const projects = object(setting), selected = projects[root];
          // Trust belongs to the selected project, not every unrelated checkout in the user's file.
          if (selected !== undefined) {
            const policy = object(selected);
            if (Object.keys(policy).some(name => name !== "trust_level") || !["trusted", "untrusted"].includes(policy.trust_level))
              block("project_trust", "The selected project's trust policy needs an explicit supported interpretation.", "configuration/project_trust");
            else result.configuration.permissions.project_trust = policy.trust_level;
          }
        } else if (key === "features") {
          const features = object(setting);
          if (Object.keys(features).some(name => !(SOURCE_CODEX_FEATURES as readonly string[]).includes(name) || typeof features[name] !== "boolean"))
            block("native_features", "A source runtime feature needs verified capability resolution.", "configuration/features");
          runtimeConfiguration.features = { ...object(runtimeConfiguration.features), ...features };
        } else if (key === "tools") {
          const settings = object(setting);
          if (Object.keys(settings).some(name => !["update_plan", "experimental_request_user_input"].includes(name) || Object.keys(object(settings[name])).some(field => field !== "enabled") || typeof settings[name]?.enabled !== "boolean"))
            block("native_tools", "A builtin tool setting needs verified capability resolution.", "configuration/tools");
          runtimeConfiguration.tools = { ...object(runtimeConfiguration.tools), ...settings };
        } else if (key === "agents") {
          const agents = object(setting);
          if (Object.keys(agents).some(name => name !== "enabled") || typeof agents.enabled !== "boolean")
            block("native_agents", "A source subagent setting needs verified capability resolution.", "configuration/agents");
          runtimeConfiguration.agents = agents;
        } else if (key === "cloud") {
          const cloud = object(setting);
          if (Object.keys(cloud).some(name => name !== "skills") || Object.keys(object(cloud.skills)).some(name => name !== "enabled") || typeof cloud.skills?.enabled !== "boolean")
            block("native_cloud", "A source cloud integration needs verified capability resolution.", "configuration/cloud");
          runtimeConfiguration.cloud = cloud;
        } else if (["approval_policy", "sandbox_mode", "sandbox_workspace_write", "web_search"].includes(key)) {
          if (await safe(Buffer.from(canonical(setting)), `configuration/${key}`)) result.configuration.permissions[key] = setting;
        } else if (key === "mcp_servers") {
          for (const [name, value] of Object.entries(object(setting))) toolDefinitions.set(name, mergeTable(toolDefinitions.get(name) ?? {}, object(value)));
        }
        else if (key === "cli_auth_credentials_store" && setting === "file") { /* supported private metadata projection; never exported credentials */ }
        else if (key === "developer_instructions" && typeof setting === "string") await instruction(path, setting);
        else block("unsupported_setting", "This Codex setting needs an explicit managed equivalent.", `configuration/${key}`);
      }
    }
    await tools(Object.fromEntries(toolDefinitions), "tools");
    modelCache = await config(join(home, "models_cache.json"));
    if (target.version === "0.171.0" && result.configuration.permissions.web_search === undefined) result.configuration.permissions.web_search = "cached";
    if (target.selector.kind === "agent") block("selector", "Codex agent selectors are not supported by this exporter.");
  } else {
    const home = options.claudeHome ?? join(options.home, ".claude");
    const disabledProjectMcp = new Set<string>();
    for (const path of [join(home, "CLAUDE.md"), ...ancestors.flatMap(dir => [join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md"), join(dir, "CLAUDE.local.md")])]) if ((await read(path, "instructions"))?.bytes) await instruction(path);
    let selected = target.selector.kind === "agent" ? target.selector.name : undefined;
    for (const path of [join(home, "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")]) {
      const value = await captureHooks(path, await config(path));
      for (const [key, setting] of Object.entries(value)) {
        if (key === "model" && typeof setting === "string") result.configuration.model = setting;
        else if (key === "agent" && typeof setting === "string") { if (target.selector.kind === "project") selected = setting; }
        else if (["enabledMcpjsonServers", "disabledMcpjsonServers"].includes(key) && Array.isArray(setting) && setting.every(name => typeof name === "string")) {
          if (key === "disabledMcpjsonServers") for (const name of setting) disabledProjectMcp.add(name);
        }
        else if (key === "enableAllProjectMcpServers" && typeof setting === "boolean") { /* destination account choice is still explicit */ }
        else if (key === "permissions" && await safe(Buffer.from(canonical(setting)), "configuration/permissions")) {
          for (const [name, policy] of Object.entries(object(setting))) {
            // Modern Claude ignores these privileged modes in project/local settings. Until the
            // installed resolver proves the effective fallback, never widen the user policy here.
            if (name === "defaultMode" && path !== join(home, "settings.json") && ["bypassPermissions", "auto"].includes(String(policy))) {
              block("permission_scope", "This project permission mode needs the source runtime's effective user policy before Move.", "configuration/permissions/defaultMode");
              continue;
            }
            if (["allow", "deny", "ask"].includes(name) && Array.isArray(policy)) {
              const prior = result.configuration.permissions[name];
              result.configuration.permissions[name] = [...new Set([...(Array.isArray(prior) ? prior : []), ...policy])];
            } else result.configuration.permissions[name] = policy;
          }
        }
        else block("unsupported_setting", "This Claude setting needs an explicit managed equivalent.", `configuration/${key}`);
      }
    }
    const user = await config(join(options.home, ".claude.json")), local = object(user.projects?.[root]);
    // Claude uses a whole server entry from local > project > user; fields never merge across scopes.
    const effective: Record<string, any> = Object.assign(Object.create(null), object(user.mcpServers));
    for (const dir of ancestors) for (const [name, value] of Object.entries(object((await config(join(dir, ".mcp.json"))).mcpServers))) {
      handledTools.add(name); if (!disabledProjectMcp.has(name)) effective[name] = value;
    }
    Object.assign(effective, object(local.mcpServers));
    if (local.disabledMcpServers !== undefined && (!Array.isArray(local.disabledMcpServers) || local.disabledMcpServers.some((name: unknown) => typeof name !== "string")))
      block("tool_configuration", "Source MCP enable/disable policy needs a valid server list.", "configuration/tools");
    for (const name of Array.isArray(local.disabledMcpServers) ? local.disabledMcpServers : []) { handledTools.add(name); delete effective[name]; }
    if (local.enabledMcpServers !== undefined && (!Array.isArray(local.enabledMcpServers) || local.enabledMcpServers.some((name: unknown) => typeof name !== "string" || !Object.hasOwn(effective, name))))
      block("tool_configuration", "An enabled builtin MCP integration needs an explicit destination equivalent.", "configuration/tools");
    await tools(effective, "tools");
    if (selected) {
      let chosen: { path: string; body: string; front: Record<string, any> } | undefined;
      for (const file of target.configuration.filter(x => basename(dirname(x.path)) === "agents" && x.path.endsWith(".md"))) {
        const value = await read(file.path, "agent"); if (!value?.bytes) continue;
        if (hash(value.bytes) !== file.sha256) throw new SourceSnapshotError("source_changed", "Selected agent configuration changed after discovery.");
        const body = text(value.bytes), match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const document = parseDocument(match?.[1] ?? "");
        if (document.errors.length) { block("agent_frontmatter", "An agent definition cannot be parsed safely."); continue; }
        const front = object(document.toJS({ maxAliasCount: 0 })); if ((front.name ?? basename(file.path, ".md")) === selected) chosen = { path: file.path, body: body.slice(match?.[0].length ?? 0), front };
      }
      if (!chosen) block("selector", "The selected Claude agent definition was not captured.");
      else {
        await instruction(chosen.path, chosen.body);
        for (const [key, value] of Object.entries(chosen.front)) {
          if (["name", "description"].includes(key)) continue;
          if (key === "model" && typeof value === "string" && value !== "inherit") { result.configuration.model = value; selectedAgentModel = true; }
          else if (["tools", "disallowedTools", "permissionMode"].includes(key) && await safe(Buffer.from(canonical(value)), `agent/${key}`)) result.configuration.permissions[key] = value;
          else if (key !== "model") block("agent_setting", "A selected agent setting needs an explicit managed equivalent.", `agent/${key}`);
        }
      }
    }
    const allowed = nativeToolNames(result.configuration.permissions.tools), denied = nativeToolNames(result.configuration.permissions.disallowedTools) ?? [];
    const selection = { dialect: "claude" as const, allow: allowed === undefined ? null : [...new Set(allowed.filter(claudeMcpSelector))].sort(), deny: [...new Set(denied.filter(claudeMcpSelector))].sort() };
    if (!sourceMcpSelection(selection)) block("tool_selection", "The native MCP tool selection exceeds its supported bounds.", "configuration/tools");
    const resources: ("list" | "read")[] = [];
    for (const [name, operation] of [["ListMcpResourcesTool", "list"], ["ReadMcpResourceTool", "read"]] as const)
      if (allowed?.includes(name) && !denied.includes(name)) resources.push(operation);
    for (const tool of result.configuration.tools) { tool.selection = structuredClone(selection); tool.resources = [...resources]; }
    // An explicit builtin-only agent has no use for these MCP connections. Its captured config
    // remains intact, but no destination account or credential is granted merely because it exists.
    result.configuration.tools = result.configuration.tools.filter(tool => resources.length > 0 || selectedMcpServer(selection, tool.name));
    if (target.selector.kind === "profile") block("selector", "Claude profile selectors are not supported by this exporter.");
  }

  const environment = options.environment ?? {};
  if (sourceRuntimeProtocol(target.runtime) === "claude-json") {
    const model = environment.ANTHROPIC_MODEL || (!result.configuration.model ? environment.ANTHROPIC_DEFAULT_MODEL : undefined);
    if (model) {
      if (selectedAgentModel && model !== result.configuration.model) block("native_environment", "The selected agent and source environment disagree on the model; resolve the native selection before Move.");
      else result.configuration.model = model;
    }
    if (["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_ENABLE_TASKS"].some(name => environment[name] && environment[name] !== "0" && environment[name] !== "false"))
      block("native_environment", "An enabled source provider or tool environment override needs verified destination equivalence.");
  } else if (sourceRuntimeProtocol(target.runtime) === "codex-json" && environment.OPENAI_BASE_URL) block("native_environment", "The source model endpoint needs verified destination equivalence before Move.");
  if (isNativeRuntime(target.runtime)) {
  const native = sourceNativeTools({ runtime: target.runtime, version: target.version, model: result.configuration.model,
    config: runtimeConfiguration, permissions: result.configuration.permissions, mcp: result.configuration.tools.length > 0, modelCache });
  result.configuration.native_tools = native.tools;
  for (const reason of native.blockers) block(reason.code, reason.message, reason.path);
  }
  const skillNames = new Set<string>(), skillSources = new Set(target.configuration.filter(file => basename(file.path) === "SKILL.md").map(file => dirname(file.path)));
  const skillRoots = sourceRuntimeProtocol(target.runtime) === "pi-settings" ? piSkillRoots : sourceRuntimeProtocol(target.runtime) === "codex-json"
    ? [join(options.codexHome ?? join(options.home, ".codex"), "skills"), join(options.home, ".agents", "skills"), ...ancestors.flatMap(dir => [join(dir, ".agents", "skills"), join(dir, ".codex", "skills")])]
    : [join(options.claudeHome ?? join(options.home, ".claude"), "skills"), ...ancestors.map(dir => join(dir, ".claude", "skills"))];
  const piSkills = async (directory: string): Promise<void> => {
    const value = await read(directory, "skills");
    if (!value?.names) return;
    if (value.names.some(name => [".gitignore", ".ignore", ".fdignore"].includes(name))) block("pi_skill_filter", "Pi skill ignore rules need a verified selected-resource closure.", "configuration/skills");
    if (value.names.includes("SKILL.md")) { skillSources.add(directory); return; }
    for (const name of value.names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const child = await read(join(directory, name), "skills");
      if (child?.names) await piSkills(join(directory, name));
      else if (name.endsWith(".md")) block("pi_skill_format", "Use a skill directory with SKILL.md and its supporting files before deploying standalone Pi skill files.", "configuration/skills");
    }
  };
  for (const directory of new Set(skillRoots)) {
    if (sourceRuntimeProtocol(target.runtime) === "pi-settings") { await piSkills(directory); continue; }
    const value = await read(directory, "skills");
    for (const name of value?.names ?? []) if ((await read(join(directory, name, "SKILL.md"), "skills"))?.bytes) skillSources.add(join(directory, name));
  }
  for (const source of [...skillSources].sort()) {
    if (options.secretValues?.some(secret => secret && source.includes(secret))) { block("secret_content", "A skill path contains a held credential and was withheld."); continue; }
    const name = basename(source), path = `skills/${hash(source).slice(0, 12)}/${name}`;
    if (sourceRuntimeProtocol(target.runtime) === "pi-settings") {
      const definition = await read(join(source, "SKILL.md"), "skills");
      if (definition?.bytes) {
        const front = text(definition.bytes).replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        if (front) try {
          const document = parseDocument(front);
          if (document.errors.length) block("pi_skill_definition", "The authored Pi skill front matter cannot be parsed safely.", path);
          else {
            const metadata = object(document.toJS({ maxAliasCount: 0 })), named = metadata.name;
            if (named !== undefined && named !== name) block("pi_skill_name", "The Pi skill's declared name must match its directory for a faithful managed skill index.", path);
            if (typeof metadata.description !== "string" || !metadata.description.trim()) block("pi_skill_definition", "Add the description Pi requires to activate this authored skill before deploying it.", path);
            if (metadata["disable-model-invocation"] === true) block("pi_skill_invocation", "A Pi skill restricted to manual invocation needs an equivalent managed invocation policy.", path);
          }
        } catch { block("pi_skill_definition", "The authored Pi skill front matter cannot be parsed safely.", path); }
        else block("pi_skill_definition", "Add the description Pi requires to activate this authored skill before deploying it.", path);
      }
    }
    if (skillNames.has(name)) block("skill_precedence", "Multiple authored skills have the same name; choose an explicit managed precedence.", `skills/${name}`);
    skillNames.add(name); result.skills.push({ name, path, source }); await tree(source, path, "skill");
  }
  for (const name of target.skills) if (!skillNames.has(name)) block("skill_missing", "A discovered authored skill is missing from the complete source closure.", `skills/${name}`);
  for (const name of target.mcp_servers) if (!handledTools.has(name)) block("tool_missing", "A discovered tool was not captured by the supported configuration resolver.", `tools/${name}`);
  // Discovery already reports managed/plugin/rules sources it cannot resolve. Never turn that uncertainty into ready.
  if (!target.capabilities.learning) block("policy_unresolved", "Discovery could not establish complete source policy; resolve its policy prerequisites before moving.");
  result.instructions.text = instructionTexts.join("\n\n");
  if (result.configuration.model !== null && !await safe(Buffer.from(result.configuration.model), "configuration/model")) result.configuration.model = null;
  if (gitStart && canonical(await gitState()) !== canonical(gitStart)) throw new SourceSnapshotError("source_changed", "Git HEAD, index or working-tree inventory changed during export.");
  reader.check(); await reader.verify(JSON.stringify({ ...result, blobs: {} }));
  result.entries.sort((a, b) => a.path.localeCompare(b.path)); result.skills.sort((a, b) => a.path.localeCompare(b.path)); result.configuration.tools.sort((a, b) => a.name.localeCompare(b.name));
  result.transforms!.sort((a, b) => a.path.localeCompare(b.path));
  result.blockers.sort((a, b) => `${a.code}:${a.path ?? ""}`.localeCompare(`${b.code}:${b.path ?? ""}`));
  const complete = result.blockers.length === 0;
  return { ...result, complete, digest: sourceSnapshotDigest({ ...result, complete }) };
  } finally { try { await reader.closeGit(); } finally { await reader.portable?.close(); } }
}
