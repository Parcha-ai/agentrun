/** An existing source credential may prove association, never choose an arbitrary destination agent. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getAgent } from "../agents-store.js";
import type { CliLearningConnections } from "../cli-learning/connections.js";
import { ApiError } from "../errors.js";
import type { NativeBinding } from "../native/types.js";
import { canonical, isObject } from "../store/agent-body.js";
import type { SettingsGuard, Store } from "../store/store.js";
import { cliCaptureOf } from "./capture.js";

export type CliAdoption = { connection_id: string; credential_epoch: string; proof: string };
export type VerifiedAdoption = { agentId: string; connectionId: string; guards: readonly SettingsGuard[] };
export type AdoptionResolver = (connectorId: string, targetId: string, target: NativeBinding, input: unknown) => Promise<VerifiedAdoption>;

export function cliAdoptionResolver(store: Store, connections: CliLearningConnections): AdoptionResolver {
  return async (connectorId, targetId, target, input) => {
    const refuse = (): never => { throw new ApiError("forbidden", "The existing CLI connection did not authorize this source association. Connect on the same server from its source machine."); };
    if (!isObject(input) || Object.keys(input).some(key => !["connection_id", "credential_epoch", "proof"].includes(key))
      || typeof input.connection_id !== "string" || typeof input.credential_epoch !== "string" || !/^[a-f0-9]{64}$/.test(input.credential_epoch)
      || typeof input.proof !== "string" || !/^[a-f0-9]{64}$/.test(input.proof)) return refuse();
    const row = await connections.get(input.connection_id).catch(error => {
      if (error instanceof ApiError && error.code === "not_found") return undefined;
      throw error;
    });
    if (!row?.active || row.runtime !== target.runtime || row.project !== target.project || row.native.machine_id !== target.machine_id
      || canonical(row.native.selector) !== canonical(target.selector) || target.selector.kind !== "project") return refuse();
    const token = connections.token(row);
    const epoch = createHash("sha256").update(token).digest("hex");
    const message = JSON.stringify(["agentrun-source-sync-adoption-v1", connectorId, targetId, row.connection_id, epoch,
      target.runtime, target.machine_id, target.project, target.selector.kind, target.selector.name ?? null]);
    const expected = createHmac("sha256", token).update(message).digest();
    if (input.credential_epoch !== epoch || !timingSafeEqual(expected, Buffer.from(input.proof, "hex"))) return refuse();
    const entry = await getAgent(store, row.agent_id);
    const capture = entry && await cliCaptureOf(store, entry);
    if (!entry || entry.agent.archivedAt || entry.agent.purgedAt || capture?.binding.connection_id !== row.connection_id) return refuse();
    return { agentId: row.agent_id, connectionId: row.connection_id,
      guards: [{ key: `cli-learning-connection:${row.connection_id}`, fields: { active: true, generation: row.generation, agent_id: row.agent_id } }] };
  };
}
