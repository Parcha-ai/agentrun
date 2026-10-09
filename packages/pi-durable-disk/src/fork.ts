// Fork: copy a released, sealed run into a new run directory. S3 CopyObject is not supported, so both runs
// are mounted exclusively for the copy, which also keeps either from starting meanwhile; the mounts go under a mount
// root of their own, never where an instance mounts. The source is only read (its claim probe aside, which every mount
// writes). The new run's run.json starts at generation 0 and carries the source's seal: its first open is generation 1
// and refuses a copy that lost a committed sequence (STORE_BEHIND_SEAL). Supervisor side: it needs the API key.
import { chmod, copyFile, lchown, lstat, mkdir, readdir, readlink, rm, rmdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
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
const SKIP = new Set([RUN_JSON, RUN_JSON_TEMP, OWNER_LOCK, `${OWNER_LOCK}-journal`, ".claim", START_MARK, "tmp"]);

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

/** A released and sealed record: what a fork may copy. */
const isReleased = (r: RunRecord | null | undefined): r is RunRecord & { sealedSeq: number } => !!r && RELEASED.includes(r.status) && r.sealedSeq !== null;

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
  const many = await forkMany(ref, [newId], options);
  const outcome = many.outcomes[0]!;
  if (!outcome.ok) throw outcome.error;
  return { ...outcome.result, ms: Math.round(performance.now() - t0) };
}

export interface ForkManyOptions extends ForkOptions {
  /** How many new runs are copied at once, each under its own mount: a whole number of at least 1. Default: all of them. */
  readonly concurrency?: number;
}

/** One new run of a `forkMany`: its result, or why it was not made (a ForkError, or the error of the step that failed). */
export type ForkOutcome = { readonly run: string; readonly ok: true; readonly result: ForkResult } | { readonly run: string; readonly ok: false; readonly error: Error };

export type ForkManyResult = {
  readonly from: string;
  readonly sealedSeq: number;
  readonly sourceGeneration: number;
  /** In the order of `newIds`. */
  readonly outcomes: readonly ForkOutcome[];
  readonly ms: number;
};

/**
 * Fork run `ref` into every run of `newIds` with one mount of the source: the source is checked and mounted once (so it
 * cannot start meanwhile), and each new run is copied under its own exclusive mount, `concurrency` at a time. Each new
 * run follows `fork`'s rules on its own: it is opened by no one before its copy and its run.json are complete and
 * durable (its mount holds it until then, and its release runs the barrier first), a failure after its mount empties
 * and removes only its own directory, and one another fork or start mounted first is left alone. A new run that exists
 * already, whose check fails, or whose copy fails, is an outcome with `ok: false`; the others are made. A source that is
 * not released and sealed, is held, or is mounted while forking throws (no new run is made), as does an empty, repeated
 * or source id or a bad `concurrency`. The source is released before the result is returned, after every copy ended: a
 * release that fails is thrown (the release is tried once more first), since a source still mounted here cannot start;
 * the new runs made by then are complete.
 */
