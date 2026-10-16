import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitRemoteError } from "./errors.js";
import { createGitRunner, EMPTY_TREE, gitVersion, type GitCall, type GitIdentity } from "./git.js";
import {
  caseCollisions, checkCommitFiles, DEFAULT_LIMITS, type FileContent, type Limits, modeRefusal, pathPrefixes, pathRefusal,
} from "./limits.js";
import { checkRemote, type GitCredential, type Remote } from "./remotes.js";

/** The trailer that makes `commitTo` idempotent: a branch that already holds a commit with the same value gets none. */
export const RUN_ID_TRAILER = "Run-Id";
/** The branch a new branch starts from when no parent is given. */
export const MAIN = "main";

const ZERO = "0".repeat(40);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SCRATCH = "pi-git-remote";
const MIN_GIT: readonly [number, number] = [2, 40];
/** Checkout reads and writes blobs in batches this size, so its memory stays bounded whatever the tree holds. */
const CHECKOUT_BATCH_BYTES = 8 * 1024 * 1024;
const CHECKOUT_BATCH_FILES = 256;

export type RepoOptions = {
  /** The host's own repository: created bare here when the directory is empty or absent. It must never be reachable
   *  by an agent, since git reads its config and `info/attributes` whatever flags are passed. */
  readonly dir: string;
  readonly remote: Remote;
  /** The git executable. Default: `git` on PATH. */
  readonly git?: string;
  readonly limits?: Partial<Limits>;
  readonly identity?: GitIdentity;
  /** Kill a git call after this long. Default: 120 s. */
  readonly timeoutMs?: number;
};

export type TreeEntry = {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Bytes, for a blob. */
  readonly size?: number;
};

export type LogEntry = {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly trailers: Readonly<Record<string, readonly string[]>>;
};

export type Trailers = Readonly<Record<string, string | readonly string[]>>;

export type CommitOptions = {
  /** Path to content; `null` deletes the path. Every file is written as a regular, non-executable file. */
  readonly files: Readonly<Record<string, FileContent>>;
  readonly message: string;
  readonly trailers?: Trailers;
  /** The commit to build on (a sha or a branch). When the branch exists, its tip must be this commit, or the call
   *  fails with `conflict`. Default: the branch's tip, else main's. */
  readonly parent?: string;
  /** Make the commit even when `files` change nothing, for a commit whose message and trailers are the record. */
  readonly allowEmpty?: boolean;
};

export type Committed = { readonly sha: string; readonly created: boolean };
export type Branch = { readonly name: string; readonly sha: string };
export type Skipped = { readonly path: string; readonly reason: string };
export type CheckoutResult = { readonly sha: string; readonly files: readonly string[]; readonly skipped: readonly Skipped[] };
export type MergeResult = { readonly sha: string; readonly changed: boolean; readonly fastForward: boolean };
export type RevertResult = { readonly sha: string; readonly changed: boolean };
export type LogOptions = {
  /** A branch or a sha. Default: main. */
  readonly ref?: string;
  readonly path?: string;
  /** Only commits carrying this trailer key, with this value when it is given. */
  readonly trailer?: { readonly key: string; readonly value?: string };
  readonly max?: number;
};

/**
 * A git repository the host owns, kept in step with one remote. Every method fetches first where it reads a branch,
 * writes only through plumbing on a temporary index, and never runs a hook, filter, driver or credential helper of the
 * repository's. Writes change local branches; `push` sends a commit to the remote. Calls on one Repo run one at a time.
 */
