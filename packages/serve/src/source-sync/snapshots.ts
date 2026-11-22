// Immutable source bundles and first-task seeding over Workspace. Authority/current pointers belong to the caller's
// store transaction. This layer neither chooses a current snapshot nor proves project continuity between runs.
import { createHash } from "node:crypto";
import { isNativeRuntime, NATIVE_RUNTIME_FACTS } from "../native/runtimes.js";
import { removeOwnedCaptureHooks } from "../native/source-capture-hooks.js";
import { sourceMcpSelection } from "../native/source-mcp-selection.js";
import { sourceAccountMetadataValid } from "../native/source-account.js";
import { SOURCE_NATIVE_CAPABILITIES, sourceSnapshotDigest, type SourceSnapshot, type SourceSnapshotEntry } from "../native/source-snapshot-types.js";
import { relativeSegments } from "../workspace/paths.js";
import { type Workspace } from "../workspace/workspace.js";

export class SnapshotError extends Error {
  constructor(readonly code: "invalid" | "incomplete" | "missing" | "corrupt" | "limit" | "prerequisite" | "conflict" | "unsafe_resume", message: string) {
    super(message); this.name = "SnapshotError";
  }
}

export type SnapshotLimits = { files: number; bytes: number; fileBytes: number; gitBytes: number; manifestBytes: number };
const MAX: SnapshotLimits = { files: 10_000, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, gitBytes: 32 * 1024 * 1024, manifestBytes: 4 * 1024 * 1024 };
const digestPattern = /^[a-f0-9]{64}$/;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function fail(message: string): never { throw new SnapshotError("invalid", message); }
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function limits(given: Partial<SnapshotLimits> = {}): SnapshotLimits {
  const result = { ...MAX, ...given };
  for (const key of Object.keys(MAX) as (keyof SnapshotLimits)[]) if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > MAX[key]) throw new SnapshotError("limit", "Snapshot limits must be positive and no larger than the supported ceiling.");
  return result;
}
function digest(value: unknown): asserts value is string { if (typeof value !== "string" || !digestPattern.test(value)) fail("A snapshot digest must be a SHA-256 hex value."); }
function path(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail("A snapshot path is invalid.");
  try { if (relativeSegments(value).length === 0) fail("A snapshot entry must name a path below its root."); }
  catch { fail("A snapshot path must remain inside its namespace."); }
}
/** Refuse non-JSON/deep input before canonicalizing it; manifests are untrusted, including their policy objects. */
function jsonTree(value: unknown, maximum: number): void {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 32) throw new SnapshotError("limit", "Snapshot metadata is too complex.");
    if (typeof v === "string") bytes += Buffer.byteLength(v);
    else if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) bytes += 8;
    else if (typeof v === "object" && v !== null && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      if (seen.has(v)) fail("Snapshot metadata must be JSON.");
      seen.add(v);
      for (const [key, item] of Object.entries(v)) { bytes += Buffer.byteLength(key); visit(item, depth + 1); }
      seen.delete(v);
    } else fail("Snapshot metadata must be JSON.");
    if (bytes > maximum) throw new SnapshotError("limit", "Snapshot metadata exceeds its byte limit.");
  };
  visit(value, 0);
}

