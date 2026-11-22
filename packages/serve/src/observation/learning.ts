import { createHash, timingSafeEqual } from "node:crypto";
import { getAgent } from "../agents-store.js";
import { CliLearningConnections } from "../cli-learning/connections.js";
import { cliLearningObservationProof, type CliLearningObservationScope, type CliLearningReadiness } from "../cli-learning/observation-proof.js";
import { learnsOf } from "../learning-setting.js";
import { cliLearningOf, learningSettingForBody } from "../store/agent-body.js";
import type { Store } from "../store/store.js";
import type { RunLaunch } from "../run-launch.js";

export type LearningReport = {
  readiness: CliLearningReadiness;
  connection_id?: string;
  native_session_hash?: string;
  proof?: string;
};
/** Persist only verified identifiers and the generation that authorized them, never credentials or proofs. */
export type LearningAssociation = {
  readiness: CliLearningReadiness;
  connection_id?: string;
  native_session_hash?: string;
  generation?: string;
};
export type ObservedLearning = {
  state: "on" | "off" | "setup_required" | "unknown" | "unsupported";
  reason: "ready" | "source_setup_required" | "source_unknown" | "delegated_session" | "connection_unavailable" | "server_disabled" | "agent_disabled" | "awaiting_activation";
  agent_id?: string;
  connection_id?: string;
  mode?: "off" | "notes" | "corrections" | "workflows";
};

export class ObservationLearning {
  constructor(private readonly store: Store, private readonly connections: CliLearningConnections, private readonly enabled = true) {}

  async verify(report: LearningReport, scope: Omit<CliLearningObservationScope, "connection_id" | "readiness" | "native_session_hash">): Promise<LearningAssociation> {
    if (!report.connection_id) return { readiness: report.readiness };
    const row = await this.connections.get(report.connection_id).catch(() => undefined);
    if (!row?.active || row.runtime !== scope.runtime || !report.proof || !report.native_session_hash) return { readiness: "unknown" };
    const expected = cliLearningObservationProof(this.connections.token(row), { ...scope, connection_id: row.connection_id, readiness: report.readiness, native_session_hash: report.native_session_hash });
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(report.proof, "hex"))) return { readiness: "unknown" };
    return { readiness: report.readiness, connection_id: row.connection_id, generation: row.generation, native_session_hash: report.native_session_hash };
  }

  async view(association: LearningAssociation | undefined, runtime: "codex" | "claude-code"): Promise<ObservedLearning> {
    const readiness = association?.readiness ?? "unknown";
    if (!association?.connection_id) return unboundLearning(readiness);
    const row = await this.connections.get(association.connection_id).catch(() => undefined);
    if (!row?.active || row.generation !== association.generation || row.runtime !== runtime) return { state: "unknown", reason: "connection_unavailable" };
    const entry = await getAgent(this.store, row.agent_id);
    const binding = cliLearningOf(entry?.revision?.body);
    if (!entry || entry.agent.archivedAt != null || !binding || binding.connection_id !== row.connection_id || binding.runtime !== runtime || binding.project !== row.project) return { state: "unknown", reason: "connection_unavailable" };
    // Source hooks deliver owner corrections; they do not expose a workflow execution bridge.
    const mode = learnsOf(learningSettingForBody(entry.revision!.body)) ? "corrections" : "off";
    const linked = { agent_id: row.agent_id, connection_id: row.connection_id, mode } as const;
    if (!this.enabled) return { state: "off", reason: "server_disabled", ...linked };
    if (mode === "off") return { state: "off", reason: "agent_disabled", ...linked };
    if (readiness !== "ready") return { ...unboundLearning(readiness), ...linked };
    let activated = Boolean(association.native_session_hash && row.hook_sessions?.[association.native_session_hash]);
    // Older connections already have a last-window receipt. It proves activation only for that exact
    // native session and current credential generation; another session in the project proves nothing.
    if (!activated && row.last_run_id) {
      const launch = await this.store.runs.launch(row.last_run_id).catch(() => undefined);
      const window = (launch?.body as unknown as RunLaunch | undefined)?.cli_learning;
      activated = Boolean(window && window.connection_id === row.connection_id && window.connection_generation === row.generation
        && createHash("sha256").update(window.session_id).digest("hex") === association.native_session_hash);
    }
    if (!activated) return { state: "unknown", reason: "awaiting_activation", ...linked };
    return { state: "on", reason: "ready", ...linked };
  }
}

export function unboundLearning(readiness: CliLearningReadiness = "unknown"): ObservedLearning {
  if (readiness === "setup_required") return { state: "setup_required", reason: "source_setup_required" };
  if (readiness === "unsupported") return { state: "unsupported", reason: "delegated_session" };
  return { state: "unknown", reason: "source_unknown" };
}
