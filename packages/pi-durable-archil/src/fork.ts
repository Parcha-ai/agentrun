// Fork: copy a released, sealed run into a new run directory. S3 CopyObject is not supported, so both runs
// are mounted exclusively for the copy, which also keeps either from starting meanwhile; the mounts go under a mount
// root of their own, never where an instance mounts. The source is only read (its claim probe aside, which every mount
// writes). The new run's run.json starts at generation 0 and carries the source's seal: its first open is generation 1
// and refuses a copy that lost a committed sequence (STORE_BEHIND_SEAL). Supervisor side: it needs the API key.
import { chmod, copyFile, lchown, lstat, mkdir, readdir, readlink, rmdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { acquire, createRunDir, type AcquireOptions, findDelegations, mintMountToken, removeMountToken, runPath, type ArchilHost, type Claim, type RunRef } from "./claim.ts";
import { HeldError, PdaError } from "./errors.ts";
import { persistRecord, readRunRecord, RUN_JSON, RUN_JSON_TEMP, type RunRecord } from "./status.ts";
import { CONTROL_TIMEOUT_MS, deleteRunTree, readRunStatus, START_MARK, withTimeouts, type CheckControl, type CheckOptions, type SupervisorControl } from "./supervise.ts";
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

/**
 * Fork run `ref` into run `newId`. The source must be released and sealed (run.json paused, sleeping, done
 * or failed with a `sealedSeq`, and no delegation); `newId` must not exist. On any failure the new run's directory is
 * deleted, so a half copy never looks like a run; every token and mount is removed either way.
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
  let created = false;
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
    created = true;
    note("subdir", target);
    const copy = await mount({ ...ref, id: newId }, "target");
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
  } finally {
    for (const c of claims.reverse()) {
      await c.release().then(
        (r) => note("unmount", c.root, r.via),
        () => note("unmount", c.root, "failed"),
      );
    }
    if (created && !done) {
      await deleteRunTree(control, newId).then(() => note("subdir-deleted", target), () => {});
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