type Manifest = Omit<SourceSnapshot, "blobs"> & { blobs: string[] };
function manifestOf(snapshot: SourceSnapshot): Manifest { return { ...snapshot, blobs: Object.keys(snapshot.blobs).sort() }; }
function validateManifest(value: unknown, cap: SnapshotLimits): Manifest {
  jsonTree(value, cap.manifestBytes);
  if (!record(value) || value.version !== 1 || typeof value.complete !== "boolean" || !strings(value.blobs) || !Array.isArray(value.entries) || !Array.isArray(value.blockers)) fail("The source snapshot manifest is invalid.");
  digest(value.digest);
  if (value.complete !== (value.blockers.length === 0)) fail("Snapshot completeness must agree with its blockers.");
  for (const blocker of value.blockers) if (!record(blocker) || typeof blocker.code !== "string" || typeof blocker.message !== "string" || blocker.path !== undefined && typeof blocker.path !== "string") fail("Snapshot diagnostics are invalid.");
  if (value.entries.length > cap.files || value.blobs.length > cap.files * 2 + 1) throw new SnapshotError("limit", "The source snapshot has too many entries.");
  if (new Set(value.blobs).size !== value.blobs.length) fail("Snapshot blob identities must be unique.");
  value.blobs.forEach(digest);
  const source = value.source;
  if (!record(source) || !isNativeRuntime(source.runtime) || typeof source.machine_id !== "string" || typeof source.project !== "string" || !record(source.selector)
    || !["project", "profile", "agent"].includes(source.selector.kind) || source.selector.kind !== "project" && typeof source.selector.name !== "string") fail("Snapshot source identity is invalid.");
  const entries = new Map<string, SourceSnapshotEntry>(), references = new Map<string, number>();
  const reference = (sha: unknown, bytes: unknown, maximum: number) => {
    digest(sha); if (!size(bytes)) fail("A snapshot byte count is invalid.");
    if (bytes > maximum) throw new SnapshotError("limit", "A snapshot blob exceeds its byte limit.");
    if (references.has(sha) && references.get(sha) !== bytes) fail("A shared blob has conflicting byte counts.");
    references.set(sha, bytes);
  };
  for (const entry of value.entries) {
    if (!record(entry)) fail("A snapshot entry is invalid.");
    path(entry.path);
    if (!["project", "instruction", "skill"].includes(entry.role) || !["file", "directory"].includes(entry.type) || !size(entry.mode) || entry.mode > 0o777 || !size(entry.bytes)) fail("A snapshot entry has invalid metadata.");
    const prefix = entry.role === "instruction" ? "instructions" : entry.role === "skill" ? "skills" : "project";
    if (entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) fail("A snapshot entry is outside its declared namespace.");
    if (entry.path === prefix && entry.type !== "directory") fail("A snapshot namespace root must be a directory.");
    if (entry.role === "project" && entry.path.split("/").includes(".git")) fail("Project entries cannot carry Git control files.");
    if (entries.has(entry.path)) fail("Snapshot entry paths must be unique.");
    entries.set(entry.path, entry as SourceSnapshotEntry);
    if (entry.type === "file") reference(entry.sha256, entry.bytes, cap.fileBytes);
    else if (entry.bytes !== 0 || entry.sha256 !== undefined) fail("A snapshot directory cannot carry file content.");
  }
  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    for (let n = 1; n < parts.length; n++) if (entries.get(parts.slice(0, n).join("/"))?.type === "file") fail("A snapshot file cannot contain another entry.");
  }
  const instructions = value.instructions;
  if (!record(instructions) || typeof instructions.text !== "string" || !Array.isArray(instructions.layers)) fail("Snapshot instructions are invalid.");
  for (const layer of instructions.layers) if (!record(layer) || typeof layer.source !== "string" || !size(layer.precedence) || entries.get(layer.path)?.role !== "instruction" || entries.get(layer.path)?.type !== "file") fail("An instruction layer has no captured file.");
  if (!Array.isArray(value.skills)) fail("Snapshot skills are invalid.");
  const skillNames = new Set<string>(), skillPaths: string[] = [];
  for (const skill of value.skills) {
    if (!record(skill) || typeof skill.source !== "string") fail("Snapshot skill identity is invalid.");
    path(skill.name); path(skill.path);
    if (skill.name.includes("/") || !skill.path.startsWith("skills/") || value.complete && (skillNames.has(skill.name) || entries.get(`${skill.path}/SKILL.md`)?.type !== "file")) fail("A complete selected skill must have one unique name and captured SKILL.md.");
    if (skillPaths.some(p => skill.path.startsWith(`${p}/`) || p.startsWith(`${skill.path}/`) || p === skill.path)) fail("Selected skill roots must not overlap.");
    skillNames.add(skill.name); skillPaths.push(skill.path);
  }
  for (const entry of entries.values()) if (entry.role === "skill" && !skillPaths.some(p => entry.path === p || entry.path.startsWith(`${p}/`))) fail("A skill asset is outside the selected skill closure.");
  const config = value.configuration;
  if (!record(config) || !(config.model === null || typeof config.model === "string") || !Array.isArray(config.tools) || !record(config.permissions) || !strings(config.credentials)) fail("Snapshot configuration is invalid.");
  for (const tool of config.tools) if (!record(tool) || typeof tool.name !== "string" || !["http", "stdio"].includes(tool.transport) || !strings(tool.credentials) || tool.url !== undefined && typeof tool.url !== "string"
    || tool.selection !== undefined && !sourceMcpSelection(tool.selection)
    || tool.resources !== undefined && (!strings(tool.resources) || tool.resources.length > 3 || new Set(tool.resources).size !== tool.resources.length || tool.resources.some((op: string) => !["list", "templates", "read"].includes(op)))) fail("Snapshot tool requirements are invalid.");
  const nativeTools = config.native_tools;
  if (config.native_account !== undefined && (!sourceAccountMetadataValid(config.native_account)
    || value.complete && ["managed", "unknown"].includes(config.native_account.plan ?? ""))) fail("Snapshot native account policy evidence is invalid or incomplete.");
  if (nativeTools !== undefined) {
    const known = new Set<string>(SOURCE_NATIVE_CAPABILITIES);
    if (!record(nativeTools) || !(nativeTools.version === null || typeof nativeTools.version === "string") || typeof nativeTools.complete !== "boolean"
      || !["versioned-runtime", "native-resolved"].includes(nativeTools.source) || !strings(nativeTools.capabilities) || !strings(nativeTools.disabled)
      || nativeTools.capabilities.length + nativeTools.disabled.length > known.size || value.complete && !nativeTools.complete
      || new Set([...nativeTools.capabilities, ...nativeTools.disabled]).size !== nativeTools.capabilities.length + nativeTools.disabled.length
      || [...nativeTools.capabilities, ...nativeTools.disabled].some(item => !known.has(item))) fail("Snapshot native capability evidence is invalid.");
  }
  if (!record(value.project)) fail("Snapshot project metadata is invalid.");
  const git = value.project.git;
  if (git !== null) {
    if (!record(git) || !(git.head === null || typeof git.head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(git.head)) || !(git.branch === null || typeof git.branch === "string") || typeof git.dirty !== "boolean" || !strings(git.deleted) || !["complete", "unavailable"].includes(git.history)) fail("Git project metadata is invalid.");
    if (value.complete && (git.history !== "complete" || !git.head || !record(git.bundle))) fail("A complete Git project needs restorable history.");
    for (const deleted of git.deleted) { path(deleted); if (deleted.split("/").includes(".git") || entries.has(`project/${deleted}`)) fail("A Git deletion cannot name control files or captured content."); }
    if (git.bundle !== undefined) { if (!record(git.bundle)) fail("A Git bundle is invalid."); reference(git.bundle.sha256, git.bundle.bytes, cap.gitBytes); }
  }
  if (value.transforms !== undefined && (!Array.isArray(value.transforms) || value.transforms.length > value.entries.length)) fail("Snapshot transforms are invalid.");
  const transformed = new Set<string>();
  for (const transform of value.transforms ?? []) {
    if (!record(transform) || transform.kind !== "agentrun-capture-hooks" || typeof transform.path !== "string" || transformed.has(transform.path)
      || !record(transform.receipt)) fail("A capture-hook transform is invalid or duplicated.");
    const original = entries.get(transform.path), receipt = entries.get(transform.receipt.path);
    const projectPath = NATIVE_RUNTIME_FACTS[source.runtime].protocol === "codex-json" ? "project/.codex/hooks.json" : "project/.claude/settings.local.json";
    const external = /^instructions\/capture-hooks\/[a-f0-9]{12}\/hooks\.json$/.test(transform.path) && NATIVE_RUNTIME_FACTS[source.runtime].protocol === "codex-json";
    if (!original || original.type !== "file" || original.sha256 !== transform.original_sha256 || original.bytes !== transform.original_bytes
      || (transform.path !== projectPath && !external) || original.role !== (external ? "instruction" : "project")
      || transform.receipt.path !== `project/.agentrun/cli-learning/${source.runtime}.json`
      || !receipt || receipt.type !== "file" || receipt.role !== "project" || receipt.sha256 !== transform.receipt.sha256) fail("A capture-hook transform does not match its source and installer receipt.");
    reference(transform.destination_sha256, transform.destination_bytes, cap.fileBytes);
    transformed.add(transform.path);
  }
  if (value.blobs.length !== references.size || value.blobs.some((sha: string) => !references.has(sha))) fail("Every snapshot blob must match one referenced asset or Git bundle.");
  if ([...references.values()].reduce((sum, bytes) => sum + bytes, 0) > cap.bytes) throw new SnapshotError("limit", "The snapshot exceeds its total byte limit.");
  const expanded = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) + (git?.bundle?.bytes ?? 0) + (value.transforms ?? []).reduce((sum: number, transform: { destination_bytes: number }) => sum + transform.destination_bytes, 0);
  if (expanded > cap.bytes) throw new SnapshotError("limit", "The expanded source files exceed the snapshot byte limit.");
  if (Buffer.byteLength(canonical(value)) > cap.manifestBytes) throw new SnapshotError("limit", "The manifest exceeds its byte limit.");
  const shaped = value as Manifest;
  if (sourceSnapshotDigest({ ...shaped, blobs: Object.fromEntries(shaped.blobs.map(sha => [sha, ""])) }) !== shaped.digest) throw new SnapshotError("corrupt", "The source manifest does not match its digest.");
  return shaped;
}

