import { createHmac } from "node:crypto";

export type CliLearningReadiness = "ready" | "setup_required" | "unknown" | "unsupported";
export type CliLearningObservationScope = {
  connector_id: string;
  source_id: string;
  external_session_id: string;
  runtime: "codex" | "claude-code";
  connection_id: string;
  readiness: CliLearningReadiness;
  native_session_hash: string;
  sequence: number;
};

/** Prove possession of the existing project/runtime credential without sending it with observation metadata.
 * The source must first match its canonical project and server origin to the private connection record. */
export function cliLearningObservationProof(token: string, scope: CliLearningObservationScope): string {
  return createHmac("sha256", token).update(JSON.stringify([
    "agentrun-cli-learning-observation-v1",
    scope.connector_id, scope.source_id, scope.external_session_id, scope.runtime,
    scope.connection_id, scope.readiness, scope.native_session_hash, scope.sequence,
  ])).digest("hex");
}