export async function forkMany(ref: RunRef, newIds: readonly string[], options: ForkManyOptions): Promise<ForkManyResult> {
  const t0 = performance.now();
  const control = withTimeouts(options.control, options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
  if (newIds.length === 0) throw new ForkError("INVALID_ARGUMENT", "a fork needs at least one new run id");
  for (const id of newIds) {
    runPath(id);
    if (id === ref.id) throw new ForkError("INVALID_ARGUMENT", "a fork needs a new run id");
  }
  if (new Set(newIds).size !== newIds.length) throw new ForkError("INVALID_ARGUMENT", "the new run ids repeat");
  // NaN would start no copier and leave every new run without an outcome.
  if (options.concurrency !== undefined && !(Number.isInteger(options.concurrency) && options.concurrency >= 1)) {
    throw new ForkError("INVALID_ARGUMENT", `concurrency is a whole number of at least 1, not ${options.concurrency}`);
  }
  const concurrency = options.concurrency ?? newIds.length;
  const before = await readRunStatus(control, ref.id);
  if (!isReleased(before)) throw new ForkError("SOURCE_NOT_RELEASED", `run ${ref.id} is not released and sealed (${before ? `${before.status}, sealedSeq ${before.sealedSeq}` : "no run.json"})`);
  if ((await findDelegations(control, ref.id)).length > 0) throw new ForkError("SOURCE_HELD", `run ${ref.id} is mounted somewhere`);

  const outcomes = new Map<string, ForkOutcome>();
  // Each new run is checked on its own: a check that fails (a timeout) is that run's outcome, and the others go on.
  await Promise.all(
    newIds.map(async (id) => {
      const target = `${runPath(id)}/`;
      try {
        if ((await control.headObject(target)) || (await control.listObjects(target, { recursive: true })).objects.length > 0) {
          outcomes.set(id, { run: id, ok: false, error: new ForkError("TARGET_EXISTS", `${target} already exists`) });
        }
      } catch (error) {
        outcomes.set(id, { run: id, ok: false, error: error as Error });
      }
    }),
  );
  const fresh = newIds.filter((id) => !outcomes.has(id));
  const done = (record: RunRecord & { sealedSeq: number }): ForkManyResult => ({
    from: ref.id,
    sealedSeq: record.sealedSeq,
    sourceGeneration: record.generation,
    outcomes: newIds.map((id) => outcomes.get(id)!),
    ms: Math.round(performance.now() - t0),
  });
  if (fresh.length === 0) return done(before);

  const note = options.onResource ?? (() => {});
  const base = join(options.mountRoot, `.fork-${Date.now().toString(36)}`);
  const tokens: string[] = [];
  /**
   * Mint a token for `run` and mount it exclusively under `<base>/<side>`. The caller keeps the claim before it calls
   * `mounted`, so a callback that throws never leaves a mount nobody releases.
   */
  const mount = async (run: RunRef, side: "source" | "target"): Promise<Claim> => {
    const t = await mintMountToken(control, { nickname: `${options.tokenPrefix ?? "pda-"}fork-${side}-${run.id}`.slice(0, 200), ttl: "1h" });
    tokens.push(t.identifier);
    note("token", t.identifier, side);
    return (options.acquire ?? acquire)({ ref: run, token: t.token, mountRoot: join(base, side), host: options.host });
  };
  const mounted = (claim: Claim, run: RunRef): void => note("mount", claim.root, `${run.disk}:/${runPath(run.id)}`);
  const release = async (c: Claim): Promise<void> => {
    await c.release().then(
      (r) => note("unmount", c.root, r.via),
      (error: unknown) => {
        note("unmount", c.root, "failed");
        throw error;
      },
    );
  };

  let source: Claim | undefined;
  try {
    source = await mount(ref, "source").catch((error: unknown) => {
      throw error instanceof HeldError ? new ForkError("SOURCE_HELD", `run ${ref.id} was mounted while forking`, { cause: error }) : error;
    });
    mounted(source, ref);
    // The mounted record is authoritative: the source cannot change while this claim holds it.
    const record = await readRunRecord(source.root);
    if (!isReleased(record)) throw new ForkError("SOURCE_NOT_RELEASED", `run ${ref.id} changed before it was mounted (${record?.status})`);
    const owner = await lstat(source.root);
    const asRoot = process.getuid?.() === 0;
    const from = source;

    /** One new run, start to finish; never throws (its failure is its outcome). */
    const copyOne = async (newId: string): Promise<void> => {
      const t1 = performance.now();
      const target = `${runPath(newId)}/`;
      // Set once this fork holds the new run's directory exclusively; until then the directory may be another operation's.
      let copy: Claim | undefined;
      let held = false;
      let made = false;
      try {
        await createRunDir(control, newId, { uid: owner.uid, gid: owner.gid, mode: owner.mode & 0o7777 });
        note("subdir", target);
        const to = { ...ref, id: newId };
        copy = await mount(to, "target").catch((error: unknown) => {
          throw error instanceof HeldError ? new ForkError("TARGET_EXISTS", `${target} was mounted by another fork or start`, { cause: error }) : error;
        });
        held = true;
        mounted(copy, to);
        const count = { files: 0, bytes: 0 };
        try {
          await copyTree(from.root, copy.root, true, asRoot, count);
        } catch (error) {
          throw new ForkError("COPY_FAILED", `copying ${runPath(ref.id)} to ${target} failed: ${(error as Error).message}`, { cause: error });
        }
        const forked: RunRecord = {
          run: newId,
          status: "paused",
          generation: 0,
          sealedSeq: record.sealedSeq,
          wakeAt: null,
          holder: null,
          heartbeatAt: null,
          updatedAt: new Date().toISOString(),
          detail: { forkedFrom: { run: ref.id, generation: record.generation, sealedSeq: record.sealedSeq } },
        };
        await persistRecord(copy.root, `${JSON.stringify(forked, null, 2)}\n`);
        // The release runs the barrier first: every copied byte is durable before the new run's claim goes.
        await release(copy);
        held = false;
        made = true;
        outcomes.set(newId, {
          run: newId,
          ok: true,
          result: { run: newId, from: ref.id, sealedSeq: record.sealedSeq, sourceGeneration: record.generation, ...count, owners: asRoot ? "preserved" : "caller", ms: Math.round(performance.now() - t1) },
        });
      } catch (error) {
        // Undo through this fork's own mount while it still holds it; nothing is deleted over S3, where a revoke would
        // take another operation's claim on the same id.
        if (copy && held && !copy.fenced) await emptyDir(copy.root).catch(() => undefined);
        outcomes.set(newId, { run: newId, ok: false, error: error as Error });
      } finally {
        if (copy && held) await release(copy).catch(() => undefined);
        // The emptied directory's own marker. S3 refuses to delete a directory with entries and deletes nothing under a
        // delegation, so this never removes a run another fork or start has taken since this fork released it.
        if (copy && !made) {
          await control.deleteObjects([target], { quiet: true }).catch(() => undefined);
          if (!(await control.headObject(target).catch(() => true))) note("subdir-deleted", target);
        }
      }
    };

    let next = 0;
    // Every copier ends before the source is released, even when one throws (only a throwing callback can).
    const copiers = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, fresh.length) }, async () => {
        while (next < fresh.length) await copyOne(fresh[next++]!);
      }),
    );
    for (const c of copiers) if (c.status === "rejected") throw c.reason;
    // A source still mounted here cannot start: its release is part of success, and one that fails is thrown.
    await release(source);
    source = undefined;
    return done(record);
  } finally {
    // After a failure the source's release is tried (again); the first error stands.
    if (source) await release(source).catch(() => undefined);
    for (const t of tokens) {
      await removeMountToken(control, t).then(() => note("token-removed", t), () => {});
    }
    for (const side of ["source", "target"]) {
      for (const dir of [join(base, side, "runs"), join(base, side)]) await rmdir(dir).catch(() => {});
    }
    await rmdir(base).catch(() => {});
  }
}
