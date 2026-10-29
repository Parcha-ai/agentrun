// The input a provider bills for a request beyond the bytes of its body, by the provider's API: one place for the figures
// and their sources, used by the model proxy's policies and by a host that bounds a request it sends itself. Written for
// AgentRun.
//
// A request's input can never be more tokens than its body's UTF-8 bytes (`inputTokensMaxOf`), except for what the
// provider adds or bills by another measure: a prompt it adds itself when tools are present, and images, which it bills by
// their area after it resizes them, not by their bytes. Each figure is the largest the provider documents for any current
// model, so no model is undercounted.

/** What of a request decides what its provider adds: whether it offers tools, how it asks for them, and its images. */
export interface InputShape {
  /** The request offers at least one tool. */
  tools: boolean;
  /** Its tool_choice, as Anthropic names them; absent for the provider's default. */
  toolChoice?: "auto" | "none" | "any" | "tool";
  /** Its image inputs, at any depth (a tool's result included). */
  images: number;
}

/**
 * The tool-use system prompt the Messages API adds to a request with tools, in tokens, by tool_choice. Documented per
 * model under "Pricing" in https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview, and taken at the largest
 * figure listed for any current model (Claude Opus 4.7's): 675 for auto or none, 804 for any or tool. None without tools.
 */
export const ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS = Object.freeze({ autoOrNone: 675, anyOrTool: 804 });

/**
 * The most tokens one image is billed as on the Messages API, whatever its bytes: Claude bills 28x28-pixel patches of the
 * image as it resized it. The largest "Max visual tokens" documented for any model in "Resolution and token cost",
 * https://platform.claude.com/docs/en/build-with-claude/vision: 4,784 on the high-resolution tier (Claude 4.7 and later),
 * against 1,568 on the standard tier.
 */
export const ANTHROPIC_IMAGE_TOKENS_MAX = 4_784;

/**
 * The most input tokens one image can be billed as on the Responses API, whatever its bytes. An image is covered by 32 px
 * patches, one over 30,000 patches is rejected, and its patches are multiplied by the model's multiplier, at most 2.46
 * among the models listed ("Calculating costs", https://developers.openai.com/api/docs/guides/images-vision). The guide
 * states no per-image maximum, so this is that ceiling: 30,000 x 2.46. The tile-based models cost less per image. The
 * Responses API documents no prompt of its own that it adds for tools.
 */
export const OPENAI_IMAGE_TOKENS_MAX = 73_800;

/**
 * The API kinds whose figures are known, as pi names them. Azure's and Codex's Responses are billed as OpenAI's.
 * Chat Completions ("openai-completions", which OpenAI-compatible gateways speak too) adds formatting tokens around each
 * message, 3 a message, 1 for a name, and 3 that prime the reply (num_tokens_from_messages in
 * https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken). Each message's own JSON in the
 * body ({"role":...,"content":...}) is more bytes than that, and so is the request's, so the byte bound covers them: it
 * adds nothing for them or for tools, whose definitions are in the body, and an image at OpenAI's per-image maximum. The
 * others in pi's union ("mistral-conversations", "bedrock-converse-stream", "google-generative-ai", "google-vertex",
 * "pi-messages") have no figure here: a request on them is unmeasured.
 */
export const INPUT_OVERHEAD_APIS: readonly string[] = Object.freeze(["anthropic-messages", "openai-responses", "azure-openai-responses", "openai-codex-responses", "openai-completions"]);

/**
 * The input tokens a provider bills for a request of `shape` beyond its body's bytes, on the API `api` (pi's names:
 * "anthropic-messages", "openai-responses", ...). Undefined for an API whose figures are not known here: a caller then
 * treats the request's input as unmeasured, never as adding nothing.
 */
export function providerInputOverhead(api: string, shape: InputShape): number | undefined {
  if (!Number.isSafeInteger(shape.images) || shape.images < 0) throw new Error(`not an image count: ${String(shape.images).slice(0, 40)}`);
  if (api === "anthropic-messages") {
    const prompt = !shape.tools ? 0 : shape.toolChoice === "any" || shape.toolChoice === "tool" ? ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.anyOrTool : ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.autoOrNone;
    return prompt + shape.images * ANTHROPIC_IMAGE_TOKENS_MAX;
  }
  if (INPUT_OVERHEAD_APIS.includes(api)) return shape.images * OPENAI_IMAGE_TOKENS_MAX;
  return undefined;
}
