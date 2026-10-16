import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitRemoteError } from "./errors.js";
import { type Allowlist, compileAllowlist } from "./glob.js";
import { modeRefusal, pathRefusal } from "./limits.js";
import type { Repo } from "./repo.js";

/** The trailer that names the session a commit came from. */
export const SESSION_ID_TRAILER = "Session-Id";
/** Where the branch pattern puts the session id. */
export const SESSION_PLACEHOLDER = "{sessionId}";
export const DEFAULT_BRANCH = `sessions/${SESSION_PLACEHOLDER}`;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROTECTED = new Set(["main", "master", "HEAD"]);
const RECORD_VERSION = 1;

export type SeedRecord = { readonly v: 1; readonly sessionId: string; readonly ref: string; readonly sha: string; readonly files: readonly string[] };

export type SessionCheckoutOptions = {
  readonly repo: Repo;
  readonly sessionId: string;
  /** The branch or commit the checkout is seeded from. */
  readonly ref: string;
  /** Where the files go: absolute, outside the session's working directory and the host repository. */
  readonly checkoutDir: string;
  /** Where the seed record is kept (absolute, outside the checkout). */
  readonly seedFile: string;
  /** Globs over repository paths that may be committed. */
  readonly allow: readonly string[];
  /** The branch pattern, with `{sessionId}` in it. */
  readonly branch?: string;
};

export type Seeded = {
  readonly sha: string;
  readonly files: readonly string[];
  /** Paths the checkout left out (symlinks, submodules, case collisions, files over the cap), with why. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** True when the directory from an earlier start of this session was kept. */
  readonly resumed: boolean;
};

export type EndOutcome = {
  readonly sessionId: string;
  readonly branch: string;
  /** The commit on the session branch that holds this session's changes; undefined when there was nothing to commit. */
  readonly sha?: string;
  /** True when this end made the commit; false when it found the changes already committed or none to commit. */
  readonly created: boolean;
  /** The allowlisted paths this session changed: written or deleted. */
  readonly changed: readonly string[];
};

export type SessionCheckout = {
  readonly dir: string;
  readonly branch: string;
  /** Checks the ref out into the directory, or keeps the directory this session already has. */
  seed(): Promise<Seeded>;
  /** The seeded commit's text of a repository file, as the model is shown it; undefined when absent. */
  seeded(file: string): Promise<string | undefined>;
  /** Commits the allowlisted changes to the session branch and pushes it by sha. Never touches any other branch. */
  end(): Promise<EndOutcome>;
};

const refused = (message: string, paths: readonly string[] = []) => new GitRemoteError("refused", message, paths);

/** The branch for a session: the pattern with the id in it, never a protected name and never the seed's own branch. */
export function sessionBranch(pattern: string, sessionId: string, ref: string): string {
  if (typeof pattern !== "string" || pattern.split(SESSION_PLACEHOLDER).length !== 2) {
    throw refused(`the branch pattern must contain ${SESSION_PLACEHOLDER} exactly once, so no two sessions share a branch`);
  }
  if (!SESSION_ID.test(sessionId)) throw refused("the session id is not usable in a branch name");
  const branch = pattern.replace(SESSION_PLACEHOLDER, sessionId);
  const bare = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  const seedBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  if (PROTECTED.has(bare) || bare === seedBranch) throw refused(`the branch ${JSON.stringify(branch)} is the branch the session was seeded from or a protected one`);
  return bare;
}