function blobSizes(manifest: Manifest): Map<string, number> {
  const result = new Map(manifest.entries.filter(entry => entry.type === "file").map(entry => [entry.sha256!, entry.bytes]));
  for (const transform of manifest.transforms ?? []) result.set(transform.destination_sha256, transform.destination_bytes);
  const bundle = manifest.project.git?.bundle;
  if (bundle) result.set(bundle.sha256, bundle.bytes);
  return result;
}
async function readBounded(work: Workspace, name: string, maximum: number): Promise<Uint8Array | undefined> {
  const stat = await work.stat(name);
  if (!stat) return undefined;
  if (stat.kind !== "file") throw new SnapshotError("corrupt", "A snapshot object is not a regular file.");
  if (stat.size > maximum) throw new SnapshotError("limit", "A stored snapshot object exceeds its byte limit.");
  const bytes = await work.read(name, { length: maximum + 1 });
  if (bytes.length > maximum) throw new SnapshotError("limit", "A stored snapshot object exceeds its byte limit.");
  return bytes;
}
const manifestPath = (sha: string) => `manifests/${sha}.json`;
const blobPath = (sha: string) => `blobs/${sha}`;

function verifiedSnapshot(snapshot: SourceSnapshot, given?: Partial<SnapshotLimits>) {
  const cap = limits(given);
  if (!record(snapshot) || !record(snapshot.blobs)) fail("A snapshot must include its blobs.");
  const manifest = validateManifest(manifestOf(snapshot), cap), decoded = new Map<string, Uint8Array>();
  for (const [sha, bytes] of blobSizes(manifest)) {
    const encoded = snapshot.blobs[sha];
    if (typeof encoded !== "string" || encoded.length > Math.ceil(bytes / 3) * 4) fail("A snapshot blob has invalid base64 or length.");
    const body = Buffer.from(encoded, "base64");
    if (body.length !== bytes || body.toString("base64") !== encoded || hash(body) !== sha) throw new SnapshotError("corrupt", "A source blob does not match its digest and byte count.");
    decoded.set(sha, body);
  }
  for (const transform of manifest.transforms ?? []) {
    let reproduced: ReturnType<typeof removeOwnedCaptureHooks>;
    try { reproduced = removeOwnedCaptureHooks(decoded.get(transform.original_sha256)!, decoded.get(transform.receipt.sha256)!, manifest.source); }
    catch { throw new SnapshotError("invalid", "A capture-hook transform has no verified installer ownership."); }
    if (transform.path.startsWith("project/") !== (reproduced.configRoot === manifest.source.project)
      || !reproduced.bytes.equals(Buffer.from(decoded.get(transform.destination_sha256)!))) throw new SnapshotError("invalid", "A capture-hook transform changes more than the verified owned handlers.");
  }
  return { cap, manifest, decoded };
}

