/** Source-side deployment preparation. This module performs bounded local discovery and snapshot capture only;
 * authentication, destination selection and upload belong to the CLI. No source model task is started. */
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { selectedNative } from "./native/connection.js";
import { nativeMachineId, nativeMetadata } from "./native/discovery.js";
import { isNativeRuntime, SOURCE_RUNTIME_FACTS } from "./native/runtimes.js";
import { exportSourceSnapshot, SourceSnapshotError } from "./native/source-snapshot.js";
import { isSourceRuntime, type SourceRuntime, type SourceTarget, type SourceSnapshot } from "./native/source-snapshot-types.js";
import type { NativeSelector } from "./native/types.js";
import { runnerSecrets } from "./runner/redact.js";

export type DeploymentSourceOptions = {
  project: string;
  runtime: SourceRuntime;
  selector?: NativeSelector;
  environment?: NodeJS.ProcessEnv;
  secretValues?: readonly string[];
  signal?: AbortSignal;
};

async function setupTarget(runtime: SourceRuntime, project: string, selector: NativeSelector, environment: NodeJS.ProcessEnv): Promise<SourceTarget> {
  if (selector.kind !== "project" || selector.name !== undefined) throw new SourceSnapshotError("source_unavailable", "Select a Pi project; custom agent selectors need an explicit portable configuration.");
  let executable: string | undefined;
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, SOURCE_RUNTIME_FACTS[runtime].binary);
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* next installed executable */ }
  }
  const version = executable ? await nativeMetadata(executable, ["--version"], project, environment) : undefined;
  const number = version?.code === 0 ? version.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=$|\s|\()/)?.[1] ?? null : null;
  const machine_id = await nativeMachineId();
  return { runtime, project, selector, machine_id, version: number, model: null,
    fingerprint: createHash("sha256").update(JSON.stringify([runtime, project, selector, machine_id, number])).digest("hex"),
    configuration: [], skills: [], mcp_servers: [], state: "needs_verification", issues: [],
    capabilities: { launch: false, learning: true, workflows: false, approval: "unavailable", usage: false } };
}

export async function deploymentSource(options: DeploymentSourceOptions): Promise<{ target: SourceTarget; snapshot: SourceSnapshot }> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new SourceSnapshotError("unsupported_platform", "Whole-setup deployment requires Linux or macOS (with Python 3).");
  if (!isSourceRuntime(options.runtime) || typeof options.project !== "string" || !options.project.trim())
    throw new SourceSnapshotError("source_unavailable", "Select a project and its Claude Code, Codex or Pi source runtime.");
  const environment = { ...(options.environment ?? process.env) }, selector = options.selector ?? { kind: "project" as const };
  const home = environment.HOME || homedir(), project = resolve(options.project);
  const facts = SOURCE_RUNTIME_FACTS[options.runtime], explicit = environment[facts.homeEnvironment];
  const paths = [project, home, ...(explicit ? [explicit] : [])];
  if (paths.some(path => !isAbsolute(path))) throw new SourceSnapshotError("source_unavailable", "Source project and profile folders must have absolute paths.");
  const roots = [];
  for (const path of paths) {
    const canonical = await realpath(path), info = await stat(canonical, { bigint: true });
    if (!info.isDirectory()) throw new SourceSnapshotError("source_unavailable", "A selected source project or profile is not a directory.");
    roots.push({ path: canonical, device: info.dev.toString(), inode: info.ino.toString() });
  }
  const sourceProject = roots[0]!.path, sourceHome = roots[1]!.path;
  environment.HOME = sourceHome;
  if (explicit) environment[facts.homeEnvironment] = roots[2]!.path;
  const target: SourceTarget = isNativeRuntime(options.runtime)
    ? await selectedNative({ project: sourceProject, runtime: options.runtime, selector }, environment)
    : await setupTarget(options.runtime, sourceProject, selector, environment);
  const snapshot = await exportSourceSnapshot({ target, home: sourceHome, environment,
    authorizedRoots: [...new Set(roots.map(root => root.path))], expectedRoots: [...new Map(roots.map(root => [root.path, root])).values()],
    ...(roots[2] ? { [facts.homeOption]: roots[2].path } : {}),
    secretValues: runnerSecrets(environment, options.secretValues), signal: options.signal });
  // A deployment grant has setup authority only, even when the local discovery knows how to launch its source.
  return { target: { ...target, model: snapshot.configuration.model, skills: snapshot.skills.map(skill => skill.name),
    mcp_servers: snapshot.configuration.tools.map(tool => tool.name), capabilities: { ...target.capabilities, launch: false, approval: "unavailable" } }, snapshot };
}
