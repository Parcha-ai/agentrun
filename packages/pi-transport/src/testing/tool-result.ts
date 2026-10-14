/** A text block as a model reads it. */
export type TextBlock = { type: "text"; text: string };

/** A tool's text result with both keys a pi-durable this package accepts may read. */
export type TextResult = { content: TextBlock[]; output: TextBlock[]; isError?: true };

/**
 * A tool's result as every pi-durable this package accepts reads it: up to 1.1 a tool result is `content`, from 1.2 it
 * is `output`. A result with only one of them reaches the model empty on the other, silently, so every tool this
 * package writes returns both.
 */
export function textResult(text: string, options?: { readonly isError?: boolean }): TextResult {
	const blocks: TextBlock[] = [{ type: "text", text }];
	return options?.isError === true
		? { content: blocks, output: blocks, isError: true }
		: { content: blocks, output: blocks };
}
