// Capture only a managed project's settled durable Workspace. Source authority/configuration never comes from the
// task's files. The lifecycle holds its strict drain across this entire read and publishes under its claim/CAS.
import { createHash } from "node:crypto";
import { secretsIn } from "../secret-cut.js";
import { secretShapes } from "../learn/secrets.js";
import { sourceSnapshotDigest, type SourceSnapshot, type SourceSnapshotEntry } from "../native/source-snapshot-types.js";
import { relativeSegments } from "../workspace/paths.js";
import type { Workspace } from "../workspace/workspace.js";
import { SnapshotError, validateSourceSnapshot, type SnapshotLimits } from "./snapshots.js";

export interface ProjectExclusion { readonly path: string; readonly recursive: boolean }
export interface ProjectGitCapture {
  readonly metadata: NonNullable<SourceSnapshot["project"]["git"]>;
  readonly bundle: Uint8Array;
  /** Git's tracked and untracked nonignored files, obtained without running source config/hooks/filters. */
  readonly files: readonly string[];
  readonly inventory: readonly ProjectInventoryEntry[];
  /** Recheck the isolated view's original bytes after project capture, while the same strict drain remains held. */
  readonly verify?: () => Promise<void>;
}
export interface ProjectInventoryEntry { readonly path: string; readonly type: "file" | "directory"; readonly mode: number; readonly bytes: number }
export interface ProjectInventoryCandidate { readonly path: string; readonly type: "file" | "directory" | "unsupported"; readonly mode: number; readonly bytes: number }
export type ProjectInventorySelector = (entries: readonly ProjectInventoryCandidate[]) => Promise<ReadonlySet<string>>;
export interface ProjectGitOptions {
  readonly signal?: AbortSignal; readonly secretValues?: readonly string[];
  /** Select names before validating or descending into them; ignored dependency trees are not project content. */
  readonly inventory: (select: ProjectInventorySelector) => Promise<readonly ProjectInventoryEntry[]>;
  readonly retain: readonly string[];
  readonly exclude: readonly ProjectExclusion[];
  readonly limits: SnapshotLimits;
}
export interface ProjectCaptureOptions {
  readonly workspace: Workspace;
  readonly baseline: SourceSnapshot;
  /** Exact paths owned by this run's host (placed input files and declared scratch roots), never guessed exclusions. */
  readonly exclude: readonly ProjectExclusion[];
  /** A safe isolated Git view, with bounded objects/history, no source configuration or untrusted execution. Missing
   * capability blocks a Git project; it never flattens that project into an apparently complete plain directory. */
  readonly git?: (workspace: Workspace, options: ProjectGitOptions) => Promise<ProjectGitCapture>;
  readonly secretValues?: readonly string[];
  readonly signal?: AbortSignal;
  readonly limits?: Partial<SnapshotLimits>;
}
type InventoryEntry = ProjectInventoryEntry;
const MAX = { files: 10_000, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, gitBytes: 32 * 1024 * 1024, manifestBytes: 4 * 1024 * 1024 };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const contains = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}/`);
function portable(path: string, root = false): void {
  if (typeof path !== "string" || /[\x00-\x1f\x7f]/.test(path) || Buffer.byteLength(path) > 4096 || !root && path === "") throw new SnapshotError("prerequisite", "The project contains an unsupported path.");
  try { relativeSegments(path); } catch { throw new SnapshotError("prerequisite", "The project contains a path outside its root."); }
}
const excluded = (path: string, exclusions: readonly ProjectExclusion[]): boolean => exclusions.some(item => item.recursive ? contains(item.path, path) : item.path === path);
const credentialPath = (path: string): boolean => path.split("/").some(part => /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|\.credentials\.json|\.claude\.json|id_(?:rsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.gnupg)$/i.test(part)) || /\.(?:pem|p12|pfx|key)$/i.test(path);

/** Workspace.stat intentionally carries no modes, and Archil's file API cannot identify links. A bounded trusted
 * metadata command checks the real destination filesystem instead. Failure or truncation is a prerequisite, never
 * invented 0644/0755 metadata. It executes no project program and never traverses a link or Git control tree. */
async function inventory(work: Workspace, exclusions: readonly ProjectExclusion[], limits: SnapshotLimits, signal?: AbortSignal, select?: ProjectInventorySelector): Promise<InventoryEntry[]> {
  const format = String.raw`%y\0%m\0%s\0%p\0`;
  const prune = [".git", ...exclusions.map(item => item.path)];
  const entries: InventoryEntry[] = [], pending = [""];
  while (pending.length) {
    const directory = pending.shift()!;
    const args = ["find", directory ? `./${directory}` : ".", ...(select ? ["-maxdepth", "1", ...(directory ? ["-mindepth", "1"] : [])] : []), "(", ...prune.flatMap((path, index) => [...(index ? ["-o"] : []), "-path", `./${path.replace(/[\\*?\[\]]/g, "\\$&")}`]), ")", "-prune", "-printf", format, "-o", "-printf", format];
    const result = await work.exec(args, { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeoutMs: 30_000, maxOutput: limits.manifestBytes, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (result.code !== 0 || result.signal || result.timedOut || result.truncated) throw new SnapshotError("prerequisite", "The destination could not read a complete project inventory with file modes.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout); }
    catch { throw new SnapshotError("prerequisite", "The project contains a filename that is not portable UTF-8."); }
    const columns = text.split("\0");
    if (columns.pop() !== "" || columns.length % 4 !== 0) throw new SnapshotError("prerequisite", "The destination returned incomplete filesystem metadata.");
    const candidates: ProjectInventoryCandidate[] = [];
    for (let at = 0; at < columns.length; at += 4) {
      const [kind, rawMode, rawBytes, rawPath] = columns.slice(at, at + 4) as [string, string, string, string];
      const path = rawPath === "." ? "" : rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
      portable(path, true);
      if (excluded(path, exclusions)) {
        if (kind === "d" && exclusions.some(item => item.path === path && !item.recursive)) throw new SnapshotError("conflict", "A host-owned input file became a directory; its children were preserved.");
        continue;
      }
      if (!/^[0-7]{1,4}$/.test(rawMode) || !/^\d+$/.test(rawBytes) || !Number.isSafeInteger(Number(rawBytes))) {
        throw new SnapshotError("prerequisite", "Links, special files or privileged modes require an explicit project representation.");
      }
      candidates.push({ path, type: kind === "d" ? "directory" : kind === "f" ? "file" : "unsupported", mode: parseInt(rawMode, 8), bytes: kind === "d" ? 0 : Number(rawBytes) });
    }
    const selected = select ? await select(candidates) : undefined;
    for (const entry of candidates) {
      if (selected && !selected.has(entry.path)) continue;
      if (entry.path !== ".git" && entry.path.split("/").includes(".git")) throw new SnapshotError("prerequisite", "Nested Git repositories need their own complete project representation.");
      if (entry.type === "unsupported" || entry.mode > 0o777) throw new SnapshotError("prerequisite", "Links, special files or privileged modes require an explicit project representation.");
      entries.push({ ...entry, type: entry.type });
      if (entries.length > limits.files) throw new SnapshotError("limit", "The complete project inventory exceeds its file limit.");
      if (select && entry.path && entry.path !== ".git" && entry.type === "directory") pending.push(entry.path);
    }
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function sourcePath(snapshot: SourceSnapshot, entry: SourceSnapshotEntry): string | undefined {
  if (entry.role === "project") return entry.path === "project" ? "" : entry.path.slice("project/".length);
  if (entry.role === "skill") {
    const skill = snapshot.skills.find(skill => contains(skill.path, entry.path));
    if (skill) return `.agents/skills/${skill.name}${entry.path.slice(skill.path.length)}`;
  }
  return undefined;
}

/** A complete immutable successor, or a refusal. Original source instructions, tool policy and skill identities
 * remain configuration; current project and authored-skill bytes/modes become the separately pinned project. */
export async function captureProject(options: ProjectCaptureOptions): Promise<SourceSnapshot> {
  const { workspace: work, baseline, signal } = options;
  signal?.throwIfAborted(); validateSourceSnapshot(baseline, options.limits);
  if (!baseline.complete) throw new SnapshotError("incomplete", "A project checkpoint needs its complete baseline.");
  for (const item of options.exclude) {
    portable(item.path);
    if (contains(".git", item.path) || item.path === ".agents" || contains(".agents/skills", item.path)) throw new SnapshotError("conflict", "Project metadata and authored skills cannot be declared host scratch.");
  }
  for (const entry of baseline.entries) {
    const path = sourcePath(baseline, entry);
    if (path !== undefined && excluded(path, options.exclude)) throw new SnapshotError("conflict", "A host-owned exclusion collides with original project content.");
  }
  const cap = { ...MAX, ...options.limits };
  const probe = await inventory(work, options.exclude, cap, signal, async rows => new Set(rows.filter(row => row.path === "" || row.path === ".git").map(row => row.path)));
  const gitEntry = probe.find(entry => entry.path === ".git");
  // Imported skills and explicit owner-authored skill files remain required even when Git ignores .agents/.
  // Named skills keep their whole asset directory; standalone owned companions keep only their exact paths.
  const ownedSkillFiles = baseline.entries.filter(entry => entry.role === "project" && entry.type === "file" && entry.path.startsWith("project/.agents/skills/"))
    .map(entry => entry.path.slice("project/".length));
  const retainedSkills = [...new Set([...baseline.skills.map(skill => `.agents/skills/${skill.name}`), ...ownedSkillFiles,
    ...ownedSkillFiles.filter(path => path.endsWith("/SKILL.md") && path !== ".agents/skills/SKILL.md").map(path => path.slice(0, -9))])];
  let git: ProjectGitCapture | undefined;
  if (gitEntry || baseline.project.git) {
    if (gitEntry?.type !== "directory" || !options.git) throw new SnapshotError("prerequisite", "Git project capture requires a complete safe isolated Git metadata capability.");
    git = await options.git(work, { inventory: select => inventory(work, options.exclude, cap, signal, select), retain: retainedSkills, exclude: options.exclude, limits: cap, ...(signal ? { signal } : {}), ...(options.secretValues ? { secretValues: options.secretValues } : {}) });
    for (const path of git.files) portable(path);
    if (git.bundle.length > cap.gitBytes) throw new SnapshotError("limit", "Git history exceeds the project checkpoint limit.");
  }
  const before = git?.inventory ?? await inventory(work, options.exclude, cap, signal);
  const selected = (entry: InventoryEntry): boolean => entry.path !== ".git" && (!git || entry.path === "" || git.files.some(path => entry.path === path || entry.type === "directory" && contains(entry.path, path))
    || retainedSkills.some(path => contains(path, entry.path) || entry.type === "directory" && contains(entry.path, path)));
  const entries = baseline.entries.filter(entry => entry.role === "instruction").map(entry => ({ ...entry }));
  const blobs: Record<string, string> = Object.create(null), observed = new Map<string, string>(); let expanded = 0;
  const keep = (bytes: Uint8Array): string => { const sha = hash(bytes); blobs[sha] = Buffer.from(bytes).toString("base64"); return sha; };
  for (const entry of entries) if (entry.type === "file") { blobs[entry.sha256!] = baseline.blobs[entry.sha256!]!; expanded += entry.bytes; }
  for (const entry of before.filter(selected)) {
    signal?.throwIfAborted();
    if (credentialPath(entry.path) || options.secretValues?.some(value => value && entry.path.includes(value))) throw new SnapshotError("prerequisite", "Credential-bearing project paths must remain outside the durable source checkpoint.");
    if (entry.bytes > cap.fileBytes || expanded + entry.bytes > cap.bytes) throw new SnapshotError("limit", "The project checkpoint exceeds its byte limits.");
    const skill = baseline.skills.find(skill => contains(`.agents/skills/${skill.name}`, entry.path));
    const path = skill ? `${skill.path}${entry.path.slice(`.agents/skills/${skill.name}`.length)}` : `project${entry.path ? `/${entry.path}` : ""}`;
    const target: SourceSnapshotEntry = { path, role: skill ? "skill" : "project", type: entry.type, mode: entry.mode, bytes: entry.bytes };
    if (entry.type === "file") {
      const body = await work.read(entry.path, { length: entry.bytes + 1 }); signal?.throwIfAborted();
      if (body.length !== entry.bytes) throw new SnapshotError("conflict", "Project bytes changed while the checkpoint was read.");
      const text = Buffer.from(body).toString("utf8");
      if (options.secretValues?.some(value => value && (text.includes(value) || entry.path.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)))) || secretShapes(text).length || (await secretsIn(text)).length) {
        throw new SnapshotError("prerequisite", "Credential-bearing content was withheld from the project checkpoint.");
      }
      target.sha256 = keep(body); observed.set(entry.path, target.sha256); expanded += body.length;
    }
    entries.push(target);
  }
  for (const skill of baseline.skills) if (!entries.some(entry => entry.path === `${skill.path}/SKILL.md` && entry.type === "file")) throw new SnapshotError("incomplete", "A required authored skill is missing from the current project.");
  if (!git && !same(before, await inventory(work, options.exclude, cap, signal))) throw new SnapshotError("conflict", "Project metadata changed during checkpoint capture.");
  // Backend mount inode/timestamp identities can change between execs. Verify actual bytes instead of treating a
  // fresh mount's inode as a source mutation, or trusting unchanged sizes as proof of unchanged content.
  for (const entry of before.filter(entry => entry.type === "file" && selected(entry))) {
    signal?.throwIfAborted(); const body = await work.read(entry.path, { length: entry.bytes + 1 });
    if (body.length !== entry.bytes || hash(body) !== observed.get(entry.path)) throw new SnapshotError("conflict", "Project bytes changed during checkpoint capture.");
  }
  await git?.verify?.();
  const project = git ? { git: { ...git.metadata, bundle: { sha256: keep(git.bundle), bytes: git.bundle.length } } } : { git: null };
  // Project rewrites have already been applied before dispatch. Their original-source receipts remain in the
  // separately pinned source snapshot; replaying that transform over current managed bytes would be incorrect.
  // External instruction assets were never materialized, so retain their verifiable provenance while its exact
  // installer receipt still exists. No transformation is inferred from task-authored replacement content.
  const transforms = baseline.transforms?.filter(transform => transform.path.startsWith("instructions/")
    && entries.some(entry => entry.path === transform.receipt.path && entry.sha256 === transform.receipt.sha256));
  for (const transform of transforms ?? []) blobs[transform.destination_sha256] = baseline.blobs[transform.destination_sha256]!;
  const { transforms: _transforms, ...original } = baseline;
  const value = { ...original, entries, blobs, project, ...(transforms?.length ? { transforms } : {}), complete: true, blockers: [] };
  const result = { ...value, digest: sourceSnapshotDigest(value) };
  signal?.throwIfAborted(); validateSourceSnapshot(result, options.limits); return result;
}