/** Validate available content and diagnostics identically for complete/incomplete uploads, without writing. Missing
 * skill closure or Git history is allowed only in an explicitly incomplete snapshot, never committed or seeded. */
export function validateSourceSnapshot(snapshot: SourceSnapshot, given?: Partial<SnapshotLimits>): void {
  verifiedSnapshot(snapshot, given);
}

/** Writes verified content first, then its complete immutable manifest. Returns no current pointer: the service may
 * publish this digest only in its authorized store CAS. Failed writes leave at most unreferenced content. */
export async function commitSourceSnapshot(work: Workspace, snapshot: SourceSnapshot, given?: Partial<SnapshotLimits>): Promise<string> {
  const { cap, manifest, decoded } = verifiedSnapshot(snapshot, given);
  if (!manifest.complete) throw new SnapshotError("incomplete", "Only a complete source snapshot can be committed.");
  const encodedManifest = canonical(manifest), held = await readBounded(work, manifestPath(manifest.digest), cap.manifestBytes);
  if (held !== undefined && Buffer.from(held).toString("utf8") !== encodedManifest) throw new SnapshotError("corrupt", "A committed snapshot manifest cannot be replaced.");
  // Validate every existing object before any writes, including on idempotent retries.
  const missing: [string, Uint8Array][] = [];
  for (const [sha, body] of decoded) {
    const saved = await readBounded(work, blobPath(sha), body.length);
    if (saved === undefined) { if (held !== undefined) throw new SnapshotError("corrupt", "A committed snapshot is missing content."); missing.push([sha, body]); }
    else if (saved.length !== body.length || hash(saved) !== sha) throw new SnapshotError("corrupt", "Stored snapshot content no longer matches its digest.");
  }
  for (const [sha, body] of missing) await work.write(blobPath(sha), body);
  if (held === undefined) await work.write(manifestPath(manifest.digest), encodedManifest);
  return manifest.digest;
}

