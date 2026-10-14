// Fork: copy a released, sealed run into a new run directory. S3 CopyObject is not supported, so both runs
// are mounted exclusively for the copy, which also keeps either from starting meanwhile; the mounts go under a mount
// root of their own, never where an instance mounts. The source is only read (its claim probe aside, which every mount
// writes). The new run's run.json starts at generation 0 and carries the source's seal: its first open is generation 1
// and refuses a copy that lost a committed sequence (STORE_BEHIND_SEAL). Supervisor side: it needs the API key.
import { chmod, copyFile, lchown, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, symlink, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { acquire, createRunDir, type AcquireOptions, findDelegations, mintMountToken, removeMountToken, runPath, type ArchilHost, type Claim, type RunRef } from "./claim.ts";
import { HeldError, PdaError } from "./errors.ts";
import { persistRecord, readRunRecord, RUN_JSON, RUN_JSON_TEMP, type RunRecord } from "./status.ts";
import { CONTROL_TIMEOUT_MS, readRunStatus, START_MARK, withTimeouts, type CheckControl, type CheckOptions, type SupervisorControl } from "./supervise.ts";
import { OWNER_LOCK } from "./run.ts";

/** A run is released, and so can be forked, in these states once its release sealed it. */
const RELEASED: readonly RunRecord["status"][] = ["paused", "sleeping", "done", "failed"];
/**
 * Not copied: the run's own lifecycle files (the fork writes its own run.json), the supervisor's start mark (copied, it
 * would hold the new run in a start grace for a start that never happened), and the scratch directory.
 */
const SKIP = new Set([RUN_JSON, RUN_JSON_TEMP, OWNER_LOCK, `${OWNER_LOCK}-journal`, ".claim", START_MARK, "tmp", "commands"]);

export type ForkErrorCode = "INVALID_ARGUMENT" | "SOURCE_NOT_RELEASED" | "SOURCE_HELD" | "TARGET_EXISTS" | "COPY_FAILED";

export class ForkError extends PdaError {
  constructor(code: ForkErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

export interface ForkOptions {
  readonly control: CheckControl & Pick<SupervisorControl, "getObject" | "headObject">;
  /** The copy's two mounts go under `<mountRoot>/.fork-<stamp>/{source,target}`. */
  readonly mountRoot: string;
  readonly host?: ArchilHost;
  /** Prefix of the two short-lived token users' nicknames. Default "pda-". */
  readonly tokenPrefix?: string;
  readonly controlTimeoutMs?: number;
  readonly onResource?: CheckOptions["onResource"];
  /** Replaceable for tests: how each side is mounted (default `acquire`). */
  readonly acquire?: (options: AcquireOptions) => Promise<Claim>;
}

export type ForkResult = {
  readonly run: string;
  readonly from: string;
  readonly sealedSeq: number;
  readonly sourceGeneration: number;
  readonly files: number;
  readonly bytes: number;
  /** Owners are preserved only when the caller is root; otherwise every copied entry belongs to the caller. */
  readonly owners: "preserved" | "caller";
  readonly ms: number;
};

/** Copy `from` into `to` entry by entry: modes, times and symlinks kept, owners when root. */
async function copyTree(from: string, to: string, top: boolean, asRoot: boolean, count: { files: number; bytes: number }): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (top && SKIP.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    const st = await lstat(src);
    if (st.isDirectory()) {
      await mkdir(dst, { mode: st.mode & 0o7777 });
      await copyTree(src, dst, false, asRoot, count);
    } else if (st.isSymbolicLink()) {
      await symlink(await readlink(src), dst);
    } else if (st.isFile()) {
      await copyFile(src, dst);
      count.files++;
      count.bytes += st.size;
    } else {
      continue;
    }
    if (asRoot) await lchown(dst, st.uid, st.gid);
    if (st.isSymbolicLink()) continue;
    await chmod(dst, st.mode & 0o7777);
    await utimes(dst, st.atime, st.mtime);
  }
}

/** Remove every entry under `root`, keeping `root`. */
async function emptyDir(root: string): Promise<void> {
  for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true });
}

