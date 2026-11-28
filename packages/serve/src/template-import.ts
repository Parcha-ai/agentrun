// POST /v2/templates/import and the imported packages' life here: read from GitHub (template-source.ts), or uploaded whole
// as its files ({files}, by `agentrun deploy`), checked by the one checker (templates.ts readPackage, over the files held
// in memory), stored (store `imported_templates`) and loaded beside the bundled packages at each start. The first import
// stored from a GitHub account needs its owner's "I trust <account>", remembered server-side (settings
// TRUSTED_PUBLISHERS); an upload needs none, as only this server's owner (its session or its token) sends one, and it
// goes with the last agent applied from it (store Agents.purge). Nothing in a package runs.
import { packageSha256 } from "./agent-package.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { type Store, UPLOAD_PREFIX } from "./store/index.js";
import { fetchPackageFiles, type GithubReach, type GithubSource, hiddenPath, ImportRefused, IMPORT_LIMITS, parseSource, resolveSha } from "./template-source.js";
import { manifestOf } from "./manifest.js";
import { outOfScope, workspaceNow } from "./workspace-scope.js";
import { checkWorkflowPackage, MANIFEST, memoryFiles, type Package, PackageError, readPackage, type TemplateRegistry } from "./templates.js";
import { isObject, type Json, unknownFields } from "./validate.js";

/** The settings key that holds the GitHub accounts this server's owner trusts as publishers, lower-cased. */
export const TRUSTED_PUBLISHERS = "templates.trusted_publishers";

/** An uploaded package's id is this and its manifest's name: the next upload of that name replaces it. */
export { UPLOAD_PREFIX };

export type TemplateImportDeps = {
  registry: TemplateRegistry;
  store: Pick<Store, "importedTemplates" | "settings">;
  /** Where GitHub is read (template-source.ts GithubReach): GitHub's hosts and this server's App token when it has one. */
  reach: (signal: AbortSignal) => Promise<GithubReach>;
  /** The API-only profile: an upload is taken, a GitHub source refused (its backend sends the package). */
  apiOnly?: boolean;
};

/** One package name's store write and registry change at a time, per registry (this process's): an import keeps its
 *  row and serves its package, a delete reads, removes and drops, each whole. Without it a reimport could keep its row
 *  before a delete read the row and serve its package after the delete dropped the registry's copy, so the registry
 *  served a name the store no longer kept (every read 404, every import of it 409 `name_taken`, until a restart). */
export class TemplateNames {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #waiting = new Map<string, number>();

  async hold<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(id);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = before ? before.then(() => mine) : mine;
    this.#tails.set(id, tail);
    if (before) {
      this.#waiting.set(id, this.waiting(id) + 1);
      await before;
      const left = this.waiting(id) - 1;
      if (left) this.#waiting.set(id, left);
      else this.#waiting.delete(id);
    }
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(id) === tail) this.#tails.delete(id);
    }
  }

  /** How many calls wait for `id` behind the one that holds it. */
  waiting(id: string): number {
    return this.#waiting.get(id) ?? 0;
  }
}

const NAMES = new WeakMap<object, TemplateNames>();
/** The registry's package names' lock (TemplateNames). */
export function templateNames(registry: object): TemplateNames {
  let names = NAMES.get(registry);
  if (!names) NAMES.set(registry, (names = new TemplateNames()));
  return names;
}

/** The folder name a package's id ends in: an upload's name, else its path's last part, else the repository's name
 *  (agent.md's `name` is it). */
const nameOf = (id: string) => (id.startsWith(UPLOAD_PREFIX) ? id.slice(UPLOAD_PREFIX.length) : id.slice("github:".length).split("/").at(-1)!);

/** An upload's sha: the digest an export names (agent-package.ts packageSha256), which `agentrun deploy` locks. */
const uploadSha = (files: ReadonlyMap<string, Buffer>): string => packageSha256([...files].map(([path, data]) => ({ path, encoding: "base64", content: data.toString("base64") })));

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** A path part that is not plain, or a character no package path holds (a control character, a backslash). */
const NOT_PLAIN = (path: string) => /[\0-\x1f\x7f\\]/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..");

/** An upload's files ({path, encoding, content}) as the package's bytes by path, each hidden path left out: 422 under
 *  files.<i> for one that is not that shape; the GitHub import's own refusals (ImportRefused "package") for a path that is not plain or is there twice,
 *  over its count and over the bytes it keeps. */