/** Reads only a committed manifest; verifies every exact binary blob and the full manifest digest. */
export async function readSourceSnapshot(work: Workspace, sha: string, given?: Partial<SnapshotLimits>): Promise<SourceSnapshot> {
  digest(sha); const cap = limits(given), bytes = await readBounded(work, manifestPath(sha), cap.manifestBytes);
  if (bytes === undefined) throw new SnapshotError("missing", "The complete source snapshot has not been committed.");
  let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new SnapshotError("corrupt", "The snapshot manifest is not valid JSON."); }
  const manifest = validateManifest(raw, cap);
  if (!manifest.complete) throw new SnapshotError("incomplete", "The stored snapshot is not complete.");
  if (manifest.digest !== sha) throw new SnapshotError("corrupt", "The requested snapshot and stored manifest disagree.");
  const blobs: Record<string, string> = {};
  for (const [id, expected] of blobSizes(manifest)) {
    const body = await readBounded(work, blobPath(id), expected);
    if (body === undefined || body.length !== expected || hash(body) !== id) throw new SnapshotError("corrupt", "Stored snapshot content is missing or does not match its digest.");
    blobs[id] = Buffer.from(body).toString("base64");
  }
  const snapshot = { ...manifest, blobs };
  verifiedSnapshot(snapshot, given);
  return snapshot;
}

export type SeedEntry = SourceSnapshotEntry & { path: string };
export interface SeedPreparation {
  /** Apply and verify exact modes durably through the destination's capabilities. No ambient host filesystem. */
  applyModes(work: Workspace, entries: readonly SeedEntry[]): Promise<void>;
  /** Restore Git metadata/index only, never checkout files or execute hooks, filters or network operations. Must be
   * idempotent before dispatch and return only when HEAD/branch/index match the supplied source metadata. */
  restoreGit?(work: Workspace, git: NonNullable<SourceSnapshot["project"]["git"]>, bundle: Uint8Array): Promise<void>;
}

function seedEntries(snapshot: SourceSnapshot): SeedEntry[] {
  const entries = new Map<string, SeedEntry>();
  for (const source of snapshot.entries) {
    let target: string | undefined;
    if (source.role === "project") target = source.path === "project" ? "" : source.path.slice("project/".length);
    else if (source.role === "skill") {
      const skill = snapshot.skills.find(skill => source.path === skill.path || source.path.startsWith(`${skill.path}/`))!;
      target = `.agents/skills/${skill.name}${source.path.slice(skill.path.length)}`;
    }
    if (target === undefined) continue; // Instruction layers are managed configuration, not another ambient file copy.
    if (target !== "") path(target);
    if (target.split("/").includes(".git")) fail("Project entries cannot write Git control paths.");
    const transform = snapshot.transforms?.find(item => item.path === source.path);
    const entry = { ...source, path: target, ...(transform ? { sha256: transform.destination_sha256, bytes: transform.destination_bytes } : {}) }, previous = entries.get(target);
    if (previous && (previous.type !== entry.type || previous.mode !== entry.mode || previous.bytes !== entry.bytes || previous.sha256 !== entry.sha256)) throw new SnapshotError("conflict", "Project files and authored skills disagree at the same destination path.");
    entries.set(target, entry);
  }
  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    for (let n = 1; n < parts.length; n++) if (entries.get(parts.slice(0, n).join("/"))?.type === "file") throw new SnapshotError("conflict", "A seeded file would replace a required directory.");
  }
  return [...entries.values()].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
}

