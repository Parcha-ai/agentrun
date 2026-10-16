import type { Workflow } from "./workflow.js";

/** A unit of work a host runs: the workflow, the input it runs on, and the files it starts with (by path, as bytes). */
export type Job = { workflow: Workflow; input: Record<string, unknown>; files?: Record<string, Uint8Array> };

/** Returns `job` itself. It checks the job's shape and keeps the workflow's literal type, so a job written beside a workflow
 *  declared `as const satisfies Workflow` still names the workflow's literal values. */
export function defineJob<const W extends Workflow>(job: { workflow: W; input: Record<string, unknown>; files?: Record<string, Uint8Array> }): typeof job {
  return job;
}