export type Repo = {
  readonly dir: string;
  readonly remote: Remote;
  readonly limits: Limits;
  fetch(): Promise<void>;
  /** The commit a branch or sha names: a local commit not yet pushed wins over the remote, unless the remote moved past
   *  or away from it. Undefined when there is none. */
  resolve(ref: string): Promise<string | undefined>;
  /** Copies the regular files of `ref` into the empty directory `into`, never executable. Symlinks, submodules, paths
   *  git's index refuses, case collisions and files over the size cap are skipped and named. */
  checkout(ref: string, options: { readonly into: string }): Promise<CheckoutResult>;
  /** The branches whose names start with `prefix` (empty, or a branch name and a slash), here or on the remote, each at
   *  the commit `resolve` gives for it, sorted by name. */
  branches(prefix: string): Promise<Branch[]>;
  /** A file's text at a commit (a full sha, or a branch, fetched first); undefined when the path is absent or a
   *  directory. */
  read(path: string, ref: string): Promise<string | undefined>;
  /** Every entry under `prefix` ("" for the whole tree) at a commit (a full sha, or a branch, fetched first). */
  list(prefix: string, ref: string): Promise<TreeEntry[]>;
  /** One commit on `branch` with `files` applied, or none when the branch already holds a commit with the same
   *  `Run-Id` trailer, here or on the remote, or when nothing changes. Local only; `push` it after. */
  commitTo(branch: string, options: CommitOptions): Promise<Committed>;
  /** Sends a commit to `branch` on the remote: by sha, never forced, never running a hook on either side. A remote that
   *  moved is a `conflict`; a remote that refuses the ref is `refused`. */
  push(sha: string, branch: string): Promise<void>;
  /** Merges `from` into `into` here: a fast-forward when possible, else a merge commit from merge-tree. A conflict
   *  changes nothing. Local only; `push` it after. */
  merge(from: string, into: string): Promise<MergeResult>;
  /** A commit on `on` that undoes `sha`, which must be on `on`. A conflict changes nothing; reverting twice changes
   *  nothing the second time. Local only; `push` it after. */
  revert(sha: string, on: string, options?: { readonly trailers?: Trailers }): Promise<RevertResult>;
  /** Commits newest first, with their trailers. */
  log(options?: LogOptions): Promise<LogEntry[]>;
};

function refused(message: string, paths: readonly string[] = []): GitRemoteError {
  return new GitRemoteError("refused", message, paths);
}

function checkBranch(name: string): string {
  const short = typeof name === "string" && name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
  if (
    typeof short !== "string" || short === "" || short.length > 200 || short === "HEAD" || !/^[A-Za-z0-9._/-]+$/.test(short) ||
    short.includes("..") || short.split("/").some((s) => s === "" || s.startsWith(".") || s.startsWith("-") || s.endsWith(".") || s.endsWith(".lock"))
  ) {
    throw refused(`the branch name ${JSON.stringify(name)} is not allowed`);
  }
  return short;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function firstValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function formatMessage(message: string, trailers: Trailers = {}): string {
  if (typeof message !== "string" || message.trim() === "" || message.includes("\0")) throw refused("the commit message is empty or holds a NUL");
  if (trailers === null || typeof trailers !== "object") throw refused("trailers must be an object");
  const lines: string[] = [];
  for (const [key, value] of Object.entries(trailers)) {
    if (!TRAILER_KEY.test(key)) throw refused(`the trailer key ${JSON.stringify(key)} is not allowed`);
    for (const v of typeof value === "string" ? [value] : value) {
      if (typeof v !== "string" || v === "" || v !== v.trim() || /[\u0000-\u001f\u007f]/.test(v)) throw refused(`the trailer ${key} needs a one-line value`);
      lines.push(`${key}: ${v}`);
    }
  }
  const body = message.replace(/\s+$/, "");
  return lines.length ? `${body}\n\n${lines.join("\n")}\n` : `${body}\n`;
}

function parseEntry(line: string): TreeEntry {
  const tab = line.indexOf("\t");
  const [mode, type, oid, size] = line.slice(0, tab).split(/ +/);
  return { path: line.slice(tab + 1), mode: mode!, type: type!, oid: oid!, ...(size && size !== "-" ? { size: Number(size) } : {}) };
}

function parseLog(sha: string, parents: string, subject: string, trailerText: string): LogEntry {
  const trailers: Record<string, string[]> = {};
  for (const line of trailerText.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    (trailers[line.slice(0, colon).trim()] ??= []).push(line.slice(colon + 1).trim());
  }
  return { sha, parents: parents ? parents.split(" ") : [], subject, trailers };
}

async function dirState(dir: string): Promise<"new" | "repo"> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "new";
    throw error;
  }
  if (entries.includes("HEAD")) return "repo";
  if (entries.every((entry) => entry === SCRATCH)) return "new";
  throw refused(`${dir} is neither empty nor a bare repository`);
}

