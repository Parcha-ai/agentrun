/** Claim-time moved-project checks. No seeding, no restoration of task edits, and no private control handle reaches
 * the harness. A missing placement refuses before inputs, skills, computer allocation or model dispatch. */
import type { RunLaunch } from "../run-launch.js";
import type { RevisionRow, RunRow, Store } from "../store/store.js";
import { kindSkillOf } from "../workspace/kind-skills.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import type { Workspace } from "../workspace/workspace.js";
import { verifySourceProject } from "./projects.js";
import { SnapshotError } from "./snapshots.js";
import { sourceSyncOf } from "./types.js";
import { sourceRunControl, type SourceWorkspaceOptions } from "./workspace.js";

export async function verifyPlacedProject(store: Store, run: RunRow, revision: RevisionRow, launch: RunLaunch, options: SourceWorkspaceOptions): Promise<boolean> {
  const binding = sourceSyncOf(revision.body), placed = launch.sourceProject;
  if (!binding && !placed) return false;
  if (!binding || !placed || placed.sourceId !== binding.id || placed.digest !== binding.project || placed.baselineRevision !== revision.id || revision.id !== run.revisionId)
    throw new SnapshotError("prerequisite", "This moved project needs normal project placement before it can run. Auxiliary runs must prepare their own project and completion receipt.");
  const control = await sourceRunControl(store, { agentId: run.agentId, runId: run.id, launch }, options);
  try { await verifySourceProject(control.workspace, placed); } finally { await control.end(); }
  return true;
}

/** Full authored assets already exist in the seeded workspace. Only discover their current SKILL.md files; stale
 * revision text must never recreate a directory the task removed. The host's computer-kind guidance remains its own
 * add-only asset, unless an authored skill selected that name. */
export async function movedSkillFiles(work: Workspace, authored: Readonly<Record<string, unknown>>, computer?: string): Promise<readonly string[]> {
  const kind = kindSkillOf(computer), authoredNames = new Set(Object.keys(authored).map(path => path.split("/")[0]));
  if (kind && !authoredNames.has(kind.name)) await layOwnSkills(work, {}, { computer });
  const root = ".agents/skills", stat = await work.stat(root);
  if (!stat) return [];
  if (stat.kind !== "dir") throw new SnapshotError("conflict", "The moved project's skills directory is not a directory.");
  const entries = await work.list(root);
  if (entries.length > 10_000) throw new SnapshotError("limit", "The moved project has too many skill entries.");
  // Ordinary owner-authored skill paths may be nested. Keep those exact paths discoverable as well as current
  // top-level skills, without recreating any missing file from the revision text.
  const candidates = new Set([...Object.keys(authored).filter(path => path.endsWith("/SKILL.md")), ...entries.map(entry => `${entry.name}/SKILL.md`)]);
  if (candidates.size > 10_000) throw new SnapshotError("limit", "The moved project has too many skill entries.");
  const paths: string[] = [];
  for (const file of candidates) {
    if ((await work.stat(`${root}/${file}`))?.kind === "file") paths.push(file);
  }
  return paths.sort();
}