function blobId(content: Uint8Array, length: number): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`);
  return createHash(length === 64 ? "sha256" : "sha1").update(header).update(content).digest("hex");
}

async function readRegular(file: string, cap: number): Promise<Buffer | { readonly reason: string }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { reason: "a symlink" };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { reason: "not a regular file" };
    if (stat.size > cap) return { reason: `${stat.size} bytes, over the ${cap} byte cap` };
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readRecord(file: string): Promise<SeedRecord | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    throw refused("the session's seed record is not JSON");
  }
  const r = record as Partial<SeedRecord> | null;
  if (!r || r.v !== RECORD_VERSION || typeof r.sessionId !== "string" || typeof r.ref !== "string" || typeof r.sha !== "string" || !Array.isArray(r.files) || !r.files.every((f) => typeof f === "string")) {
    throw refused("the session's seed record is not one this version wrote");
  }
  return r as SeedRecord;
}

async function writeRecord(file: string, record: SeedRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const isEmptyOrMissing = async (dir: string): Promise<boolean> => {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

/**
 * One session's checkout of a repository the host owns: seeded into a directory with no `.git` in it, read back at the
 * end, and committed to the session's own branch. The directory is never followed through a symlink, a path the
 * allowlist does not name is never read, and the commit is built by the package's plumbing (`commitTo`), so what the
 * agent left in the directory can change nothing but file contents on that one branch.
 */
export function createSessionCheckout(options: SessionCheckoutOptions): SessionCheckout {
  const { repo, sessionId, ref } = options;
  if (!SESSION_ID.test(sessionId)) throw refused("the session id is not usable in a path or a branch name");
  if (typeof ref !== "string" || ref === "") throw refused("a checkout needs a ref");
  for (const [name, value] of [["checkoutDir", options.checkoutDir], ["seedFile", options.seedFile]] as const) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw refused(`${name} must be an absolute path`);
  }
  const dir = path.resolve(options.checkoutDir);
  const branch = sessionBranch(options.branch ?? DEFAULT_BRANCH, sessionId, ref);
  const allow: Allowlist = compileAllowlist(options.allow);
  let record: SeedRecord | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };

  async function seed(): Promise<Seeded> {
    const kept = await readRecord(options.seedFile);
    if (kept && !(await isEmptyOrMissing(dir))) {
      if (kept.sessionId !== sessionId || kept.ref !== ref) throw refused("the checkout directory was seeded for another session or ref");
      record = kept;
      return { sha: kept.sha, files: kept.files, skipped: [], resumed: true };
    }
    const result = await repo.checkout(ref, { into: dir });
    record = { v: RECORD_VERSION, sessionId, ref, sha: result.sha, files: result.files };
    await writeRecord(options.seedFile, record);
    return { sha: result.sha, files: result.files, skipped: result.skipped, resumed: false };
  }

  /**
   * The allowlisted regular files that differ from the seeded commit, read without following a symlink, and the paths that
   * could be committed but cannot be. Only a changed file's bytes are kept, so memory follows the commit, not the tree.
   */
  async function collect(seededAt: SeedRecord): Promise<{ files: Record<string, Buffer | null>; bad: { path: string; reason: string }[] }> {
    const entries = new Map((await repo.list("", seededAt.sha)).map((e) => [e.path, e]));
    const files: Record<string, Buffer | null> = {};
    const seen = new Set<string>();
    const bad: { path: string; reason: string }[] = [];
    const reaches = (p: string) => allow.matches(p) || allow.mayContain(p);
    const { maxFileBytes, maxFiles, maxTreeEntries } = repo.limits;
    const visit = async (rel: string): Promise<void> => {
      const absolute = rel === "" ? dir : path.join(dir, ...rel.split("/"));
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const p = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          if (reaches(p)) bad.push({ path: p, reason: "a symlink" });
        } else if (entry.isDirectory()) {
          if (allow.mayContain(p)) await visit(p);
        } else if (allow.matches(p)) {
          const refusal = pathRefusal(p) ?? (entry.isFile() ? undefined : "not a regular file");
          if (refusal) {
            bad.push({ path: p, reason: refusal });
            continue;
          }
          if (seen.size >= maxTreeEntries) throw refused(`the checkout holds more than ${maxTreeEntries} allowlisted files`);
          const content = await readRegular(path.join(absolute, entry.name), maxFileBytes);
          if (!Buffer.isBuffer(content)) {
            bad.push({ path: p, reason: content.reason });
            continue;
          }
          seen.add(p);
          const was = entries.get(p);
          if (!was || was.type !== "blob" || modeRefusal(was.mode) !== undefined || blobId(content, was.oid.length) !== was.oid) {
            files[p] = content;
            if (Object.keys(files).length > maxFiles) throw refused(`a commit may write at most ${maxFiles} paths: the checkout changes more`);
          }
        }
      }
    };
    await visit("");
    // A path the allowlist names that was seeded and is gone is a deletion; a seeded path the checkout skipped was never there.
    for (const p of seededAt.files) if (allow.matches(p) && !seen.has(p)) files[p] = null;
    return { files, bad };
  }

  async function end(): Promise<EndOutcome> {
    if (!record) throw refused("this session has no seeded checkout to commit");
    const seededAt = record;
    const { files, bad } = await collect(seededAt);
    if (bad.length) {
      throw refused(`the checkout holds files that may not be committed: ${bad.slice(0, 20).map((b) => `${JSON.stringify(b.path)} (${b.reason})`).join(", ")}${bad.length > 20 ? ` and ${bad.length - 20} more` : ""}`, bad.map((b) => b.path));
    }
    const changed = Object.keys(files).sort();

    const tip = await repo.resolve(branch);
    if (tip) {
      const mine = await repo.log({ ref: branch, trailer: { key: SESSION_ID_TRAILER, value: sessionId }, max: 1 });
      if (mine.length === 0) throw refused(`the branch ${branch} exists and is not this session's`);
    } else if (changed.length === 0) {
      return { sessionId, branch, created: false, changed };
    }
    const made = await repo.commitTo(branch, {
      files,
      message: `Session ${sessionId}: ${changed.length} file${changed.length === 1 ? "" : "s"} changed`,
      trailers: { [SESSION_ID_TRAILER]: sessionId, "Seeded-From": `${ref}@${seededAt.sha}` },
      parent: tip ?? seededAt.sha,
    });
    // An end that found everything committed still pushes the commit: a push that failed the first time is retried, and a
    // push that already happened changes nothing.
    await repo.push(made.sha, branch);
    return { sessionId, branch, sha: made.sha, created: made.created, changed };
  }

  return Object.freeze({
    dir,
    branch,
    seed: () => serial(seed),
    seeded: (file: string) => repo.read(file, record?.sha ?? ref),
    end: () => serial(end),
  });
}

/** A directory only this user can read and write, made when absent. A symlink, another owner or a wider mode is refused. */
export async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw refused(`${dir} belongs to another user`);
  if ((stat.mode & 0o077) !== 0) throw refused(`${dir} is readable or writable by others`);
}