/** Seed one pinned project in an exclusive pre-admission placement. `control` is a separate, private run-owned
 * Workspace, inaccessible to agent tools. The caller guarantees exclusive initialization and proves beforeDispatch;
 * these booleans are evidence supplied by that lifecycle, not locks this module acquires. A missing marker proves nothing.
 * A matching completed marker makes reclaim read-only, preserving every later edit. This is not a checkpoint. */
export async function seedSourceSnapshot(options: {
  snapshots: Workspace; destination: Workspace; control: Workspace; digest: string; beforeDispatch: boolean; exclusiveInitialization: boolean;
  preparation?: SeedPreparation; limits?: Partial<SnapshotLimits>;
}): Promise<{ seeded: boolean }> {
  const { snapshots, destination, control, preparation } = options;
  if (destination === control) throw new SnapshotError("invalid", "Seed control must be private and separate from the project workspace.");
  const snapshot = await readSourceSnapshot(snapshots, options.digest, options.limits), entries = seedEntries(snapshot);
  const markerPath = "source-seed.json", markerBytes = await readBounded(control, markerPath, 1024);
  let marker: { version: 1; digest: string; phase: "writing" | "complete" } | undefined;
  if (markerBytes !== undefined) {
    try { marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(markerBytes)); } catch { throw new SnapshotError("corrupt", "The private seed marker is invalid."); }
    if (!marker || marker.version !== 1 || marker.digest !== snapshot.digest || !["writing", "complete"].includes(marker.phase)) throw new SnapshotError("conflict", "The run's seed marker does not match its pinned snapshot.");
    if (marker.phase === "complete") return { seeded: false };
  }
  if (options.beforeDispatch !== true || options.exclusiveInitialization !== true) throw new SnapshotError("unsafe_resume", "An unfinished seed requires exclusive initialization before the first task starts.");
  if (!preparation?.applyModes || snapshot.project.git && !preparation.restoreGit) throw new SnapshotError("prerequisite", "The destination must support verified file modes and any required Git restoration before seeding.");
  const gitControl = await destination.stat(".git");
  if (gitControl && (!marker || !snapshot.project.git || gitControl.kind !== "dir")) throw new SnapshotError("conflict", "Seeding would replace existing Git metadata.");
  for (const deleted of snapshot.project.git?.deleted ?? []) if (await destination.stat(deleted)) throw new SnapshotError("conflict", "A path deleted in the source already exists in the destination; it was preserved.");
  // Inspect every destination and parent before writing. Never follow a planted link or replace unrelated input.
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const parent = await destination.stat(parts.slice(0, n).join("/"));
      if (parent && parent.kind !== "dir") throw new SnapshotError("conflict", "A seeded path has a non-directory parent.");
    }
    const current = await destination.stat(entry.path);
    if (!current) continue;
    if (entry.type === "directory" && current.kind === "dir") continue;
    if (!marker || entry.type !== "file" || current.kind !== "file" || current.size !== entry.bytes) throw new SnapshotError("conflict", "Seeding would replace an existing project file.");
    if (hash(await destination.read(entry.path, { length: entry.bytes + 1 })) !== entry.sha256) throw new SnapshotError("conflict", "An interrupted seed found a changed file; it was preserved.");
  }
  if (!marker) await control.write(markerPath, canonical({ version: 1, digest: snapshot.digest, phase: "writing" }));
  if (snapshot.project.git) await preparation.restoreGit!(destination, snapshot.project.git, Buffer.from(snapshot.blobs[snapshot.project.git.bundle!.sha256]!, "base64"));
  for (const entry of entries) {
    if (entry.type === "directory") { if (entry.path !== "") await destination.mkdir(entry.path); }
    else {
      const existing = await destination.stat(entry.path);
      if (existing) {
        if (!marker || existing.kind !== "file" || existing.size !== entry.bytes || hash(await destination.read(entry.path, { length: entry.bytes + 1 })) !== entry.sha256) throw new SnapshotError("conflict", "A destination file changed during initialization; it was preserved.");
      } else await destination.write(entry.path, Buffer.from(snapshot.blobs[entry.sha256!]!, "base64"));
    }
  }
  await preparation.applyModes(destination, entries);
  for (const entry of entries) if (entry.type === "file" && hash(await destination.read(entry.path, { length: entry.bytes + 1 })) !== entry.sha256) throw new SnapshotError("corrupt", "Seeded content changed before initialization completed.");
  await control.write(markerPath, canonical({ version: 1, digest: snapshot.digest, phase: "complete" }));
  return { seeded: true };
}
