/** Source metadata for an upload is descriptive; it never grants execution on the source machine. */
import { isAbsolute } from "node:path";
import { ApiError } from "../errors.js";
import type { SourceTarget } from "../native/source-snapshot-types.js";
import { isSourceRuntime, SOURCE_RUNTIME_FACTS, SOURCE_RUNTIMES } from "../native/runtimes.js";
import { sourceDeploymentOf } from "./types.js";

export const SOURCE_DEPLOYMENT_CAPABILITY = { version: 1, runtimes: SOURCE_RUNTIMES } as const;

export function assertSourceDeployed(body: unknown): void {
  if (sourceDeploymentOf(body)) throw new ApiError("agent_not_runnable", "Complete this agent's upload and deploy it before starting runs or editing its setup.");
}

export function sourceDeploymentTargetOf(value: unknown): SourceTarget {
  const b = value as SourceTarget;
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const list = (v: unknown, count: number, size: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(item => text(item, size));
  const nullable = (v: unknown): boolean => v === null || typeof v === "string" && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
  if (!b || typeof b !== "object" || !isSourceRuntime(b.runtime)
    || !text(b.project, 4096) || !isAbsolute(b.project) || !text(b.machine_id, 160)
    || !b.selector || !["project", "agent", "profile"].includes(b.selector.kind)
    || b.selector.kind !== "project" && (typeof b.selector.name !== "string" || !/^[\w.@+-]{1,160}$/.test(b.selector.name))
    || SOURCE_RUNTIME_FACTS[b.runtime].namedSelector === null && b.selector.kind !== "project"
    || !nullable(b.version) || !nullable(b.model) || typeof b.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(b.fingerprint)
    || !Array.isArray(b.configuration) || b.configuration.length > 2048
    || !b.configuration.every(file => file && text(file.path, 4096) && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256))
    || !list(b.skills, 2048, 256) || !list(b.mcp_servers, 256, 256) || !list(b.issues, 64, 4096)
    || !["ready", "needs_attention", "needs_verification"].includes(b.state)) {
    throw new ApiError("input_invalid", "Invalid source deployment target metadata.");
  }
  return {
    runtime: b.runtime, project: b.project, machine_id: b.machine_id,
    selector: { kind: b.selector.kind, ...(b.selector.kind !== "project" ? { name: b.selector.name } : {}) },
    version: b.version, model: b.model, fingerprint: b.fingerprint,
    configuration: b.configuration.map(file => ({ path: file.path, sha256: file.sha256 })),
    skills: [...b.skills], mcp_servers: [...b.mcp_servers], state: b.state, issues: [...b.issues],
    capabilities: { launch: false, learning: false, workflows: false, approval: "unavailable", usage: false },
  };
}
