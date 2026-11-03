// A run's profile pack (`profile`, `output` on POST /agents/{id}/runs), checked and resolved when the run is made: the
// pack (a shipped pack by name, a pack object, or the shipped `default` for an `output` alone), read for the run's effort
// and output (packs.ts resolvePack), and each of its skills found on the agent's revision first, else among the shipped
// pack's bundled skills. What is pinned in serve.json, and the bundled skills to stage, or the issues by field (422).
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Revision } from "@parcha/pi-durable-agent";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import type { PinnedProfile } from "./mandate.js";
import type { Effort } from "./model.js";
import { packIssues, resolvePack, shippedPacks, type Pack } from "./packs.js";
import { isObject, type Json, skillNames } from "./validate.js";

/** A pack this server ships that names skills its build does not ship: this server's packaging error, a 500 that says it
 *  is not retryable, since the same build answers a retry the same way. */
class PackagingError extends ApiError {
  constructor(pack: string, skills: string[]) {
    super("internal", `This server's pack ${pack} names the skill${skills.length > 1 ? "s" : ""} ${skills.join(", ")}, which its build does not ship: a packaging error in this server, not in the request.`, { details: { pack, skills } });
  }

  override body(requestId: string): { error: Record<string, unknown> } {
    return { error: { ...super.body(requestId).error, retryable: false } };
  }
}

/** A run's resolved profile: what serve.json pins, and the shipped pack's skills it stages (each a directory). */
export type RunProfile = { pinned: PinnedProfile; bundled: { name: string; dir: string }[] };

/** The profile `body` asks for on `revision`, or undefined when it names neither `profile` nor `output`: a run as before.
 *  Throws a 422 naming each field it cannot use. */
export function runProfileOf(body: Json, revision: Revision): RunProfile | undefined {
  if (body.profile === undefined && body.output === undefined) return undefined;
  const asked = (["profile", "output"] as const).filter((field) => body[field] !== undefined);
  if (revision.kind === "workflow") throw invalid(asked.map((field) => ({ field, reason: "not_allowed", message: "A workflow run takes no profile: its workflow names what each node loads." })));
  const shipped = shippedPacks();
  const names = [...shipped.keys()];
  const issues: InputIssue[] = [];
  if (body.output !== undefined && typeof body.output !== "string") issues.push({ field: "output", reason: "wrong_type", message: "output is an output type of the profile" });
  let pack: Pack | undefined;
  let skillsDir: string | undefined;
  if (typeof body.profile === "string") {
    const entry = shipped.get(body.profile);
    if (entry) ({ pack, skillsDir } = entry);
    else issues.push({ field: "profile", reason: "not_an_option", message: `profile is a pack this server ships (${names.length ? names.join(", ") : "it ships no pack"}) or a pack object` });
  } else if (isObject(body.profile)) {
    const wrong = packIssues(body.profile, { at: "profile" });
    if (wrong.length) issues.push(...wrong);
    else pack = body.profile as unknown as Pack;
  } else if (body.profile !== undefined) {
    issues.push({ field: "profile", reason: "wrong_type", message: "profile is the name of a pack this server ships, or a pack object" });
  } else if (shipped.has("default")) {
    ({ pack, skillsDir } = shipped.get("default")!);
  } else {
    issues.push({ field: "output", reason: "not_an_option", message: "output names an output type of a profile pack, and this server ships no default one: name the pack in profile" });
  }
  if (issues.length || !pack) throw invalid(issues);
  const effort = (typeof body.effort === "string" ? body.effort : "medium") as Effort;
  const resolved = resolvePack(pack, { effort, ...(typeof body.output === "string" ? { output: body.output } : {}) });
  if ("issues" in resolved) throw invalid(resolved.issues);
  // The caller's own skill wins: a skill the revision holds is never taken from the pack.
  const own = new Set(skillNames(Object.keys(revision.body.skills)));
  const bundled: RunProfile["bundled"] = [];
  const unshipped: string[] = [];
  const field = body.profile === undefined ? "output" : "profile";
  for (const name of resolved.skills) {
    if (own.has(name)) continue;
    const dir = skillsDir === undefined ? undefined : join(skillsDir, name);
    if (dir && existsSync(join(dir, "SKILL.md"))) bundled.push({ name, dir });
    // A pack this server ships names a skill its build does not ship: this server's packaging, which no request fixes.
    else if (skillsDir !== undefined) unshipped.push(name);
    else issues.push({ field, reason: "missing", message: `the profile ${pack.name} names the skill ${name}, which neither the agent's revision nor the profile holds: add ${name}/SKILL.md to the agent's skills` });
  }
  if (unshipped.length) throw new PackagingError(pack.name, unshipped);
  if (issues.length) throw invalid(issues);
  const { effort: row, thinking, skills, output } = resolved;
  const pinned: PinnedProfile = { name: pack.name, effort: row, ...(thinking ? { thinking } : {}), skills, ...(output ? { output } : {}) };
  return { pinned, bundled };
}

/**
 * Each bundled skill's files copied into the run's workspace (`work/.agents/skills/<name>/...`), beside the revision's that
 * startRun seeded, before the run's process exists; the paths staged, below .agents/skills. A file is created, never
 * written over: a revision's skill of the same name is never bundled (runProfileOf), and a file already in the workspace
 * stays as it is. Only the pack's regular files are copied, never a link in its directory.
 */
export async function stageSkills(workspace: string, bundled: RunProfile["bundled"]): Promise<string[]> {
  const staged: string[] = [];
  for (const { name, dir } of bundled) {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
      const target = join(workspace, ".agents", "skills", name, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      const made = await copyFile(join(dir, ...path.split("/")), target, constants.COPYFILE_EXCL).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      });
      if (made) staged.push(`${name}/${path}`);
    }
  }
  return staged.sort();
}
