/** Explicit owner skill edits make a new immutable project. Current run folders are never touched. */
import { createHash } from "node:crypto";
import type { SavePrepare } from "../agents-store.js";
import { sourceSnapshotDigest, type SourceSnapshot, type SourceSnapshotEntry } from "../native/source-snapshot-types.js";
import { canonical, isSkillPath, type AgenticBody } from "../store/agent-body.js";
import type { Store } from "../store/store.js";
import { beginSourceIO } from "./io.js";
import { commitSourceSnapshot, readSourceSnapshot, seedEntries, SnapshotError, validateSourceSnapshot } from "./snapshots.js";
import { sourceSyncOf } from "./types.js";
import { sourceSnapshotReader, sourceWorkspace, type SourceWorkspaceOptions } from "./workspace.js";

const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function destination(snapshot: SourceSnapshot, entry: SourceSnapshotEntry): string | undefined {
  if (entry.role === "project") return entry.path === "project" ? "" : entry.path.slice(8);
  if (entry.role === "skill") {
    const skill = snapshot.skills.find(skill => within(skill.path, entry.path));
    if (skill) return `.agents/skills/${skill.name}${entry.path.slice(skill.path.length)}`;
  }
  return undefined;
}

/** Compare against the last owner-authored file set, not current task-edited bytes. An unchanged file in an editor
 * round trip keeps those task edits; a changed file is explicit owner intent. Removing SKILL.md removes that skill's
 * complete asset directory, so native discovery cannot keep offering deleted guidance. Other removals are per-file. */
export function projectWithSkillEdits(snapshot: SourceSnapshot, previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): SourceSnapshot {
  validateSourceSnapshot(snapshot);
  for (const files of [previous, next]) for (const [path, text] of Object.entries(files)) {
    if (!isSkillPath(path) || typeof text !== "string") throw new SnapshotError("invalid", "Owner skill files must be relative paths and text.");
  }
  if (canonical(previous) === canonical(next)) return snapshot;
  const removedRoots = Object.keys(previous).filter(path => path.endsWith("/SKILL.md") && !Object.hasOwn(next, path))
    .map(path => `.agents/skills/${path.slice(0, -9)}`);
  const removedFiles = new Set(Object.keys(previous).filter(path => !Object.hasOwn(next, path)).map(path => `.agents/skills/${path}`));
  const removed = (path: string): boolean => removedFiles.has(path) || removedRoots.some(root => within(root, path));
  const discarded = snapshot.entries.filter(entry => entry.type === "file" && removed(destination(snapshot, entry) ?? ""))
    .map(entry => destination(snapshot, entry)!);
  const entries = snapshot.entries.filter(entry => !removed(destination(snapshot, entry) ?? "")).map(entry => ({ ...entry }));
  const skills = snapshot.skills.filter(skill => !removedRoots.some(root => within(root, `.agents/skills/${skill.name}`)));
  const blobs: Record<string, string> = { ...snapshot.blobs };
  for (const [path, text] of Object.entries(next)) {
    const target = `.agents/skills/${path}`, unchanged = Object.hasOwn(previous, path) && previous[path] === text;
    if (unchanged && !removed(target)) continue;
    const prior = snapshot.entries.find(entry => destination(snapshot, entry) === target && entry.type === "file");
    // A caller may remove SKILL.md while retaining an explicitly owned companion. Preserve its current bytes/mode,
    // but do not restore a task-deleted unchanged file merely because its old text remains on the revision.
    if (unchanged && !prior) continue;
    const bytes = unchanged ? Buffer.from(snapshot.blobs[prior!.sha256!]!, "base64") : Buffer.from(text), sha256 = hash(bytes);
    const matches = entries.filter(entry => destination(snapshot, entry) === target);
    if (matches.some(entry => entry.type !== "file")) throw new SnapshotError("conflict", "An owner skill file conflicts with a current project directory.");
    blobs[sha256] = bytes.toString("base64");
    if (matches.length) for (const entry of matches) { entry.bytes = bytes.length; entry.sha256 = sha256; }
    else {
      const skill = skills.find(skill => within(`.agents/skills/${skill.name}`, target));
      const root = skill?.path ?? "project", role = skill ? "skill" : "project";
      const stored = skill ? `${skill.path}${target.slice(`.agents/skills/${skill.name}`.length)}` : `project/${target}`;
      const parts = stored.split("/");
      for (let n = root.split("/").length; n < parts.length; n++) {
        const parent = parts.slice(0, n).join("/"), exists = entries.find(entry => entry.path === parent);
        if (exists?.type === "file") throw new SnapshotError("conflict", "An owner skill path has a current project file as its parent.");
        if (!exists) {
          const targetParent = skill ? `.agents/skills/${skill.name}${parent.slice(skill.path.length)}` : parent === "project" ? "" : parent.slice(8);
          const previousParent = snapshot.entries.find(entry => entry.type === "directory" && destination(snapshot, entry) === targetParent);
          entries.push({ path: parent, role, type: "directory", mode: previousParent?.mode ?? 0o755, bytes: 0 });
        }
      }
      entries.push({ path: stored, role, type: "file", mode: prior?.mode ?? 0o644, bytes: bytes.length, sha256 });
    }
  }
  // Retain only referenced content. Immutable old manifests/blobs are retained separately for pinned runs/revisions.
  const retained = new Set(entries.flatMap(entry => entry.sha256 ? [entry.sha256] : []));
  if (snapshot.project.git?.bundle) retained.add(snapshot.project.git.bundle.sha256);
  for (const transform of snapshot.transforms ?? []) retained.add(transform.destination_sha256);
  const currentPaths = new Set(entries.map(entry => destination({ ...snapshot, skills }, entry)));
  const project = snapshot.project.git ? { git: { ...snapshot.project.git, dirty: true,
    deleted: [...new Set([...snapshot.project.git.deleted, ...discarded])].filter(path => !currentPaths.has(path)).sort() } } : snapshot.project;
  const value = { ...snapshot, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), skills, project,
    blobs: Object.fromEntries([...retained].map(sha => [sha, blobs[sha]!])) };
  const result = { ...value, digest: sourceSnapshotDigest(value) };
  validateSourceSnapshot(result);
  seedEntries(result); // The saved project must be placeable: skill/project aliases cannot disagree.
  return result;
}

/** Called inside the agent's delete turn after validation. The durable I/O receipt also fences other server processes
 * until the revision CAS settles. Failed/unknown storage operations retain it; a stale revision leaves only unreferenced
 * immutable bytes, and the next commit attempt rebuilds against its new current project. */
export function prepareProjectSkillEdit(store: Store, agentId: string, options: SourceWorkspaceOptions): SavePrepare {
  return async (revision, current) => {
    const binding = sourceSyncOf(current?.body), previous = (current?.skills ?? {}) as Record<string, string>, next = (revision.skills ?? {}) as Record<string, string>;
    if (!binding || canonical(previous) === canonical(next)) return { revision, settled: async () => {} };
    const reader = await sourceSnapshotReader(store, agentId, options);
    let snapshot: SourceSnapshot;
    try { snapshot = await readSourceSnapshot(reader.workspace, binding.project); } finally { await reader.end(); }
    const successor = projectWithSkillEdits(snapshot, previous, next);
    const receipt = await beginSourceIO(store, agentId, "snapshot");
    const opened = await sourceWorkspace(store, agentId, options);
    try { await commitSourceSnapshot(opened.workspace, successor); } finally { await opened.end(); }
    return { revision: { ...revision, body: { ...(revision.body as AgenticBody), sourceSync: { ...binding, project: successor.digest } } }, settled: () => receipt.settled() };
  };
}