function checkLimits(input: Partial<Limits> | undefined): Limits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of ["maxFileBytes", "maxFiles", "maxTreeEntries"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw refused(`limits.${key} must be a positive integer`);
  }
  return Object.freeze(limits);
}

export async function openRepo(options: RepoOptions): Promise<Repo> {
  if (!options || typeof options.dir !== "string" || options.dir === "") throw refused("openRepo needs a dir");
  checkRemote(options.remote);
  const remote = options.remote;
  const limits = checkLimits(options.limits);
  const dir = path.resolve(options.dir);
  const binary = options.git ?? "git";
  const home = path.join(dir, SCRATCH, "home");
  const tmp = path.join(dir, SCRATCH, "tmp");

  const state = await dirState(dir);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const runner = { binary, home, tmp, ...(options.identity ? { identity: options.identity } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  const bootstrap = createGitRunner(runner);
  const [major, minor] = await gitVersion(bootstrap);
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new GitRemoteError("git", `git ${major}.${minor} is too old: this package needs ${MIN_GIT.join(".")} or later`);
  }
  if (state === "new") await bootstrap(["init", "-q", "--bare", "--template=", "-b", MAIN, dir]);
  const git = createGitRunner({ ...runner, gitDir: dir });
  const text = async (args: string[], call?: GitCall) => (await git(args, call)).stdout.toString("utf8").trim();
  if (state === "repo" && (await text(["rev-parse", "--is-bare-repository"])) !== "true") throw refused(`${dir} is not a bare repository`);

  async function credentialFor(): Promise<GitCredential | undefined> {
    if (!remote.credential) return undefined;
    try {
      return (await remote.credential()) ?? undefined;
    } catch (error) {
      throw new GitRemoteError("git", "the remote's credential callback failed", [], { cause: error });
    }
  }

  // A local remote's receive-pack and upload-pack run in that repository with its own config: our -c flags do not
  // reach them, so hooks are turned off on their command line too.
  const packCommand = (kind: "upload" | "receive") => `${shellQuote(binary)} -c core.hooksPath=/dev/null -c core.fsmonitor=false ${kind}-pack`;
  const packArgs = (kind: "upload" | "receive"): string[] => (remote.kind === "local" ? [`--${kind}-pack=${packCommand(kind)}`] : []);

  async function fetchFrom(url: string, namespace: string): Promise<void> {
    const credential = await credentialFor();
    await git(["fetch", "-q", "--prune", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", ...packArgs("upload"), url,
      `+refs/heads/*:refs/remotes/${namespace}/*`], credential ? { credential } : {});
  }

  // The push side's refs count only while this remote has a push URL of its own; a directory opened before with one
  // keeps refs that no fetch updates any more.
  const separatePush = remote.pushUrl !== undefined && remote.pushUrl !== remote.url;
  const remoteRefs = (branch: string) => [`refs/remotes/origin/${branch}`, ...(separatePush ? [`refs/remotes/pushed/${branch}`] : [])];

  async function fetchAll(): Promise<void> {
    await fetchFrom(remote.url, "origin");
    if (separatePush) await fetchFrom(remote.pushUrl!, "pushed");
  }

  async function revParse(rev: string): Promise<string | undefined> {
    const result = await git(["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`], { allowFail: true });
    return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  async function isAncestor(a: string, b: string): Promise<boolean> {
    return (await git(["merge-base", "--is-ancestor", a, b], { allowFail: true })).code === 0;
  }

  /** The remote's tip of `branch`, from the fetch URL and the push URL: the newer of the two, or the push side's when
   *  they diverged, since the next push goes there. */
  async function remoteTipOf(branch: string): Promise<string | undefined> {
    const fetched = await revParse(`refs/remotes/origin/${branch}`);
    const pushed = separatePush ? await revParse(`refs/remotes/pushed/${branch}`) : undefined;
    if (!fetched || !pushed || fetched === pushed) return pushed ?? fetched;
    return (await isAncestor(pushed, fetched)) ? fetched : pushed;
  }

  async function tipOf(branch: string): Promise<string | undefined> {
    const localTip = await revParse(`refs/heads/${branch}`);
    const remoteTip = await remoteTipOf(branch);
    if (!localTip) return remoteTip;
    if (!remoteTip || localTip === remoteTip) return localTip;
    return (await isAncestor(remoteTip, localTip)) ? localTip : remoteTip;
  }

  async function resolveCommit(ref: string): Promise<string | undefined> {
    if (typeof ref === "string" && SHA.test(ref)) return revParse(ref);
    return tipOf(checkBranch(ref));
  }

  async function commitOf(ref: string): Promise<string> {
    const sha = await resolveCommit(ref);
    if (!sha) throw new GitRemoteError("missing", `no commit for ${JSON.stringify(ref)}`);
    return sha;
  }

  const treeOf = (commit: string) => text(["rev-parse", `${commit}^{tree}`]);

  async function lsTree(treeish: string, prefix?: string): Promise<TreeEntry[]> {
    const args = ["ls-tree", "-r", "-z", "-l", "--full-tree", treeish];
    if (prefix) args.push("--", prefix);
    return (await git(args)).stdout.toString("utf8").split("\0").filter(Boolean).map(parseEntry);
  }

  async function readBlobs(oids: readonly string[]): Promise<Buffer[]> {
    if (!oids.length) return [];
    const out = (await git(["cat-file", "--batch"], { input: `${oids.join("\n")}\n` })).stdout;
    const blobs: Buffer[] = [];
    let at = 0;
    for (const oid of oids) {
      const newline = out.indexOf(10, at);
      const [, type, size] = out.subarray(at, newline).toString("utf8").split(" ");
      if (type !== "blob") throw new GitRemoteError("missing", `object ${oid} is not a blob here`);
      blobs.push(out.subarray(newline + 1, newline + 1 + Number(size)));
      at = newline + 1 + Number(size) + 1;
    }
    return blobs;
  }

  async function logOf(revs: readonly string[], options: LogOptions = {}): Promise<LogEntry[]> {
    // NUL separates fields and, with -z, commits: no commit message can hold one.
    const args = ["log", "-z", "--format=%H%x00%P%x00%s%x00%(trailers:only,unfold)"];
    const trailer = options.trailer;
    if (trailer?.value !== undefined) args.push("--fixed-strings", "--regexp-ignore-case", `--grep=${trailer.key}: ${trailer.value}`);
    else if (options.max && !trailer) args.push(`--max-count=${options.max}`);
    args.push(...revs);
    if (options.path) args.push("--", options.path);
    const fields = (await git(args)).stdout.toString("utf8").split("\0");
    let entries: LogEntry[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) entries.push(parseLog(fields[i]!.trim(), fields[i + 1]!, fields[i + 2]!, fields[i + 3]!));
    if (trailer) {
      const key = trailer.key.toLowerCase();
      entries = entries.filter((entry) => Object.entries(entry.trailers).some(([k, values]) =>
        k.toLowerCase() === key && (trailer.value === undefined || values.includes(trailer.value))));
    }
    return options.max ? entries.slice(0, options.max) : entries;
  }

  /** The newest commit on `branch`, local or on the remote, that carries `key: value`. */
  async function findTrailer(branch: string, key: string, value: string): Promise<string | undefined> {
    const refs: string[] = [];
    for (const ref of [`refs/heads/${branch}`, ...remoteRefs(branch)]) {
      if (await revParse(ref)) refs.push(ref);
    }
    if (!refs.length) return undefined;
    return (await logOf(refs, { trailer: { key, value }, max: 1 }))[0]?.sha;
  }

  /** Refuses a change from `fromTree` to `toTree` that adds or changes an entry this package would not write: a refused
   *  path, a symlink, a submodule, a file over the size cap, or a path that collides by case with another. */
  async function checkIntroduced(fromTree: string, toTree: string): Promise<void> {
    if (fromTree === toTree) return;
    const parts = (await git(["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", fromTree, toTree])).stdout.toString("utf8").split("\0");
    const touched: string[] = [];
    const blobs: { file: string; oid: string }[] = [];
    const bad: string[] = [];
    for (let i = 0; i + 1 < parts.length && parts[i]!.startsWith(":"); i += 2) {
      const [, mode, , oid, status] = parts[i]!.slice(1).split(" ");
      const file = parts[i + 1]!;
      if (status === "D") continue;
      touched.push(file);
      const reason = pathRefusal(file) ?? modeRefusal(mode!);
      if (reason) bad.push(`${JSON.stringify(file)} (${reason})`);
      else blobs.push({ file, oid: oid! });
    }
    if (blobs.length) {
      const sizes = (await text(["cat-file", "--batch-check=%(objectsize)"], { input: `${blobs.map((b) => b.oid).join("\n")}\n` })).split("\n");
      for (const [i, blob] of blobs.entries()) {
        if (Number(sizes[i]) > limits.maxFileBytes) bad.push(`${JSON.stringify(blob.file)} (${sizes[i]} bytes, over the ${limits.maxFileBytes} byte cap)`);
      }
    }
    if (bad.length) throw refused(`the result would hold entries this package refuses: ${bad.join(", ")}`, touched);
    if (!touched.length) return;
    const all = (await git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", toTree])).stdout.toString("utf8").split("\0").filter(Boolean);
    const groups = caseCollisions(all, touched);
    if (groups.length) throw refused(`paths that differ only in case: ${groups.map((g) => g.join(" vs ")).join(", ")}`, groups.flat());
  }

  async function buildTree(baseTree: string | undefined, files: Readonly<Record<string, FileContent>>): Promise<string> {
    const work = await mkdtemp(path.join(tmp, "commit-"));
    const indexFile = path.join(work, "index");
    try {
      if (baseTree) {
        const loaded = await git(["read-tree", baseTree], { indexFile, allowFail: true });
        if (loaded.code !== 0) {
          throw new GitRemoteError(/invalid path/i.test(loaded.stderr) ? "refused" : "git", `the base tree cannot be built on: ${loaded.stderr.trim()}`);
        }
      }
      const writes = Object.entries(files).filter((entry): entry is [string, string | Uint8Array] => entry[1] !== null);
      if (baseTree && writes.length) {
        // update-index --index-info silently drops a base file to make room for a directory, and the reverse.
        const kept = new Set((await git(["ls-files", "-z"], { indexFile })).stdout.toString("utf8").split("\0").filter(Boolean));
        for (const [file, content] of Object.entries(files)) if (content === null) kept.delete(file);
        const dirs = new Set([...kept].flatMap((p) => pathPrefixes(p).slice(0, -1)));
        for (const [file] of writes) {
          const clash = pathPrefixes(file).slice(0, -1).find((p) => kept.has(p)) ?? (dirs.has(file) ? file : undefined);
          if (clash) throw refused(`${JSON.stringify(clash)} cannot be both a file and a directory`, [clash, file]);
        }
      }
      const blobFiles: string[] = [];
      for (const [i, [, content]] of writes.entries()) {
        const file = path.join(work, `blob-${i}`);
        await writeFile(file, content, { mode: 0o600 });
        blobFiles.push(file);
      }
      const oids = blobFiles.length
        ? (await text(["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: `${blobFiles.join("\n")}\n` })).split("\n")
        : [];
      const records = [
        ...writes.map(([file], i) => `100644 ${oids[i]}\t${file}`),
        ...Object.entries(files).filter(([, content]) => content === null).map(([file]) => `0 ${ZERO}\t${file}`),
      ];
      if (records.length) {
        const updated = await git(["update-index", "-z", "--index-info"], { indexFile, input: `${records.join("\0")}\0`, allowFail: true });
        if (updated.code !== 0) throw refused(`the files cannot be placed on the base tree: ${updated.stderr.trim()}`, Object.keys(files));
      }
      return await text(["write-tree"], { indexFile });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function commitTree(tree: string, parents: readonly string[], message: string): Promise<string> {
    return text(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message });
  }

  /** Moves the local branch only if it is still where it was before the write was built. */
  async function moveBranch(branch: string, sha: string, expected: string | undefined): Promise<void> {
    const moved = await git(["update-ref", "-m", "pi-git-remote", `refs/heads/${branch}`, sha, expected ?? ZERO], { allowFail: true });
    if (moved.code !== 0) throw new GitRemoteError("conflict", `${branch} moved while it was being written: ${moved.stderr.trim()}`);
  }

  async function checkout(ref: string, options: { readonly into: string }): Promise<CheckoutResult> {
    if (!options || typeof options.into !== "string" || options.into === "") throw refused("checkout needs { into }");
    await fetchAll();
    const sha = await commitOf(ref);
    const into = path.resolve(options.into);
    await mkdir(into, { recursive: true, mode: 0o755 });
    const realInto = await realpath(into);
    if (within(realInto, await realpath(dir))) throw refused("checkout refuses a directory inside the host repository");
    if ((await readdir(realInto)).length > 0) throw refused("checkout needs an empty directory");
    const entries = await lsTree(sha);
    if (entries.length > limits.maxTreeEntries) throw refused(`the tree has ${entries.length} files, over the ${limits.maxTreeEntries} file cap`);
    const skipped: Skipped[] = [];
    const candidates: TreeEntry[] = [];
    for (const entry of entries) {
      const reason = pathRefusal(entry.path)
        ?? (entry.type === "blob" ? modeRefusal(entry.mode) : entry.type === "commit" ? "a submodule" : `a ${entry.type}`)
        ?? ((entry.size ?? 0) > limits.maxFileBytes ? `over the ${limits.maxFileBytes} byte cap` : undefined);
      if (reason) skipped.push({ path: entry.path, reason });
      else candidates.push(entry);
    }
    // Neither spelling of a case collision is copied: which one a case-insensitive file system keeps is not ours to pick.
    const colliding = new Map<string, readonly string[]>();
    for (const group of caseCollisions(candidates.map((entry) => entry.path))) for (const spelling of group) colliding.set(spelling, group);
    const accepted: TreeEntry[] = [];
    for (const entry of candidates) {
      const hit = pathPrefixes(entry.path).find((p) => colliding.has(p));
      if (hit) skipped.push({ path: entry.path, reason: `a case collision: ${colliding.get(hit)!.join(" vs ")}` });
      else accepted.push(entry);
    }
    const files: string[] = [];
    for (let start = 0; start < accepted.length;) {
      let end = start;
      let bytes = 0;
      while (end < accepted.length && end - start < CHECKOUT_BATCH_FILES && (end === start || bytes + (accepted[end]!.size ?? 0) <= CHECKOUT_BATCH_BYTES)) {
        bytes += accepted[end]!.size ?? 0;
        end += 1;
      }
      const batch = accepted.slice(start, end);
      const blobs = await readBlobs(batch.map((entry) => entry.oid));
      for (const [i, entry] of batch.entries()) {
        const target = path.join(realInto, ...entry.path.split("/"));
        try {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
          await writeFile(target, blobs[i]!, { flag: "wx", mode: 0o644 });
          files.push(entry.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
          skipped.push({ path: entry.path, reason: "a file and a directory at one path" });
        }
      }
      start = end;
    }
    return { sha, files, skipped };
  }

  async function read(file: string, sha: string): Promise<string | undefined> {
    const reason = pathRefusal(file);
    if (reason) throw refused(`the path ${JSON.stringify(file)} is refused: ${reason}`, [file]);
    if (!SHA.test(sha)) await fetchAll();
    const commit = await commitOf(sha);
    const entry = (await git(["ls-tree", "-z", "--full-tree", "-l", commit, "--", file])).stdout.toString("utf8").split("\0").filter(Boolean).map(parseEntry).find((e) => e.path === file);
    if (!entry || entry.type === "tree") return undefined;
    const refusal = entry.type === "blob" ? modeRefusal(entry.mode) : "a submodule";
    if (refusal) throw refused(`${JSON.stringify(file)} is ${refusal}`, [file]);
    return (await git(["cat-file", "blob", entry.oid])).stdout.toString("utf8");
  }

  async function list(prefix: string, sha: string): Promise<TreeEntry[]> {
    const trimmed = typeof prefix === "string" ? prefix.replace(/\/+$/, "") : prefix;
    if (trimmed !== "") {
      const reason = pathRefusal(trimmed);
      if (reason) throw refused(`the prefix ${JSON.stringify(prefix)} is refused: ${reason}`, [prefix]);
    }
    if (!SHA.test(sha)) await fetchAll();
    return lsTree(await commitOf(sha), trimmed || undefined);
  }

  async function branches(prefix: string): Promise<Branch[]> {
    if (typeof prefix !== "string" || (prefix !== "" && !prefix.endsWith("/"))) throw refused("a branch prefix is empty or ends with a slash");
    if (prefix !== "") checkBranch(prefix.slice(0, -1));
    await fetchAll();
    const names = new Set<string>();
    for (const namespace of ["refs/heads/", ...remoteRefs("")]) {
      for (const ref of (await text(["for-each-ref", "--format=%(refname)", `${namespace}${prefix}`])).split("\n").filter(Boolean)) {
        const name = ref.slice(namespace.length);
        try {
          names.add(checkBranch(name));
        } catch {
          continue;
        }
      }
    }
    const out: Branch[] = [];
    for (const name of [...names].sort()) {
      const sha = await tipOf(name);
      if (sha) out.push({ name, sha });
    }
    return out;
  }

  async function commitTo(branchName: string, options: CommitOptions): Promise<Committed> {
    const branch = checkBranch(branchName);
    if (!options || typeof options !== "object") throw refused("commitTo needs { files, message }");
    checkCommitFiles(options.files, limits);
    const message = formatMessage(options.message, options.trailers);
    await fetchAll();
    const runId = firstValue(options.trailers?.[RUN_ID_TRAILER]);
    if (runId !== undefined) {
      const existing = await findTrailer(branch, RUN_ID_TRAILER, runId);
      if (existing) return { sha: existing, created: false };
    }
    const localBefore = await revParse(`refs/heads/${branch}`);
    const tip = await tipOf(branch);
    let base = tip;
    if (options.parent !== undefined) {
      const parent = await commitOf(options.parent);
      if (tip && tip !== parent) throw new GitRemoteError("conflict", `${branch} is at ${tip}, not at the parent ${parent}`);
      base = parent;
    } else if (!base && branch !== MAIN) {
      base = await tipOf(MAIN);
    }
    const baseTree = base ? await treeOf(base) : EMPTY_TREE;
    const tree = await buildTree(base ? baseTree : undefined, options.files);
    await checkIntroduced(baseTree, tree);
    if (base && tree === baseTree && options.allowEmpty !== true) return { sha: base, created: false };
    const sha = await commitTree(tree, base ? [base] : [], message);
    await moveBranch(branch, sha, localBefore);
    return { sha, created: true };
  }

  async function push(sha: string, branchName: string): Promise<void> {
    const branch = checkBranch(branchName);
    if (typeof sha !== "string" || !SHA.test(sha)) throw refused("push takes a full commit sha");
    if (!(await revParse(sha))) throw new GitRemoteError("missing", `no commit ${sha} here`);
    const credential = await credentialFor();
    const result = await git(["push", "--porcelain", "--no-verify", ...packArgs("receive"), remote.pushUrl ?? remote.url, `${sha}:refs/heads/${branch}`],
      { allowFail: true, ...(credential ? { credential } : {}) });
    if (result.code !== 0) {
      const line = result.stdout.toString("utf8").split("\n").find((l) => l.startsWith("!\t")) ?? "";
      if (line.includes("[rejected]")) throw new GitRemoteError("conflict", `the remote's ${branch} moved: ${sha} is not a fast-forward of it`);
      if (line.includes("[remote rejected]")) throw new GitRemoteError("refused", `the remote refused ${branch}: ${line.split("\t").at(-1)}`);
      throw new GitRemoteError("git", `git push failed (${result.code}): ${result.stderr.trim()}`);
    }
    await fetchAll();
  }

  async function merge(fromName: string, intoName: string): Promise<MergeResult> {
    const from = checkBranch(fromName);
    const into = checkBranch(intoName);
    await fetchAll();
    const source = await tipOf(from);
    if (!source) throw new GitRemoteError("missing", `no branch ${from}`);
    const localBefore = await revParse(`refs/heads/${into}`);
    const target = await tipOf(into);
    const targetTree = target ? await treeOf(target) : EMPTY_TREE;
    if (target && (await isAncestor(source, target))) return { sha: target, changed: false, fastForward: false };
    if (!target || (await isAncestor(target, source))) {
      await checkIntroduced(targetTree, await treeOf(source));
      await moveBranch(into, source, localBefore);
      return { sha: source, changed: true, fastForward: true };
    }
    const result = await git(["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", target, source], { allowFail: true });
    const parts = result.stdout.toString("utf8").split("\0").filter(Boolean);
    if (result.code === 1) throw new GitRemoteError("conflict", `merging ${from} into ${into} conflicts`, [...new Set(parts.slice(1))]);
    if (result.code !== 0) throw new GitRemoteError("git", `git merge-tree failed (${result.code}): ${result.stderr.trim()}`);
    await checkIntroduced(targetTree, parts[0]!);
    const sha = await commitTree(parts[0]!, [target, source], formatMessage(`Merge ${from} into ${into}`, { "Merged-Branch": from }));
    await moveBranch(into, sha, localBefore);
    return { sha, changed: true, fastForward: false };
  }

  async function revert(shaArg: string, onName: string, options: { readonly trailers?: Trailers } = {}): Promise<RevertResult> {
    const on = checkBranch(onName);
    if (typeof shaArg !== "string" || !SHA.test(shaArg)) throw refused("revert takes a full commit sha");
    await fetchAll();
    const commit = await revParse(shaArg);
    if (!commit) throw new GitRemoteError("missing", `no commit ${shaArg} here`);
    const localBefore = await revParse(`refs/heads/${on}`);
    const target = await tipOf(on);
    if (!target) throw new GitRemoteError("missing", `no branch ${on}`);
    if (!(await isAncestor(commit, target))) throw refused(`${commit} is not on ${on}`);
    const [entry] = await logOf([commit], { max: 1 });
    const parent = entry!.parents[0];
    if (!parent) throw refused("a root commit cannot be reverted");
    const result = await git(["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", `--merge-base=${commit}`, target, parent], { allowFail: true });
    const parts = result.stdout.toString("utf8").split("\0").filter(Boolean);
    if (result.code === 1) throw new GitRemoteError("conflict", `reverting ${commit} on ${on} conflicts`, [...new Set(parts.slice(1))]);
    if (result.code !== 0) throw new GitRemoteError("git", `git merge-tree failed (${result.code}): ${result.stderr.trim()}`);
    const targetTree = await treeOf(target);
    if (parts[0] === targetTree) return { sha: target, changed: false };
    await checkIntroduced(targetTree, parts[0]!);
    const message = formatMessage(`Revert "${entry!.subject}"\n\nThis reverts commit ${commit}.`, { ...options.trailers, Reverts: commit });
    const sha = await commitTree(parts[0]!, [target], message);
    await moveBranch(on, sha, localBefore);
    return { sha, changed: true };
  }

  async function log(options: LogOptions = {}): Promise<LogEntry[]> {
    if (options.path !== undefined) {
      const reason = pathRefusal(options.path);
      if (reason) throw refused(`the path ${JSON.stringify(options.path)} is refused: ${reason}`, [options.path]);
    }
    if (options.trailer !== undefined && (typeof options.trailer.key !== "string" || !TRAILER_KEY.test(options.trailer.key))) throw refused("log's trailer needs a valid key");
    await fetchAll();
    const tip = await resolveCommit(options.ref ?? MAIN);
    return tip ? logOf([tip], options) : [];
  }

  let queue: Promise<unknown> = Promise.resolve();
  function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args) => {
      const next = queue.then(() => fn(...args));
      queue = next.catch(() => undefined);
      return next;
    };
  }

  if (!separatePush) {
    const stale = (await text(["for-each-ref", "--format=%(refname)", "refs/remotes/pushed/"])).split("\n").filter(Boolean);
    if (stale.length) await git(["update-ref", "--stdin"], { input: stale.map((ref) => `delete ${ref}\n`).join("") });
  }
  await fetchAll();
  return Object.freeze({
    dir,
    remote,
    limits,
    fetch: serial(fetchAll),
    resolve: serial(async (ref: string) => {
      await fetchAll();
      return resolveCommit(ref);
    }),
    branches: serial(branches),
    checkout: serial(checkout),
    read: serial(read),
    list: serial(list),
    commitTo: serial(commitTo),
    push: serial(push),
    merge: serial(merge),
    revert: serial(revert),
    log: serial(log),
  });
}
