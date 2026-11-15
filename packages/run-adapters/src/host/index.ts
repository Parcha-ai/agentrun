// What a harness adapter runs beside its harness on the host: the session's model proxy, provider-neutral, with each
// provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { ANTHROPIC_IMAGE_TOKENS_MAX, ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS, ASSUMED_TOOL_PROMPT_TOKENS, anthropicImageTokens, GEMINI_HIGH_RESOLUTION_TOKENS, geminiImageTokens, imageInputOf, imageProviderOf, imageSizeOf, imageTokens, INPUT_OVERHEAD_APIS, LOCAL_COUNT_MARGIN, messagesImagesIn, messagesLocalInputTokens, OPENAI_IMAGE_TOKENS_MAX, openaiImageTokens, openaiPatchMultiplier, providerInputOverhead, responsesEscapedBytes, responsesImagesIn, responsesInputOverhead, responsesLocalInputTokens, type ImageInput, type InputShape } from "./overhead.js";
export { O200K_SHA256, O200K_VOCABULARY, o200kModel, o200kTokens } from "./o200k.js";
export { COUNT_TIMEOUT_MS, countedInputOf, CredentialUnavailable, localInputOf, hostHeaderProblems, lastObjectOf, NATIVE_SEARCH_USD, ProxyRefusal, ROUTE_ORIGIN, sameKey, startModelProxy, statesUsageCost, streamErrorOf, usageCostOf } from "./proxy.js";
export type { InputCounter, ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRequest, ProxyRequestContext, ProxyRoute, ProxyUsage, StreamError } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
export { PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from "./parent-death.js";
export type { LaunchCommand, ParentWatch } from "./parent-death.js";
export { BoxError } from "./box.js";
export type { BoxErrorCode, BoxRecord } from "./box.js";
export { type BinaryCheck, type BinaryProbe, checkedOnce, checkedOnceAsync, sha256OfFile, sha256OfFileAsync } from "./pinned-binary.js";