function uploadFiles(raw: unknown): Map<string, Buffer> {
  const shape = "files is a list of {path, encoding, content}: each file of the package, its encoding utf8 or base64";
  if (!Array.isArray(raw) || raw.length === 0) throw invalid([{ field: "files", reason: "wrong_type", message: shape }]);
  if (raw.length > IMPORT_LIMITS.files) throw new ImportRefused("package", `The package holds over ${IMPORT_LIMITS.files} files.`);
  const issues: InputIssue[] = [];
  const read: [string, Buffer][] = [];
  raw.forEach((one: unknown, i) => {
    if (!isObject(one) || typeof one.path !== "string" || typeof one.content !== "string") return void issues.push({ field: `files.${i}`, reason: "wrong_type", message: shape });
    for (const issue of unknownFields(one, ["path", "encoding", "content"])) issues.push({ ...issue, field: `files.${i}.${issue.field}` });
    if (one.encoding !== "utf8" && one.encoding !== "base64") return void issues.push({ field: `files.${i}.encoding`, reason: "not_an_option", message: "encoding is utf8 or base64" });
    if (one.encoding === "base64" && !BASE64.test(one.content)) return void issues.push({ field: `files.${i}.content`, reason: "invalid", message: `${JSON.stringify(one.path)}'s content is not base64` });
    read.push([one.path, Buffer.from(one.content, one.encoding)]);
  });
  if (issues.length) throw invalid(issues);
  const files = new Map<string, Buffer>();
  let kept = 0;
  for (const [path, data] of read) {
    if (NOT_PLAIN(path)) throw new ImportRefused("package", `The package holds ${JSON.stringify(path)}, a path that is not plain: refused.`);
    // A hidden file or folder (.env, .DS_Store, .cache/) is no part of a package (templates.ts reads none): left out here,
    // before anything is counted, stored or hashed, so a client's .env is never kept. An import from GitHub skips it too.
    if (hiddenPath(path)) continue;
    if (files.has(path)) throw new ImportRefused("package", `The package holds ${JSON.stringify(path)} twice: refused.`);
    kept += data.length;
    if (kept > IMPORT_LIMITS.packageBytes) throw new ImportRefused("package", `The package's files are over the ${IMPORT_LIMITS.packageBytes} bytes an import keeps.`);
    files.set(path, data);
  }
  // A path that is a file and a folder's name at once (agent.md and agent.md/x) is no folder a package could be.
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) {
      const folder = parts.slice(0, end).join("/");
      if (files.has(folder)) throw new ImportRefused("package", `The package holds ${JSON.stringify(folder)} as a file and as a folder: refused.`);
    }
  }
  return files;
}

/** An imported package read from its files, checked whole, with its id and origin: PackageError when it does not check. */
export function importedPackage(id: string, origin: { source: string; sha: string; publisher: string }, files: ReadonlyMap<string, Buffer>): Package {
  const read = readPackage(memoryFiles(nameOf(id), `${id}@${origin.sha}`, files));
  return { ...read, id, origin };
}

/** importedPackage, a workflow package's workflow checked too (checkWorkflowPackage, which loads the DSL): what every
 *  import, upload and load of a kept package serves. */
const checkedImport = (id: string, origin: { source: string; sha: string; publisher: string }, files: ReadonlyMap<string, Buffer>): Promise<Package> =>
  checkWorkflowPackage(importedPackage(id, origin, files), `${id}@${origin.sha}`);

/** The packages the store keeps, put in the registry beside the bundled ones; one this build no longer takes is left out,
 *  said through `skipped`, never a stop of the start. */
export async function loadImported(deps: Pick<TemplateImportDeps, "registry" | "store">, skipped: (id: string, why: string) => void): Promise<void> {
  for (const row of await deps.store.importedTemplates.list()) {
    try {
      const files = new Map(Object.entries(row.files).map(([path, data]) => [path, Buffer.from(data, "base64")]));
      deps.registry.put(await checkedImport(row.id, { source: row.source, sha: row.sha, publisher: row.publisher }, files));
    } catch (error) {
      skipped(row.id, error instanceof PackageError ? error.problems.join("; ") : (error as Error).message);
    }
  }
}

/** The uploads served here whose row the store no longer keeps (an agent's purge removed it: Agents.purge), no longer
 *  served. Only the package read before the store is removed, so an upload put in meanwhile stays served. */
export async function dropRemovedUploads(deps: Pick<TemplateImportDeps, "registry" | "store">): Promise<void> {
  const served = deps.registry.list().filter((pkg) => pkg.origin !== null && pkg.id.startsWith(UPLOAD_PREFIX));
  if (!served.length) return;
  const stored = new Set(await deps.store.importedTemplates.ids());
  for (const pkg of served) if (!stored.has(pkg.id) && deps.registry.get(pkg.id) === pkg) deps.registry.remove(pkg.id);
}