/**
 * Fork run `ref` into run `newId`. The source must be released and sealed (run.json paused, sleeping, done
 * or failed with a `sealedSeq`, and no delegation); `newId` must not exist. A fork owns the new run's directory only
 * while it holds that directory's exclusive mount. A fork that fails after that empties the directory through its own
 * mount and then removes the empty directory, so a half copy never looks like a run. One that never held it (another
 * fork or a start mounted it first) touches nothing there; it may leave the empty directory it created. Every token
 * and mount of its own is removed either way.
 */
export async function fork(ref: RunRef, newId: string, options: ForkOptions): Promise<ForkResult> {
  const t0 = performance.now();
  const control = withTimeouts(options.control, options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
  runPath(newId);
  if (newId === ref.id) throw new ForkError("INVALID_ARGUMENT", "a fork needs a new run id");
  const before = await readRunStatus(control, ref.id);
  const released = (r: RunRecord | null | undefined): r is RunRecord & { sealedSeq: number } => !!r && RELEASED.includes(r.status) && r.sealedSeq !== null;
  if (!released(before)) throw new ForkError("SOURCE_NOT_RELEASED", `run ${ref.id} is not released and sealed (${before ? `${before.status}, sealedSeq ${before.sealedSeq}` : "no run.json"})`);
  if ((await findDelegations(control, ref.id)).length > 0) throw new ForkError("SOURCE_HELD", `run ${ref.id} is mounted somewhere`);
  const target = `${runPath(newId)}/`;
  if ((await control.headObject(target)) || (await control.listObjects(target, { recursive: true })).objects.length > 0) {
    throw new ForkError("TARGET_EXISTS", `${target} already exists`);
  }

  const note = options.onResource ?? (() => {});
  const base = join(options.mountRoot, `.fork-${Date.now().toString(36)}`);
  const tokens: string[] = [];
  const claims: Claim[] = [];
  // Set once this fork holds the new run's directory exclusively; until then the directory may be another operation's.
  let copy: Claim | undefined;
  let done = false;
  const mount = async (run: RunRef, side: "source" | "target"): Promise<Claim> => {
    const t = await mintMountToken(control, { nickname: `${options.tokenPrefix ?? "pda-"}fork-${side}-${run.id}`.slice(0, 200), ttl: "1h" });
    tokens.push(t.identifier);
    note("token", t.identifier, side);
    const claim = await (options.acquire ?? acquire)({ ref: run, token: t.token, mountRoot: join(base, side), host: options.host });
    claims.push(claim);
    note("mount", claim.root, `${run.disk}:/${runPath(run.id)}`);
    return claim;
  };
  try {
    const source = await mount(ref, "source").catch((error: unknown) => {
      throw error instanceof HeldError ? new ForkError("SOURCE_HELD", `run ${ref.id} was mounted while forking`, { cause: error }) : error;
    });
    // The mounted record is authoritative: the source cannot change while this claim holds it.
    const record = await readRunRecord(source.root);
    if (!released(record)) throw new ForkError("SOURCE_NOT_RELEASED", `run ${ref.id} changed before it was mounted (${record?.status})`);
    const owner = await lstat(source.root);
    await createRunDir(control, newId, { uid: owner.uid, gid: owner.gid, mode: owner.mode & 0o7777 });
    note("subdir", target);
    copy = await mount({ ...ref, id: newId }, "target").catch((error: unknown) => {
      throw error instanceof HeldError ? new ForkError("TARGET_EXISTS", `${target} was mounted by another fork or start`, { cause: error }) : error;
    });
    const count = { files: 0, bytes: 0 };
    const asRoot = process.getuid?.() === 0;
    try {
      await copyTree(source.root, copy.root, true, asRoot, count);
    } catch (error) {
      throw new ForkError("COPY_FAILED", `copying ${runPath(ref.id)} to ${target} failed: ${(error as Error).message}`, { cause: error });
    }
    const now = new Date().toISOString();
    const forked: RunRecord = {
      run: newId,
      status: "paused",
      generation: 0,
      sealedSeq: record.sealedSeq,
      wakeAt: null,
      holder: null,
      heartbeatAt: null,
      updatedAt: now,
      detail: { forkedFrom: { run: ref.id, generation: record.generation, sealedSeq: record.sealedSeq } },
    };
    await persistRecord(copy.root, `${JSON.stringify(forked, null, 2)}\n`);
    // Each release runs the barrier first: every copied byte is durable before the target's claim goes.
    while (claims.length > 0) {
      const c = claims.at(-1)!;
      const r = await c.release();
      claims.pop();
      note("unmount", c.root, r.via);
    }
    done = true;
    return {
      run: newId,
      from: ref.id,
      sealedSeq: record.sealedSeq,
      sourceGeneration: record.generation,
      ...count,
      owners: asRoot ? "preserved" : "caller",
      ms: Math.round(performance.now() - t0),
    };
  } catch (error) {
    // Undo through this fork's own mount while it still holds it; nothing is deleted over S3, where a revoke would
    // take another operation's claim on the same id.
    if (copy && !copy.fenced) await emptyDir(copy.root).catch(() => undefined);
    throw error;
  } finally {
    for (const c of claims.reverse()) {
      await c.release().then(
        (r) => note("unmount", c.root, r.via),
        () => note("unmount", c.root, "failed"),
      );
    }
    // The emptied directory's own marker. S3 refuses to delete a directory with entries and deletes nothing under a
    // delegation, so this never removes a run another fork or start has taken since this fork released it.
    if (copy && !done) {
      await control.deleteObjects([target], { quiet: true }).catch(() => undefined);
      if (!(await control.headObject(target).catch(() => true))) note("subdir-deleted", target);
    }
    for (const t of tokens) {
      await removeMountToken(control, t).then(() => note("token-removed", t), () => {});
    }
    for (const side of ["source", "target"]) {
      for (const dir of [join(base, side, "runs"), join(base, side)]) await rmdir(dir).catch(() => {});
    }
    await rmdir(base).catch(() => {});
  }
}

export interface ForkLocalResult {
  /** The new run's id, and the directory it lives in. */
  readonly run: string;
  readonly root: string;
  readonly from: string;
  readonly sealedSeq: number;
  readonly sourceGeneration: number;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Fork a run on a local directory (`localRun`) into one new run directory per entry of `into`: the same copy as `fork`, for
 * one machine and without a disk. `from` must hold a released, sealed run (run.json paused, sleeping, done or failed with a
 * `sealedSeq`); anything else is `SOURCE_NOT_RELEASED`, and no target may exist (`TARGET_EXISTS`). The source is only read.
 * Every copy is made beside its target under a temporary name and none is published until all are complete, so a failed
 * batch leaves nothing behind and never takes back a run another process opened; each opens as
 * generation 1 of a run of its own, refusing a copy that lost a committed sequence like any fork. Nothing guards a source
 * that another process is opening at the same moment: a local directory has no mount to take it exclusively.
 */
export async function forkLocal(from: string, into: readonly { readonly id: string; readonly root: string }[]): Promise<ForkLocalResult[]> {
  for (const t of into) runPath(t.id); // a run id the disk would refuse is refused here too
  const source = await realpath(resolve(from)).catch(() => resolve(from));
  const targets = await Promise.all(into.map(async (t) => ({ id: t.id, root: await resolvedPath(t.root) })));
  if (targets.length === 0) throw new ForkError("INVALID_ARGUMENT", "forkLocal needs at least one target");
  // Two targets the same, or one beneath another (`/runs/a` and `/runs/a/b`): staging the inner one would make the outer one's directory.
  if (targets.some((t, i) => targets.some((u, j) => i !== j && (t.root === u.root || t.root.startsWith(`${u.root}${sep}`))))) {
    throw new ForkError("INVALID_ARGUMENT", "two targets are the same directory, or one is inside another");
  }
  // A target inside the source (by a symlink too) would be copied into itself and would write into a source that is only read.
  if (targets.some((t) => t.root === source || t.root.startsWith(`${source}${sep}`))) throw new ForkError("INVALID_ARGUMENT", "a fork needs a directory of its own, outside the source");
  const record = await readRunRecord(source).catch((cause: unknown) => {
    throw new ForkError("SOURCE_NOT_RELEASED", `${source} holds no readable run.json`, { cause });
  });
  if (!record || !RELEASED.includes(record.status) || record.sealedSeq === null) {
    throw new ForkError("SOURCE_NOT_RELEASED", `the run in ${source} is not released and sealed (${record ? `${record.status}, sealedSeq ${record.sealedSeq}` : "no run.json"})`);
  }
  if (targets.some((t) => t.id === record.run)) throw new ForkError("INVALID_ARGUMENT", "a fork needs a new run id");
  for (const t of targets) {
    if (await lstat(t.root).then(() => true, () => false)) throw new ForkError("TARGET_EXISTS", `${t.root} already exists`);
  }
  const asRoot = process.getuid?.() === 0;
  const st = await lstat(source);
  // Every copy is made beside its target under a temporary name and none is published until all are complete: a failed
  // batch removes only temporary directories, never a run another process could already have opened.
  const staged: { id: string; root: string; temp: string; files: number; bytes: number }[] = [];
  const published: string[] = [];
  try {
    for (const t of targets) {
      const temp = `${t.root}.fork-${process.pid}-${Date.now().toString(36)}-${staged.length}`;
      const entry = { ...t, temp, files: 0, bytes: 0 };
      staged.push(entry);
      await mkdir(dirname(t.root), { recursive: true });
      await mkdir(temp);
      const count = { files: 0, bytes: 0 };
      await copyTree(source, temp, true, asRoot, count);
      Object.assign(entry, count);
      const forked: RunRecord = {
        run: t.id,
        status: "paused",
        generation: 0,
        sealedSeq: record.sealedSeq,
        wakeAt: null,
        holder: null,
        heartbeatAt: null,
        updatedAt: new Date().toISOString(),
        detail: { forkedFrom: { run: record.run, generation: record.generation, sealedSeq: record.sealedSeq } },
      };
      await persistRecord(temp, `${JSON.stringify(forked, null, 2)}\n`);
      // The run's directory is the source's: its owner and mode, so whoever owned the source can open the fork.
      if (asRoot) await lchown(temp, st.uid, st.gid);
      await chmod(temp, st.mode & 0o7777);
    }
    for (const entry of staged) {
      await rename(entry.temp, entry.root);
      published.push(entry.root);
    }
  } catch (error) {
    for (const entry of staged) await rm(entry.temp, { recursive: true, force: true }).catch(() => undefined);
    // Only a copy no one has opened is taken back: an owner lock means a process already runs it.
    for (const root of published) if (!(await lstat(join(root, OWNER_LOCK)).then(() => true, () => false))) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof ForkError ? error : new ForkError("COPY_FAILED", `forking ${source} failed: ${(error as Error).message}`, { cause: error });
  }
  return staged.map((t) => ({ run: t.id, root: t.root, from: record.run, sealedSeq: record.sealedSeq!, sourceGeneration: record.generation, files: t.files, bytes: t.bytes }));
}

/** `path` made absolute with every symlink of its existing part resolved, so two spellings of one place compare equal. */
async function resolvedPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  for (let at = absolute; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return absolute;
      missing.push(basename(at));
    }
  }
}
