// What a stopped request streamed, as the cap counts it: each UTF-8 byte a token (a byte-level tokenizer never makes a
// token of less than one byte), its text, its thinking, and each tool call's name and arguments; and the part of a hidden
// reasoning budget it did not stream, which the provider may have spent before the stop. The figure books through
// booking.ts's `stopped` rule (its input, these tokens and the stop's allowance, within its output limit and its hold).

type Blocks = { content?: unknown } | undefined;
const blocksOf = (message: Blocks): Array<Record<string, unknown> | null> => (Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown> | null>) : []);

/** What a model answer streamed, in bytes: its text, its thinking, and each tool call's name and arguments as JSON. */
export function streamedBytes(message: Blocks): number {
  let bytes = 0;
  for (const block of blocksOf(message)) {
    if (typeof block?.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
    if (typeof block?.thinking === "string") bytes += Buffer.byteLength(block.thinking, "utf8");
    if (block?.type === "toolCall") bytes += Buffer.byteLength(`${typeof block.name === "string" ? block.name : ""}${JSON.stringify(block.arguments ?? {})}`, "utf8");
  }
  return bytes;
}

/** What of a model answer's reasoning streamed, in bytes: its thinking blocks. */
export function reasoningBytes(message: Blocks): number {
  let bytes = 0;
  for (const block of blocksOf(message)) if (typeof block?.thinking === "string") bytes += Buffer.byteLength(block.thinking, "utf8");
  return bytes;
}

/** The tokens a stopped request counts before the stop's allowance: what it streamed and the unstreamed part of its
 *  reasoning budget, within its output limit. A reasoning budget no one knows (a reasoning model sent with no level: its
 *  reasoning hidden, its effort unknown) is its whole output limit. */
export function stoppedTokens({ streamedBytes: streamed, reasoningBytes: reasoning, reasoningBudget, outputLimit }: { streamedBytes: number; reasoningBytes: number; reasoningBudget: number | "unknown"; outputLimit: number }): number {
  if (reasoningBudget === "unknown") return outputLimit;
  return Math.min(outputLimit, streamed + Math.max(0, reasoningBudget - reasoning));
}