/** Whether `publisher` is one the owner trusts (case-insensitive, as GitHub's account names are). */
async function trusted(deps: Pick<TemplateImportDeps, "store">, publisher: string): Promise<boolean> {
  const list = await deps.store.settings.get(TRUSTED_PUBLISHERS);
  return Array.isArray(list) && list.includes(publisher.toLowerCase());
}

/** `publisher` added to the trusted accounts, once, in a compare-and-set, so two imports at once both land. */
async function trust(deps: Pick<TemplateImportDeps, "store">, publisher: string): Promise<void> {
  const name = publisher.toLowerCase();
  for (let tries = 0; tries < 5; tries++) {
    const was = await deps.store.settings.get(TRUSTED_PUBLISHERS);
    const list = Array.isArray(was) ? (was as unknown[]).filter((one): one is string => typeof one === "string") : [];
    if (list.includes(name)) return;
    const next = [...list, name].sort();
    if (was === undefined) await deps.store.settings.putIfAbsent(TRUSTED_PUBLISHERS, next);
    else if (!(await deps.store.settings.replaceIf(TRUSTED_PUBLISHERS, was, next))) continue;
    if (await trusted(deps, name)) return;
  }
  throw new ApiError("home_busy", "The trusted publishers kept changing while this import was saved: send it again.");
}

/** What an import refused for answers: the source (422 `source`), the package (422 `package`), or GitHub (502). */
function refusalOf(error: unknown): never {
  if (error instanceof ImportRefused) {
    if (error.kind === "github") throw new ApiError("github_failed", error.message);
    throw invalid([{ field: error.kind, reason: "invalid", message: error.message }]);
  }
  if (error instanceof PackageError) {
    const fields: InputIssue[] = error.problems.map((problem) => ({ field: "package", reason: "invalid", message: problem }));
    throw invalid(fields, `The package does not check, so nothing was imported: ${error.problems.join("; ")}`);
  }
  throw error;
}

/** The body POST /v2/templates/import takes, checked: 422 naming each field that is wrong. A GitHub source ({source}), or
 *  the package's files ({files}, an upload); on an API-only server, the files alone. */
function bodyOf(body: Json, apiOnly: boolean): { source: GithubSource; dryRun: boolean; trustPublisher: boolean } | { files: unknown; dryRun: boolean } {
  const issues = unknownFields(body, ["source", "files", "dry_run", "trust_publisher"]);
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") issues.push({ field: "dry_run", reason: "wrong_type", message: "dry_run is true or false" });
  if (body.trust_publisher !== undefined && typeof body.trust_publisher !== "boolean") issues.push({ field: "trust_publisher", reason: "wrong_type", message: "trust_publisher is true or false" });
  if (typeof body.source === "string" && body.source.length > 1024) issues.push({ field: "source", reason: "too_long", message: "source is at most 1024 characters" });
  if (body.files !== undefined && body.source !== undefined) issues.push({ field: "files", reason: "not_allowed", message: "The body is {source} or {files}: source or files, not both." });
  if (body.files !== undefined && body.trust_publisher !== undefined) issues.push({ field: "trust_publisher", reason: "not_allowed", message: "An upload is this server's owner's own package, so an upload asks no publisher's trust: trust_publisher goes with a source alone." });
  if (apiOnly && body.source !== undefined) issues.push({ field: "source", reason: "not_allowed", message: "This server serves the API alone: a package is uploaded here as {files}, never read from GitHub." });
  if (issues.length) throw invalid(issues);
  if (body.files !== undefined) return { files: body.files, dryRun: body.dry_run === true };
  return { source: parseSource(body.source), dryRun: body.dry_run === true, trustPublisher: body.trust_publisher === true };
}

/** An upload: its files checked as an import's are, its id `upload:<name>` (its manifest's name), its sha the package's
 *  sha256; a dry run answers it, storing nothing; else it is stored and served (201), in place of the one of its name. */
async function uploadTemplate(deps: TemplateImportDeps, raw: unknown, dryRun: boolean): Promise<{ status: 200 | 201; pkg: Package; trusted: boolean; replaced: string | null }> {
  let pkg: Package;
  let files: Map<string, Buffer>;
  try {
    files = uploadFiles(raw);
    const name = manifestOf(files.get(MANIFEST)?.toString("utf8") ?? "")?.name;
    const id = `${UPLOAD_PREFIX}${typeof name === "string" ? name : ""}`;
    pkg = await checkedImport(id, { source: id, sha: uploadSha(files), publisher: "" }, files);
  } catch (error) {
    refusalOf(error);
  }
  const replaced = await replacedOf(deps, pkg.id);
  if (dryRun) return { status: 200, pkg, trusted: true, replaced };
  await kept(deps, pkg, { id: pkg.id, source: pkg.origin!.source, sha: pkg.origin!.sha, publisher: "", files: Object.fromEntries([...files].map(([path, data]) => [path, data.toString("base64")])) });
  return { status: 201, pkg, trusted: true, replaced };
}

