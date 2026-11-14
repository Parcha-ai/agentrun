// POST /v2/templates/import and the imported packages' life here: read from GitHub (template-source.ts), checked by the one
// checker (templates.ts readPackage, over the files held in memory), stored (store `imported_templates`) and loaded beside
// the bundled packages at each start. The first import stored from a GitHub account needs its owner's "I trust <account>",
// remembered server-side (settings TRUSTED_PUBLISHERS). Nothing in a package runs.
import { ApiError, type InputIssue, invalid } from "./errors.js";
import type { Store } from "./store/index.js";
import { fetchPackageFiles, type GithubReach, type GithubSource, ImportRefused, IMPORT_LIMITS, parseSource, resolveSha } from "./template-source.js";
import { memoryFiles, type Package, PackageError, readPackage, type TemplateRegistry } from "./templates.js";
import { isObject, type Json, unknownFields } from "./validate.js";

/** The settings key that holds the GitHub accounts this server's owner trusts as publishers, lower-cased. */
export const TRUSTED_PUBLISHERS = "templates.trusted_publishers";

export type TemplateImportDeps = {
  registry: TemplateRegistry;
  store: Pick<Store, "importedTemplates" | "settings">;
  /** Where GitHub is read (template-source.ts GithubReach): GitHub's hosts and this server's App token when it has one. */
  reach: (signal: AbortSignal) => Promise<GithubReach>;
};

/** The folder name a package's id ends in: its path's last part, else the repository's name (agent.md's `name` is it). */
const nameOf = (id: string) => id.slice("github:".length).split("/").at(-1)!;

/** An imported package read from its files, checked whole, with its id and origin: PackageError when it does not check. */
export function importedPackage(id: string, origin: { source: string; sha: string; publisher: string }, files: ReadonlyMap<string, Buffer>): Package {
  const read = readPackage(memoryFiles(nameOf(id), `${id}@${origin.sha}`, files));
  return { ...read, id, origin };
}

/** The packages the store keeps, put in the registry beside the bundled ones; one this build no longer takes is left out,
 *  said through `skipped`, never a stop of the start. */
export async function loadImported(deps: Pick<TemplateImportDeps, "registry" | "store">, skipped: (id: string, why: string) => void): Promise<void> {
  for (const row of await deps.store.importedTemplates.list()) {
    try {
      const files = new Map(Object.entries(row.files).map(([path, data]) => [path, Buffer.from(data, "base64")]));
      deps.registry.put(importedPackage(row.id, { source: row.source, sha: row.sha, publisher: row.publisher }, files));
    } catch (error) {
      skipped(row.id, error instanceof PackageError ? error.problems.join("; ") : (error as Error).message);
    }
  }
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

/** The body POST /v2/templates/import takes, checked: 422 naming each field that is wrong. */
function bodyOf(body: Json): { source: GithubSource; dryRun: boolean; trustPublisher: boolean } {
  const issues = unknownFields(body, ["source", "dry_run", "trust_publisher"]);
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") issues.push({ field: "dry_run", reason: "wrong_type", message: "dry_run is true or false" });
  if (body.trust_publisher !== undefined && typeof body.trust_publisher !== "boolean") issues.push({ field: "trust_publisher", reason: "wrong_type", message: "trust_publisher is true or false" });
  if (typeof body.source === "string" && body.source.length > 1024) issues.push({ field: "source", reason: "too_long", message: "source is at most 1024 characters" });
  if (issues.length) throw invalid(issues);
  return { source: parseSource(body.source), dryRun: body.dry_run === true, trustPublisher: body.trust_publisher === true };
}

/** POST /v2/templates/import: the package read at its source's commit and checked; a dry run answers it, storing nothing;
 *  else it is stored and served (201), in place of the one under its id. `signal` ends the read (the request's). */
export async function importTemplate(deps: TemplateImportDeps, raw: unknown, signal: AbortSignal): Promise<{ status: 200 | 201; pkg: Package; trusted: boolean; replaced: string | null }> {
  if (!isObject(raw)) throw invalid([{ field: "body", reason: "wrong_type", message: "The body is {source, dry_run?, trust_publisher?}." }]);
  const { source, dryRun, trustPublisher } = bodyOf(raw);
  const read = AbortSignal.any([signal, AbortSignal.timeout(IMPORT_LIMITS.ms)]);
  let pkg: Package;
  let files: Map<string, Buffer>;
  try {
    const reach = await deps.reach(read);
    const sha = await resolveSha(source, reach, read);
    files = await fetchPackageFiles(source, sha, reach, read);
    pkg = importedPackage(source.id, { source: source.source, sha, publisher: source.owner }, files);
  } catch (error) {
    refusalOf(error);
  }
  const replaced = deps.registry.get(source.id)?.origin?.sha ?? null;
  const isTrusted = await trusted(deps, source.owner);
  if (dryRun) return { status: 200, pkg, trusted: isTrusted, replaced };
  if (!isTrusted && !trustPublisher) {
    throw invalid([{ field: "trust_publisher", reason: "missing", message: `${source.owner} has published no package this server has imported yet: read the package (a dry run shows it whole), then import it again with trust_publisher: true to say you trust ${source.owner}.`, fix: "Send trust_publisher: true." }]);
  }
  if (!isTrusted) await trust(deps, source.owner);
  await deps.store.importedTemplates.put({ id: pkg.id, source: pkg.origin!.source, sha: pkg.origin!.sha, publisher: pkg.origin!.publisher, files: Object.fromEntries([...files].map(([path, data]) => [path, data.toString("base64")])) });
  deps.registry.put(pkg);
  return { status: 201, pkg, trusted: true, replaced };
}

/** DELETE /v2/templates/{id}: an imported package removed from the store and the registry. A bundled one is 403; none of
 *  that id, 404. Agents applied from it stay. */
export async function deleteTemplate(deps: Pick<TemplateImportDeps, "registry" | "store">, id: string): Promise<void> {
  const pkg = deps.registry.get(id);
  if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
  if (pkg.origin === null) throw new ApiError("forbidden", `${id} ships with this server, so it can't be removed.`);
  await deps.store.importedTemplates.remove(id);
  deps.registry.remove(id);
}
