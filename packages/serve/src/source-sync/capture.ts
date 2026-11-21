/** Move changes execution, not the source's evidence identity. Only this retained, enrolled revision may receive
 * source prompt windows; it never adopts the managed revision's tools, permissions or workflow execution. */
import type { AgentEntry } from "../agents-store.js";
import { cliLearningOf, type CliLearningBinding } from "../store/agent-body.js";
import type { RevisionRow, Store } from "../store/store.js";
import { sourceKey, type SourceRecord } from "./registry.js";
import { sourceSyncOf } from "./types.js";

export async function cliCaptureOf(store: Pick<Store, "agents" | "settings">, entry: AgentEntry): Promise<{
  revision: RevisionRow; binding: CliLearningBinding; source?: SourceRecord;
} | undefined> {
  if (!entry.revision) return undefined;
  const own = cliLearningOf(entry.revision.body);
  if (own) return { revision: entry.revision, binding: own };
  const moved = sourceSyncOf(entry.revision.body);
  if (!moved) return undefined;
  const source = await store.settings.get(sourceKey(entry.agent.id)) as SourceRecord | undefined;
  if (!source || source.id !== moved.id || source.agent_id !== entry.agent.id) return undefined;
  const revision = await store.agents.revision(source.capture_revision);
  const binding = cliLearningOf(revision?.body);
  if (!revision || revision.agentId !== entry.agent.id || !binding || binding.runtime !== source.source.runtime
    || binding.project !== source.source.project || source.source.selector.kind !== "project") return undefined;
  return { revision, binding, source };
}