/** POST /v2/templates/import: the package read at its source's commit and checked; a dry run answers it, storing nothing;
 *  else it is stored and served (201), in place of the one under its id. `signal` ends the read (the request's). An
 *  upload ({files}) is uploadTemplate's. */
export async function importTemplate(deps: TemplateImportDeps, raw: unknown, signal: AbortSignal): Promise<{ status: 200 | 201; pkg: Package; trusted: boolean; replaced: string | null }> {
  if (!isObject(raw)) throw invalid([{ field: "body", reason: "wrong_type", message: "The body is {source, dry_run?, trust_publisher?} or {files, dry_run?}." }]);
  const body = bodyOf(raw, deps.apiOnly === true);
  if ("files" in body) return uploadTemplate(deps, body.files, body.dryRun);
  const { source, dryRun, trustPublisher } = body;
  const read = AbortSignal.any([signal, AbortSignal.timeout(IMPORT_LIMITS.ms)]);
  let pkg: Package;
  let files: Map<string, Buffer>;
  try {
    const reach = await deps.reach(read);
    const sha = await resolveSha(source, reach, read);
    files = await fetchPackageFiles(source, sha, reach, read);
    pkg = await checkedImport(source.id, { source: source.source, sha, publisher: source.owner }, files);
  } catch (error) {
    refusalOf(error);
  }
  const replaced = await replacedOf(deps, source.id);
  const isTrusted = await trusted(deps, source.owner);
  if (dryRun) return { status: 200, pkg, trusted: isTrusted, replaced };
  if (!isTrusted && !trustPublisher) {
    throw invalid([{ field: "trust_publisher", reason: "missing", message: `${source.owner} has published no package this server has imported yet: read the package (a dry run shows it whole), then import it again with trust_publisher: true to say you trust ${source.owner}.`, fix: "Send trust_publisher: true." }]);
  }
  if (!isTrusted) await trust(deps, source.owner);
  await kept(deps, pkg, { id: pkg.id, source: pkg.origin!.source, sha: pkg.origin!.sha, publisher: pkg.origin!.publisher, files: Object.fromEntries([...files].map(([path, data]) => [path, data.toString("base64")])) });
  return { status: 201, pkg, trusted: true, replaced };
}

/** An import's refusal of a package name held outside its workspace: a scoped import's, of a name another workspace or
 *  the operator holds; an unscoped one's, of a name a workspace holds, which the operator deletes first to replace. */
const nameTaken = (id: string) =>
  new ApiError("name_taken", workspaceNow() !== undefined
    ? `A template package named ${id} is already on this server, outside this workspace: give the package another name in its manifest.`
    : `A template package named ${id} is already on this server, imported in a workspace: an import with no workspace never replaces it. Delete it first (DELETE /v2/templates/${id}), or give the package another name in its manifest.`);

/** The sha of the package an import of `id` replaces, or null. In a workspace (workspace-scope.ts), a package of that id
 *  another workspace imported, or an unscoped request did, or one bundled here, is never replaced: the import is 409.
 *  Unscoped, one a workspace imported is never replaced either. */
async function replacedOf(deps: Pick<TemplateImportDeps, "registry" | "store">, id: string): Promise<string | null> {
  const held = deps.registry.get(id);
  if (!held) return null;
  const workspace = (await deps.store.importedTemplates.workspaces()).get(id);
  if (workspaceNow() !== undefined ? outOfScope(workspace) : typeof workspace === "string") throw nameTaken(id);
  return held.origin?.sha ?? null;
}

/** The import's row written in the request's workspace. The write keeps a row of another workspace (or, scoped, of none)
 *  (ImportedTemplates.put), so a name another import took between replacedOf's check and here is 409, as replacedOf's. */
async function keep(deps: { store: { importedTemplates: Pick<Store["importedTemplates"], "put"> } }, row: Parameters<Store["importedTemplates"]["put"]>[0]): Promise<void> {
  if (!(await deps.store.importedTemplates.put(row, workspaceNow()))) throw nameTaken(row.id);
}

