// The adapter a harness id runs on. With a faux harness module (FAUX_HARNESS_ENV), every id runs on run-adapters' faux
// harness, scripted by the module's `script(spec)`, as `--faux` runs pi on the faux model.
import { pathToFileURL } from "node:url";
import type { AgentAdapter, SessionSpec } from "@parcha/agentrun-adapters";
import { FAUX_HARNESS_ENV } from "./harness.js";

export async function adapterFor(harness: string, env: NodeJS.ProcessEnv): Promise<AgentAdapter> {
  const faux = env[FAUX_HARNESS_ENV];
  if (faux) {
    const [{ fauxAdapter }, module] = await Promise.all([import("@parcha/agentrun-adapters/testing"), import(pathToFileURL(faux).href) as Promise<{ script?: (spec: SessionSpec) => never[] }>]);
    if (typeof module.script !== "function") throw new Error(`${FAUX_HARNESS_ENV} names ${faux}, which exports no script(spec)`);
    return fauxAdapter({ script: module.script });
  }
  throw new Error(`This server does not run ${harness} yet.`);
}
