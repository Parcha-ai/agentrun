/** A text block as a model reads it. */
export type TextBlock = { type: "text"; text: string };

/** A tool's text result, its blocks under `output`, the key pi-durable reads. */
export type TextResult = { output: TextBlock[]; isError?: true };

/** A tool's text result as pi-durable reads it. */
export function textResult(text: string, options?: { readonly isError?: boolean }): TextResult {
	const blocks: TextBlock[] = [{ type: "text", text }];
	return options?.isError === true ? { output: blocks, isError: true } : { output: blocks };
}
