// The boundary where a pi tool's result becomes a workflow call's effect result. It imports only the DSL, so the plain
// extension and the durable host both use it.
import { RecoveryError } from "@parcha/agentrun-dsl/recovery";

/** A tool's result at a workflow call's effect boundary. A call `reuseReceipts` refused (an identical earlier call was cut
 *  while it ran) is an effect whose outcome is unknown, so it becomes the DSL's one signal for that: a thrown
 *  `RecoveryError` with code `FROZEN_EFFECT_UNKNOWN`, the refusal its cause. A refusal is keyed by the exact shape only
 *  `reuseReceipts` writes — `{ isError: true, details: { effect_status: "unknown", refused: true } }` — not by
 *  `effect_status: "unknown"` alone, which an ordinary tool (an inconclusive classifier) may carry in its own answer.
 *  Any other result is the effect's result, returned as it is. */
export function effectResultOf<T>(result: T, label: string): T {
  const row = result as { isError?: unknown; details?: { effect_status?: unknown; refused?: unknown } } | null | undefined;
  const details = row?.details;
  if (row?.isError === true && details?.effect_status === "unknown" && details?.refused === true) {
    throw new RecoveryError(`${label}: an identical earlier call was cut while it ran, so whether it happened is unknown`, "FROZEN_EFFECT_UNKNOWN", { cause: result });
  }
  return result;
}
