// A local count of a Responses request's input tokens, for a route that has no count of the provider's own: a gateway, a
// base other than OpenAI's, or a count that failed. Written for AgentRun.
//
// The byte bound (`inputTokensMaxOf`) is a proof: a byte-level BPE token covers at least one byte, so a body is never
// more tokens than bytes. It is also four times what an English prompt bills, and on a capped run that is the difference
// between going on and parking (a $0.50 lead list whose request 7 holds $0.35 at its least on its bytes, $0.12 on its
// count). Where the provider counts (OpenAI's /v1/responses/input_tokens, straight to it) its count is used; where it
// cannot, this counts the body with o200k_base, the vocabulary OpenAI publishes for its models from gpt-4o on, plus a
// stated margin (`LOCAL_COUNT_MARGIN`). A body this cannot count with a margin it can state (a model on another
// tokenizer, a file input) has no local count, and keeps its byte bound.
import { imageInputOf, imageTokens } from "./overhead.js";

/**
 * The margin a local count adds, and why each part:
 *  - `share`, 10% of the counted tokens: the count is o200k_base's, the vocabulary tiktoken names for gpt-4o, gpt-4.1,
 *    gpt-4.5, gpt-5, the o-series and gpt-oss (MODEL_PREFIX_TO_ENCODING,
 *    https://github.com/openai/tiktoken/blob/79dc2c0533685b893616c78160b5d9e40876e724/tiktoken/model.py#L7-L37). A later
 *    model that bills by a revised vocabulary may split some text finer; a tenth more covers a revision of that order.
 *  - `perItem`, 16 tokens for each input item, each tool and the instructions: the framing the provider renders around
 *    each (harmony's `<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>`, some 12
 *    tokens, https://github.com/openai/harmony/blob/e0ce87d1c3b9f59dec2e27de4770c769f03ebbd3/docs/format.md), beside
 *    the cookbook's 3 a message (num_tokens_from_messages,
 *    https://github.com/openai/openai-cookbook/blob/db3144982aa26b87a9bdfb692b4fbedfdf8a14d5/examples/How_to_count_tokens_with_tiktoken.ipynb).
 *  - `perRequest`, 256 tokens: the system message the provider writes itself (harmony's identity, dates, reasoning level
 *    and channels, some 60 tokens), the tools' namespace header and the reply's priming.
 * The count is of the body as sent, its JSON keys, ids, quotes and escapes included, which the provider bills none of as
 * text: that slack is on top of the margin. What the tokenizer cannot see is counted as the byte bound counts it: an
 * encrypted reasoning or compaction item's `encrypted_content` at its bytes (its plaintext is billed, and a byte bounds a
 * token), and each image at the most its provider bills it as (`imageTokens`), never at its base64.
 */
export const LOCAL_COUNT_MARGIN = Object.freeze({ share: 0.1, perItem: 16, perRequest: 256 });

/** Model ids, as a session or a gateway names them (`openai/gpt-6.1-sol`), whose tokenizer is o200k_base: gpt-4o, gpt-4.1,
 *  gpt-4.5, gpt-5 and later, chatgpt-4o, the o-series, codex- and gpt-oss models. gpt-3.5 and gpt-4 (cl100k_base) are
 *  not, nor any other vendor's model: o200k_base can undercount them. */
const O200K_MODEL = /^(?:openai\/)?(?:gpt-(?:4o|4\.1|4\.5|[5-9]|[1-9]\d)|chatgpt-4o|o[1-9](?:-|$)|codex-|gpt-oss-)/i;

/** Whether `model` (a body's `model`) is one this counts: its tokenizer is o200k_base (`O200K_MODEL`). */
export function o200kModel(model: unknown): boolean {
  return typeof model === "string" && O200K_MODEL.test(model);
}

type CountTokens = (text: string, options: { disallowedSpecial: Set<string> }) => number;
let loaded: Promise<CountTokens> | undefined;
/** o200k_base's count, loaded the first time a body is counted (its ranks take some 300 ms to load; a session that never
 *  counts never loads them). */
const o200k = (): Promise<CountTokens> => (loaded ??= import("gpt-tokenizer/encoding/o200k_base").then((module) => module.countTokens as CountTokens));

/** The o200k_base tokens of `text`, every special token's spelling counted as the plain text it is (the provider encodes
 *  a request's text so: `<|endoftext|>` in a message is text, never a special token). */
export async function o200kTokens(text: string): Promise<number> {
  return (await o200k())(text, { disallowedSpecial: new Set() });
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Whether `value` holds an `input_file` at any depth (a tool's output holds them), as `responsesInputOverhead` reads one. */
function hasFile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFile);
  return plain(value) && (value.type === "input_file" || Object.values(value).some(hasFile));
}

/** The parts of a Responses body that the API reads as images (an `input_image` item, a part of an item's content, a part
 *  of a function call's output), by identity: the places `responsesImagesIn` reads, and no other. */
function imageParts(input: unknown): Set<object> {
  const out = new Set<object>();
  const image = (part: unknown) => { if (plain(part) && part.type === "input_image") out.add(part); };
  for (const item of list(input)) {
    if (!plain(item)) continue;
    image(item);
    for (const part of list(item.content)) image(part);
    if (item.type === "function_call_output") for (const part of list(item.output)) image(part);
  }
  return out;
}

/**
 * The local count of a Responses `body`'s input tokens, margin included (`LOCAL_COUNT_MARGIN`): its JSON as sent, counted
 * with o200k_base, with each `encrypted_content` at its bytes and each image at what it is billed as in place of their
 * text. Undefined (the body keeps its byte bound) for a model whose tokenizer is not o200k_base (`o200kModel`), for a body
 * with a file input (billed by its pages, with no stated bound), and for a body that is not an object.
 */
export async function responsesLocalInputTokens(body: Record<string, unknown>): Promise<number | undefined> {
  if (!plain(body) || !o200kModel(body.model)) return undefined;
  const model = body.model as string;
  if (hasFile(body.input)) return undefined;
  const images = imageParts(body.input);
  let opaque = 0;
  // The body as sent, with what the tokenizer cannot count left out of the text and counted on its own.
  const text = JSON.stringify(body, function (this: unknown, key: string, value: unknown) {
    if (key === "encrypted_content" && typeof value === "string") {
      opaque += Buffer.byteLength(value, "utf8");
      return "";
    }
    if (key === "image_url" && typeof value === "string" && typeof this === "object" && this !== null && images.has(this)) {
      const detail = (this as { detail?: unknown }).detail;
      opaque += imageTokens(model, { ...imageInputOf(value), ...(typeof detail === "string" ? { detail } : {}) });
      return "";
    }
    return value;
  });
  const items = list(body.input).length + list(body.tools).length + (typeof body.instructions === "string" && body.instructions !== "" ? 1 : 0);
  const tokens = await o200kTokens(text);
  return Math.ceil(tokens * (1 + LOCAL_COUNT_MARGIN.share)) + LOCAL_COUNT_MARGIN.perItem * items + LOCAL_COUNT_MARGIN.perRequest + opaque;
}