/** An import's row kept and its package served, holding its name (TemplateNames) across both. */
async function kept(deps: Pick<TemplateImportDeps, "registry" | "store">, pkg: Package, row: Parameters<Store["importedTemplates"]["put"]>[0]): Promise<void> {
  await templateNames(deps.registry).hold(pkg.id, async () => {
    await keep(deps, row);
    deps.registry.put(pkg);
  });
}

/** A package made into an agent here as an imported template, from files this server wrote itself (a suggested agent's,
 *  suggestions.ts): checked, kept, then applied. Once `apply` has made the agent nothing after it can fail (the registry
 *  is in memory), so a thrown error always means no agent was made, which is what Suggestions.create reads it as. An
 *  apply refused (a missing model key, say) takes the kept package back as it was before (removed, or the earlier one),
 *  but only while the row is still the one this call kept: an import of the same id meanwhile (POST /v2/templates/import)
 *  stands. It holds the package's name (TemplateNames) from the keep to the registry's change. */
export async function applyImported<T>(
  deps: { registry: Pick<TemplateRegistry, "put">; store: { importedTemplates: Pick<Store["importedTemplates"], "list" | "put" | "remove"> }; apply: (pkg: Package) => Promise<T> },
  id: string,
  origin: { source: string; sha: string; publisher: string },
  files: ReadonlyMap<string, Buffer>,
): Promise<T> {
  return templateNames(deps.registry).hold(id, () => keptAndApplied(deps, id, origin, files));
}

async function keptAndApplied<T>(
  deps: { registry: Pick<TemplateRegistry, "put">; store: { importedTemplates: Pick<Store["importedTemplates"], "list" | "put" | "remove"> }; apply: (pkg: Package) => Promise<T> },
  id: string,
  origin: { source: string; sha: string; publisher: string },
  files: ReadonlyMap<string, Buffer>,
): Promise<T> {
  const pkg = await checkedImport(id, origin, files);
  const templates = deps.store.importedTemplates;
  const row = async () => (await templates.list()).find((one) => one.id === pkg.id);
  const before = await row();
  await keep({ store: { importedTemplates: templates } }, { id: pkg.id, source: origin.source, sha: origin.sha, publisher: origin.publisher, files: Object.fromEntries([...files].map(([path, data]) => [path, data.toString("base64")])) });
  // The row as this call kept it, stamped by the store: the undo below touches it only while it is still this one.
  const kept = await row();
  let made: T;
  try {
    made = await deps.apply(pkg);
  } catch (error) {
    const now = await row().catch(() => undefined);
    const ours = kept !== undefined && now !== undefined && now.importedAt === kept.importedAt && now.sha === kept.sha && now.source === kept.source;
    if (ours) {
      const undo = before
        ? templates.put({ id: before.id, source: before.source, sha: before.sha, publisher: before.publisher, files: before.files })
        : templates.remove(pkg.id).then(() => undefined);
      await undo.catch(() => {});
    }
    throw error;
  }
  deps.registry.put(pkg);
  return made;
}

/** DELETE /v2/templates/{id}: an imported package removed from the store and the registry. A bundled one is 403; none of
 *  that id, 404. Agents applied from it stay. In a workspace the store's delete is of that workspace's row alone, so a
 *  delete whose ownership read went stale (another workspace imported the freed name since) is 404 and removes nothing;
 *  the registry's copy goes only while it is still the package read here. The store's delete is of the row read here
 *  alone: one an import of the id replaced since (another process's, on a shared store) stands, kept, and a workspace's
 *  delete that lost to it is 404. In this process the delete holds the package's name (TemplateNames) from its first
 *  read to the registry's change, so an import here keeps its row and serves its package wholly before or after it. */
export async function deleteTemplate(deps: Pick<TemplateImportDeps, "registry" | "store">, id: string): Promise<void> {
  await templateNames(deps.registry).hold(id, () => deleted(deps, id));
}

async function deleted(deps: Pick<TemplateImportDeps, "registry" | "store">, id: string): Promise<void> {
  const pkg = deps.registry.get(id);
  if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
  if (pkg.origin === null) throw new ApiError("forbidden", `${id} ships with this server, so it can't be removed.`);
  const workspace = workspaceNow();
  // The row as read here: the store's delete takes it only while it is still this one, so an import of the id that
  // replaced it since (and puts its package in the registry after) is kept in both.
  const row = await deps.store.importedTemplates.stamp(id);
  const removed = row !== undefined && (await deps.store.importedTemplates.remove(id, workspace, row));
  if (workspace !== undefined && !removed) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
  if (deps.registry.get(id) === pkg) deps.registry.remove(id);
}
