// Eyes on a pi-ai model the host builds: one `complete` request a look, thinking at the level the host names, cut at
// `SEE_TIMEOUT_MS`, with its usage and price on the answer. The host keeps the credential: it passes a function that
// returns the key at each request, and nothing the eyes return carries it.
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Eyes } from "../core/host.js";
import type { LimitsOverride } from "../core/limits.js";
import { notBuilt } from "../core/not-built.js";

export type PiAiEyesOptions = {
  /** The key for each request, read when the request is made. */
  readonly apiKey?: () => string | undefined;
  /** pi's thinking level for the look; every look thinks. */
  readonly reasoning?: string;
  /** The host's view of each request's payload before it is sent. */
  readonly onPayload?: (payload: unknown) => unknown;
  /** Default `SEE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Over the model's own `inputLimits`. */
  readonly limits?: LimitsOverride;
};

export function piAiEyes(model: Model<Api>, options: PiAiEyesOptions = {}): Eyes {
  return notBuilt("piAiEyes");
}
