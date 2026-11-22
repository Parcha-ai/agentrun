// Each model request a claim sends to serve's model gateway (AGENT_MODEL_BASE_URL, or ANTHROPIC_BASE_URL on its origin)
// names the run, the turn and the attempt it was made for, so the gateway's own record of each call (LiteLLM's spend
// logs) can be matched to the run's usage lines (run-usage.ts) call by call, and a cut attempt's calls told apart from
// the turn's billable ones. It goes as LiteLLM's spend-logs metadata header, a JSON object LiteLLM keeps on the call's
// spend-log row (its `metadata.spend_logs_metadata`); a gateway that is not LiteLLM ignores an unknown header. Never to a
// vendor's own endpoint (Anthropic's, OpenAI's, OpenRouter's): those keep no record of ours, and a run id is ours.
//
// The claim sets it on its model routes' env (claimModelEnv), never enumerable, as a key is: a spread of that env, or a
// process spawned with it, carries none of it. The routes read it by name (provider.ts gatewayProvider), so a run's
// every request on the gateway carries it: its harness's, its subagents', its learned nodes'.
import type { Claim } from "./store/index.js";

/** The env name a claim's model routes read the metadata from: the JSON the header carries. */
export const REQUEST_METADATA_ENV = "AGENTRUN_REQUEST_METADATA";
/** LiteLLM's header for metadata it keeps on a call's spend-log row (LiteLLM v1.110.0 and later). */
export const SPEND_LOGS_METADATA_HEADER = "x-litellm-spend-logs-metadata";

/** What one claim's requests say of themselves: the run, the turn the claim works and its attempt at it (store
 *  run_attempts). Keys are prefixed, as a spend log row holds the metadata of every caller of the gateway. */
export type RequestMetadata = { agentrun_run_id: string; agentrun_turn?: number; agentrun_attempt?: number };

/** The metadata of `claim`'s requests: its run, and its turn and attempt where its store keeps them. */
export function requestMetadataOf(claim: Pick<Claim, "runId" | "turn" | "attempt">): RequestMetadata {
  return { agentrun_run_id: claim.runId, ...(claim.turn !== undefined ? { agentrun_turn: claim.turn } : {}), ...(claim.attempt !== undefined ? { agentrun_attempt: claim.attempt } : {}) };
}

/** `env` with `claim`'s request metadata on it, by name and never enumerable (as a model key is); `env` itself when there
 *  is no claim. The same object is changed and returned: a claim's model env is its own (claimModelEnv makes it). */
export function withRequestMetadata(env: NodeJS.ProcessEnv, claim: Pick<Claim, "runId" | "turn" | "attempt"> | undefined): NodeJS.ProcessEnv {
  if (!claim) return env;
  Object.defineProperty(env, REQUEST_METADATA_ENV, { value: JSON.stringify(requestMetadataOf(claim)), enumerable: false, writable: true, configurable: true });
  return env;
}

/** The headers a request to serve's gateway carries from `env`: the spend-logs metadata, when the claim set it and it is
 *  one line of JSON an HTTP header can carry (the proxy's own bound on a host's header, 1024 characters). None else. */
export function gatewayHeadersOf(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> | undefined {
  const value = env[REQUEST_METADATA_ENV];
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[^\x20-\x7e]/.test(value)) return undefined;
  return { [SPEND_LOGS_METADATA_HEADER]: value };
}
