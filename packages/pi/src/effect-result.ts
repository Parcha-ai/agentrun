// The boundary where a pi tool's result becomes a workflow call's effect result. It imports only the DSL, so the plain
// extension and the durable host both use it.
import { RecoveryError } from "@parcha/agentrun-dsl/recovery";

/** A tool's result at a workflow call's effect boundary. A call `reuseReceipts` refused (an identical earlier call was cut
 *  while it ran, `details.effect_status` "unknown") is an effect whose outcome is unknown, so it becomes the DSL's one
 *  signal for that: a thrown `RecoveryError` with code `FROZEN_EFFECT_UNKNOWN`, the refusal its cause. Any other result
 *  is the effect's result, returned as it is. */
export function effectResultOf<T>(result: T, label: string): T {
  const details = (result as { details?: { effect_status?: unknown } } | null | undefined)?.details;
  if (details?.effect_status === "unknown") {
    throw new RecoveryError(`${label}: an identical earlier call was cut while it ran, so whether it happened is unknown`, "FROZEN_EFFECT_UNKNOWN", { cause: result });
  }
  return result;
}
