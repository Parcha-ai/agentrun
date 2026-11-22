// Server-owned source bundles and exclusive pre-admission placement, on the same storage the runner will use.
// A claim only verifies the completed receipt. It never invokes this preparer or re-seeds a running project.
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { agentDiskOf, loadArchilSettings, DEFAULT_ARCHIL_EXEC_IMAGE } from "../archil-settings.js";
import type { KeyEnv } from "../key-meta.js";
import type { LaunchDisk, RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { archilDisk, type ArchilDiskOptions, type ArchilDisk } from "../workspace/archil-disk.js";
import { archilApiKey } from "../workspace/archil-key.js";
import { archilWorkspace } from "../workspace/archil.js";
import { openBeneath } from "../workspace/beneath.js";
import { localWorkspace } from "../workspace/local.js";
import { DISK_DIR, relativeSegments, runKey, sourceSnapshotsKey, sourceRunControlKey } from "../workspace/paths.js";
import { launchDiskProblem, runDiskOf } from "../workspace/run-disk.js";
import { readOnlyWorkspace } from "../workspace/server-run-workspace.js";
import { type Workspace, WorkspaceError } from "../workspace/workspace.js";
import { SnapshotError, type SeedEntry, type SeedPreparation } from "./snapshots.js";
import { captureProject, type ProjectCaptureOptions } from "./capture-project.js";
import { captureGit } from "./capture-git.js";

type SourceStore = Pick<Store, "settings" | "sealedKeys">;
export interface SourceWorkspaceOptions {
  readonly data: string;
  readonly sealKey: Buffer | undefined;
  readonly env?: KeyEnv;
  readonly signal?: AbortSignal;
  readonly control?: { readonly baseUrl?: string; readonly fetch?: typeof fetch; readonly makeDisk?: (options: ArchilDiskOptions) => ArchilDisk };
}
export interface SourceWorkspace {
  readonly mode: "local" | "archil";
  readonly workspace: Workspace;
  readonly launchDisk?: LaunchDisk;
  end(): Promise<void>;
}
type RunTarget = { readonly runId?: string; readonly launch?: RunLaunch; readonly requirePinned?: true; readonly readOnly?: true };
const noProcess = async (): Promise<never> => { throw new WorkspaceError("REFUSED", "Source preparation starts no background programs."); };

/** Prefix every file operation through LocalWorkspace's descriptor-based walk from the trusted data root. Checking
 * an absolute child root once would let a later parent-link swap redirect its writes. Reads never make folders. */
function localFolder(data: string, key: string): Workspace {
  const base = localWorkspace(data), prefix = `${DISK_DIR}/${key}`;
  const at = (path = ""): string => [prefix, ...relativeSegments(path)].join("/");
  const ensure = async (): Promise<void> => {
    const parts = relativeSegments(prefix);
    for (let n = 1; n <= parts.length; n++) {
      const part = parts.slice(0, n).join("/"), stat = await base.stat(part);
      if (stat?.kind === "link") throw new WorkspaceError("ESCAPE", "A source folder cannot be reached through a symbolic link.");
      if (stat && stat.kind !== "dir") throw new WorkspaceError("REFUSED", "A source folder has a file in its path.");
      if (!stat) {
        await base.mkdir(part);
        const held = await openBeneath(data, part, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await held.chmod(0o700); await held.sync(); } finally { await held.close(); }
      }
    }
  };
  return {
    read: (path, range) => base.read(at(path), range),
    stat: path => base.stat(at(path)),
    list: path => base.list(at(path)),
    write: async (path, bytes) => { await ensure(); await base.write(at(path), bytes); },
    append: async (path, bytes) => { await ensure(); await base.append(at(path), bytes); },
    mkdir: async path => { await ensure(); await base.mkdir(at(path)); },
    remove: (path, options) => base.remove(at(path), options),
    grep: async (pattern, options) => {
      const result = await base.grep(pattern, { ...options, path: at(options?.path) });
      return { ...result, matches: result.matches.map(match => ({ ...match, path: match.path.slice(prefix.length + 1) })) };
    },
    exec: async (argv, options) => { await ensure(); return base.exec(argv, { ...options, cwd: at(options.cwd) }); },
    // Only the runner's separately fenced workspace mounts a computer. Preparation never mints a mount credential.
    mountSpec: noProcess, attach: noProcess,
    process: { start: noProcess, read: noProcess, write: noProcess, signal: noProcess, wait: noProcess, list: noProcess },
  };
}

async function backend(store: SourceStore, agentId: string, options: SourceWorkspaceOptions, target: RunTarget) {
  // Validate IDs even when no filesystem call is made (including a malformed Mode 2 target).
  sourceSnapshotsKey(agentId); if (target.runId !== undefined) runKey(agentId, target.runId);
  const settings = await loadArchilSettings(store, options.env);
  if (!settings) {
    if (target.launch?.archilDisk) throw new SnapshotError("prerequisite", "Restore this run's Archil configuration before opening its pinned project.");
    return { mode: "local" as const, open: (key: string) => localFolder(options.data, key), end: async () => {}, launchDisk: undefined };
  }
  if (target.requirePinned && !target.launch?.archilDisk) throw new SnapshotError("prerequisite", "An admitted source project must name its original Archil disk.");
  const { value } = await archilApiKey({ env: options.env ?? {}, keys: store.sealedKeys, sealKey: options.sealKey });
  const control = { region: settings.region, key: () => value, ...options.control };
  let launchDisk: LaunchDisk;
  if (target.readOnly) {
    // Source status and placement's snapshot reads are not writers. In particular, a concurrent purge may have
    // removed the stored disk after their first metadata read; never allocate a replacement or clear pending here.
    const stored = await agentDiskOf(store, agentId), pinned = target.launch?.archilDisk;
    if (pinned?.kind !== "launch" && (!stored || stored.removing || stored.pending || pinned && pinned.diskId !== stored.diskId))
      throw new SnapshotError("prerequisite", "The retained source disk is unavailable or being removed; a read cannot create or replace it.");
    launchDisk = pinned ?? { diskId: stored!.diskId, kind: "agent" };
    const problem = await launchDiskProblem(control, launchDisk.diskId, options.signal ? { signal: options.signal } : {});
    if (problem) throw new SnapshotError("prerequisite", problem);
  } else {
    launchDisk = await runDiskOf({ store, agentId, control, ...(target.runId ? { runId: target.runId } : {}),
      ...(target.launch?.archilDisk ? { launch: target.launch.archilDisk } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  }
  const disk = (options.control?.makeDisk ?? archilDisk)({ disk: launchDisk.diskId, region: settings.region, s3BaseUrl: settings.s3Url,
    key: () => value, ...(options.control?.baseUrl ? { baseUrl: options.control.baseUrl } : {}) });
  const opened: ReturnType<typeof archilWorkspace>[] = [];
  const open = (key: string): Workspace => {
    const work = archilWorkspace(disk, key, { image: { baseImage: settings.image ?? DEFAULT_ARCHIL_EXEC_IMAGE } }); opened.push(work); return work;
  };
  let ended: Promise<void> | undefined;
  return { mode: "archil" as const, launchDisk, open, end: () => ended ??= (async () => { if (!target.readOnly) for (const work of opened) await work.sweep(); })() };
}

/** Immutable cache on the agent's disk, or the caller's explicit pinned run disk. Account credentials stay in the
 * resolver's closure; no secret or large snapshot is written to settings. Mode 2 never falls back to local files. */
export async function sourceWorkspace(store: SourceStore, agentId: string, options: SourceWorkspaceOptions, target: RunTarget = {}): Promise<SourceWorkspace> {
  const place = await backend(store, agentId, options, target);
  const workspace = place.open(sourceSnapshotsKey(agentId));
  return { mode: place.mode, workspace: target.readOnly ? readOnlyWorkspace(workspace) : workspace,
    ...(place.launchDisk ? { launchDisk: place.launchDisk } : {}), end: place.end };
}

/** Existing immutable source bytes only. Opening or closing a reader never allocates a disk, updates its ownership,
 * writes files or sweeps execution spill. A missing retained source is an explicit prerequisite, not an empty cache. */
export function sourceSnapshotReader(store: SourceStore, agentId: string, options: SourceWorkspaceOptions, target: RunTarget = {}): Promise<SourceWorkspace> {
  return sourceWorkspace(store, agentId, options, { ...target, readOnly: true });
}

/** Runner verification opens only its private completed receipt. It allocates no disk, makes no directory, seeds
 * nothing and gives no private file access to model tools. Missing pinned Mode 2 storage is a refusal. */
export async function sourceRunControl(store: SourceStore, target: { agentId: string; runId: string; launch: RunLaunch }, options: SourceWorkspaceOptions): Promise<SourceWorkspace> {
  const place = await backend(store, target.agentId, options, { ...target, requirePinned: true, readOnly: true });
  return { mode: place.mode, workspace: readOnlyWorkspace(place.open(sourceRunControlKey(target.agentId, target.runId))),
    ...(place.launchDisk ? { launchDisk: place.launchDisk } : {}), end: async () => {} };
}

/** The caller holds the run's strict executor drain and storage sync across this operation. Git's temporary copy
 * lives beside the private seed receipt, never in the model's project. It is removed only after all reads/commands
 * have settled. This capability does not seed, change authority, or publish a checkpoint pointer. */
export async function captureManagedProject(store: SourceStore, target: {
  agentId: string; runId: string; launch: RunLaunch;
} & Omit<ProjectCaptureOptions, "git">, options: SourceWorkspaceOptions) {
  const signal = target.signal ?? options.signal;
  const place = await backend(store, target.agentId, options, { ...target, requirePinned: true });
  const controlKey = sourceRunControlKey(target.agentId, target.runId), control = place.open(controlKey);
  const name = `capture-${randomUUID()}`, scratch = place.open(`${controlKey}/${name}`); let opened = false;
  try {
    return await captureProject({ ...target, ...(signal ? { signal } : {}), git: async (work, given) => {
      await scratch.mkdir(""); opened = true;
      return captureGit(work, scratch, given);
    } });
  } finally {
    try { if (opened) await control.remove(name, { recursive: true, force: true }); }
    finally { await place.end(); }
  }
}

const EXEC_ENV = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
async function checkedExec(work: Workspace, argv: readonly string[], signal?: AbortSignal, stdin?: Uint8Array): Promise<string> {
  const answer = await work.exec([...argv], { env: EXEC_ENV, timeoutMs: 30_000, maxOutput: 1024 * 1024, ...(signal ? { signal } : {}), ...(stdin ? { stdin } : {}) });
  if (answer.code !== 0 || answer.signal || answer.timedOut || answer.truncated) throw new SnapshotError("prerequisite", "The destination could not complete and verify source metadata preparation.");
  return Buffer.from(answer.stdout).toString("utf8").trim();
}

/** These commands restore objects, HEAD and the baseline index only. No checkout, source Git config, hook, filter,
 * helper, credential or remote is invoked. The dirty/untracked/deleted working tree is supplied separately as bytes. */
function gitPreparation(signal?: AbortSignal): NonNullable<SeedPreparation["restoreGit"]> {
  return async (work, git, bundle) => {
    if (!git.head || git.history !== "complete") throw new SnapshotError("prerequisite", "A complete Git history is required for this project.");
    await checkedExec(work, [...GIT, "init", "--quiet", "--template=", "--initial-branch=agentrun-source"], signal);
    const bundlePath = ".git/agentrun-source.bundle";
    await work.write(bundlePath, bundle);
    try {
      await checkedExec(work, [...GIT, "bundle", "verify", bundlePath], signal);
      await checkedExec(work, [...GIT, "bundle", "unbundle", bundlePath], signal);
      if (git.branch !== null) {
        const ref = `refs/heads/${git.branch}`;
        await checkedExec(work, [...GIT, "check-ref-format", ref], signal);
        await checkedExec(work, [...GIT, "update-ref", ref, git.head], signal);
        await checkedExec(work, [...GIT, "symbolic-ref", "HEAD", ref], signal);
        if (await checkedExec(work, [...GIT, "symbolic-ref", "HEAD"], signal) !== ref) throw new SnapshotError("corrupt", "The restored Git branch does not match the source.");
      } else await checkedExec(work, [...GIT, "update-ref", "--no-deref", "HEAD", git.head], signal);
      await checkedExec(work, [...GIT, "read-tree", "--reset", git.head], signal);
      const head = await checkedExec(work, [...GIT, "rev-parse", "--verify", "HEAD"], signal);
      const tree = await checkedExec(work, [...GIT, "rev-parse", "--verify", `${git.head}^{tree}`], signal);
      if (head !== git.head || await checkedExec(work, [...GIT, "write-tree"], signal) !== tree) throw new SnapshotError("corrupt", "The restored Git HEAD or index does not match its source baseline.");
    } finally { await work.remove(bundlePath, { force: true }); }
  };
}
const modeOrder = (entries: readonly SeedEntry[]): SeedEntry[] => [...entries].sort((a, b) =>
  (a.type === "directory" ? 1 : 0) - (b.type === "directory" ? 1 : 0) || b.path.split("/").length - a.path.split("/").length);
const MODE_SCRIPT = `set -eu
action=$1
tab=$(printf '\\t')
while IFS="$tab" read -r mode kind path; do
  target="./$path"
  part="$target"
  while :; do
    [ ! -L "$part" ] || exit 31
    [ "$part" != . ] || break
    part=\${part%/*}
  done
  if [ "$kind" = directory ]; then [ -d "$target" ]; else [ -f "$target" ]; fi
  if [ "$action" = apply ]; then chmod -- "$mode" "$target"; fi
  [ "$(stat -c '%a' -- "$target")" = "$mode" ] || exit 32
done
sync -f .
`;
function preparation(mode: "local" | "archil", data: string, key: string, signal?: AbortSignal): SeedPreparation {
  return {
    restoreGit: gitPreparation(signal),
    applyModes: async (work, entries) => {
      if (mode === "local") {
        for (const entry of modeOrder(entries)) {
          const path = [DISK_DIR, key, ...relativeSegments(entry.path)].join("/");
          const held = await openBeneath(data, path, constants.O_RDONLY | constants.O_NONBLOCK | (entry.type === "directory" ? constants.O_DIRECTORY : 0));
          try {
            const stat = await held.stat();
            if (entry.type === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new SnapshotError("conflict", "A source file changed kind during preparation.");
            await held.chmod(entry.mode); await held.sync();
            if (((await held.stat()).mode & 0o777) !== entry.mode) throw new SnapshotError("prerequisite", "The destination did not retain a source file mode.");
          } finally { await held.close(); }
        }
      } else {
        const input = Buffer.from(modeOrder(entries).map(entry => `${entry.mode.toString(8)}\t${entry.type}\t${entry.path || "."}\n`).join(""));
        await checkedExec(work, ["sh", "-c", MODE_SCRIPT, "source-modes", "apply"], signal, input);
        // A separate exec verifies persistence, not merely chmod's local exit status inside one transient container.
        await checkedExec(work, ["sh", "-c", MODE_SCRIPT, "source-modes", "verify"], signal, input);
      }
    },
  };
}

export interface SourceRunPlacement extends SourceWorkspace {
  readonly control: Workspace;
  readonly preparation: SeedPreparation;
  /** Caller first resolves uncertain admission. This only removes the owned, still unadmitted run's folders. */
  undo(): Promise<void>;
}
/** Called under the start path's exclusive reservation, before any run is admitted. Upload placement may already
 * have made inputs/ and pinned a disk. All operations settle before this returns; end does not disable rollback. */
export async function openRunPlacement(store: SourceStore & Pick<Store, "runs">, target: { agentId: string; runId: string; launch: RunLaunch }, options: SourceWorkspaceOptions): Promise<SourceRunPlacement> {
  if (await store.runs.get(target.runId)) throw new SnapshotError("unsafe_resume", "An admitted run's project cannot be prepared again.");
  const place = await backend(store, target.agentId, options, target), key = runKey(target.agentId, target.runId);
  const controlKey = sourceRunControlKey(target.agentId, target.runId);
  const workspace = place.open(key), control = place.open(controlKey), parent = place.open(key.slice(0, key.lastIndexOf("/")));
  const existing = await workspace.list("").catch(error => { if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return []; throw error; });
  if (existing.length && (!target.launch.filesPlaced || existing.some(entry => entry.name !== "inputs" || entry.kind !== "dir"))) {
    throw new SnapshotError("conflict", "This run's project folder is not an empty, exclusively reserved destination.");
  }
  if (await control.stat("source-seed.json")) throw new SnapshotError("unsafe_resume", "A previous source placement must be resolved before starting this run.");
  let undone = false;
  return { mode: place.mode, workspace, control, ...(place.launchDisk ? { launchDisk: place.launchDisk } : {}),
    preparation: preparation(place.mode, options.data, key, options.signal), end: place.end,
    undo: async () => {
      if (undone) return;
      if (await store.runs.get(target.runId)) throw new SnapshotError("unsafe_resume", "The admitted run keeps its project; placement rollback was refused.");
      // Workspace roots are deliberately not removable on Archil. The server's private parent can remove these
      // two named children without granting a model any access to siblings, receipts or another run.
      await parent.remove(key.slice(key.lastIndexOf("/") + 1), { recursive: true, force: true });
      await parent.remove(controlKey.slice(controlKey.lastIndexOf("/") + 1), { recursive: true, force: true });
      undone = true;
    },
  };
}
