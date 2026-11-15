// The input a provider bills for a request beyond the bytes of its body, by the provider's API: one place for the figures
// and their sources, used by the model proxy's policies and by a host that bounds a request it sends itself. Written for
// AgentRun.
//
// A request's input can never be more tokens than its body's UTF-8 bytes (`inputTokensMaxOf`), except for what the
// provider adds or bills by another measure: a prompt it adds itself when tools are present, and images, which it bills by
// their area after it resizes them, not by their bytes. An image is counted at what the routed model's provider bills it
// as by its size (Anthropic's, OpenAI's or Google's rule; the most of the three for another provider), in place of the
// bytes its data takes in the body: a screenshot's base64 is a megabyte, and Claude bills it as some 1,200 tokens. Each
// figure is the largest the provider documents for any current model, so no model is undercounted. On the Responses API
// the text a body carries for the model to read as it is counts at its own bytes, not its JSON-escaped ones
// (`responsesEscapedBytes`).
//
// The byte bound is a proof: a byte-level BPE token covers at least one byte, so a body is never more tokens than bytes.
// It is also four times what an English prompt bills, and on a capped run that is the difference between going on and
// parking (a $0.50 lead list whose request 7 holds $0.35 at its least on its bytes, $0.12 on its count). A Responses or
// Messages body to a model whose tokenizer is o200k_base (`o200kModel`) is counted locally, with o200k_base and a stated
// margin (`LOCAL_COUNT_MARGIN`, `responsesLocalInputTokens`, `messagesLocalInputTokens`), on every route: straight to
// OpenAI, through a gateway, or through serve's Messages translation. A body this cannot count with a margin it can state
// (a model on another tokenizer, a file input) has no local count, and keeps its byte bound; Anthropic counts its own
// models' (the claude-agent policy's countInput).
import { o200kModel, o200kTokens } from "./o200k.js";

/** One image a request carries: the bytes its data takes in the body (its base64, or its data URL; 0 for an image the
 *  provider fetches by URL), which are counted at the image's billed size instead, and its pixel size when its data's own
 *  header says it (PNG, JPEG, GIF, WebP). */
export interface ImageInput {
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  /** The detail it asks for, where the API takes one (OpenAI's `low`, `high` or `auto`). */
  readonly detail?: string;
}

/** What of a request decides what its provider adds: whether it offers tools, how it asks for them, and its images. */
export interface InputShape {
  /** The request offers at least one tool. */
  tools: boolean;
  /** Its tool_choice, as Anthropic names them; absent for the provider's default. */
  toolChoice?: "auto" | "none" | "any" | "tool";
  /** Its image inputs, at any depth (earlier turns' and a tool's result included). */
  images: readonly ImageInput[];
  /** The model it is routed to, as the session names it (`anthropic/claude-sonnet-5.5` through a gateway): its provider's
   *  rule bills its images (`imageTokens`). Absent or unknown: the most any known rule bills each one as. */
  model?: string;
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
 * Chat Completions ("openai-completions") is spoken by OpenAI and by OpenAI-compatible gateways, which route to other
 * providers' models (Anthropic's among them). Its figure is the largest of any provider it may reach:
 *  - messages: nothing. It adds formatting tokens around each message, 3 a message, 1 for a name and 3 that prime the
 *    reply (num_tokens_from_messages in https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken),
 *    and each message's own JSON in the body ({"role":...,"content":...}, some 30 bytes of keys) is more bytes than that,
 *    so the byte bound covers them;
 *  - tools: never nothing. A gateway that routes to an Anthropic model is billed Anthropic's tool-use system prompt
 *    whatever API it speaks, and OpenAI renders tools into a prompt of its own with a fixed header; the largest documented
 *    of these is Anthropic's, 804 tokens (`ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.anyOrTool`), taken whatever the
 *    tool_choice, since a gateway may not pass it through as Anthropic reads it;
 *  - images: OpenAI's per-image maximum, which is above Anthropic's, so a gateway routing to either is covered.
 */
const CHAT_COMPLETIONS = "openai-completions";

/**
 * The tool prompt assumed for an API whose provider documents none: 2,048 tokens a request with tools. It is an
 * assumption, not a documented figure, and it is above the largest documented one (Anthropic's 804), so a provider that
 * adds a prompt of its own for tools, as Anthropic and OpenAI do, is not undercounted where its figure is unknown.
 */
export const ASSUMED_TOOL_PROMPT_TOKENS = 2_048;

/**
 * The API kinds whose figures are documented, as pi names them. Azure's and Codex's Responses are billed as OpenAI's.
 * Every other kind (pi's "mistral-conversations", "bedrock-converse-stream", "google-generative-ai", "google-vertex",
 * "pi-messages", a faux "faux:<id>", or any other) gets the general figure: nothing for its text, which the byte bound
 * covers, `ASSUMED_TOOL_PROMPT_TOKENS` when it has tools, and OpenAI's per-image maximum, the largest documented, for each
 * image.
 */
export const INPUT_OVERHEAD_APIS: readonly string[] = Object.freeze(["anthropic-messages", "openai-responses", "azure-openai-responses", "openai-codex-responses", CHAT_COMPLETIONS]);

/** The tool-use prompt Anthropic adds for a request of `shape`: none without tools. */
const anthropicToolPrompt = (shape: InputShape): number => (!shape.tools ? 0 : shape.toolChoice === "any" || shape.toolChoice === "tool" ? ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.anyOrTool : ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.autoOrNone);

/**
 * The most tokens Claude bills an image of `width` x `height` pixels as: its count of 28 px patches (the
 * high-resolution tier) or its area at 750 pixels a token (the standard tier), whichever is more, at most
 * `ANTHROPIC_IMAGE_TOKENS_MAX`. Claude only ever shrinks an image before it counts it ("Resolution and token cost",
 * https://platform.claude.com/docs/en/build-with-claude/vision), so the image as sent is the most it can be billed as.
 */
export function anthropicImageTokens(width: number, height: number): number {
  return Math.min(ANTHROPIC_IMAGE_TOKENS_MAX, Math.max(Math.ceil(width / 28) * Math.ceil(height / 28), Math.ceil((width * height) / 750)));
}

/** Whether `image` is a figure the bounds can read: whole bytes, and a size of whole positive pixels or none. */
function checkedImage(image: ImageInput): ImageInput {
  const pixels = (n: unknown) => n === undefined || (Number.isSafeInteger(n) && (n as number) > 0);
  if (!image || !Number.isSafeInteger(image.bytes) || image.bytes < 0 || !pixels(image.width) || !pixels(image.height) || (image.width === undefined) !== (image.height === undefined)) {
    throw new Error(`not an image's bytes and size: ${JSON.stringify(image).slice(0, 80)}`);
  }
  return image;
}

/**
 * The input tokens a provider bills for a request of `shape` beyond its body's bytes, on the API `api` (pi's names:
 * "anthropic-messages", "openai-responses", ...): its tool prompt, and each image at what it can be billed as in place of
 * the bytes its data takes in the body (so the figure is below 0 for a request whose images' data is larger than they
 * are billed as; the body's bytes and this together are its bound). A documented API gets its documented figures; any
 * other gets the general figure (`INPUT_OVERHEAD_APIS`). Never undefined: an input that cannot be measured is the
 * body's, not the API's.
 */
export function providerInputOverhead(api: string, shape: InputShape): number {
  if (!Array.isArray(shape.images)) throw new Error(`not a list of images: ${String(shape.images).slice(0, 40)}`);
  const images = shape.images.map(checkedImage);
  // Each image at what the routed model's provider bills it as (imageTokens), whatever API carries it: a gateway speaks
  // one API for every provider it routes to.
  const imagesNet = images.reduce((sum, image) => sum + imageTokens(shape.model, image) - image.bytes, 0);
  if (api === "anthropic-messages") return anthropicToolPrompt(shape) + imagesNet;
  if (api === CHAT_COMPLETIONS) return (shape.tools ? ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.anyOrTool : 0) + imagesNet;
  if (INPUT_OVERHEAD_APIS.includes(api)) return imagesNet;
  return (shape.tools ? ASSUMED_TOOL_PROMPT_TOKENS : 0) + imagesNet;
}

/** The provider whose image rule a model id is billed by, by the id as the session names it (a gateway's
 *  `vendor/model`, or the vendor's own): undefined for one the rules do not know. */
export function imageProviderOf(model: string | undefined): "anthropic" | "openai" | "google" | undefined {
  if (!model) return undefined;
  if (/^anthropic\/|(^|\/)claude/i.test(model)) return "anthropic";
  if (/^openai\/|(^|\/)(gpt|chatgpt|codex|o\d)/i.test(model)) return "openai";
  if (/^google\/|(^|\/)gemini/i.test(model)) return "google";
  return undefined;
}

/**
 * The most tokens OpenAI bills an image of `width` x `height` as, by its "Calculating costs" rules
 * (https://developers.openai.com/api/docs/guides/images-vision):
 *  - the tile rule, for every model: at detail "low", 85 tokens; otherwise (high, or auto, which may choose high) the
 *    image fit within 2048 x 2048, then its shorter side brought to 768 (up as well as down, the dearer reading for a
 *    small image), each 512 px tile 170 tokens beside a base of 85. A gpt-4o-mini model bills 2,833 and 5,667 a tile;
 *  - the patch rule, for the models it lists as billed by 32 px patches (`openaiPatchMultiplier`): its patches at the
 *    model's multiplier, when that is more.
 * At most `OPENAI_IMAGE_TOKENS_MAX`. With no model named, every rule at its dearest: gpt-4o-mini's tiles and the patches
 * at the largest multiplier, 2.46.
 */
export function openaiImageTokens(width: number, height: number, model?: string, detail?: string): number {
  // gpt-4o-mini's tile rates are the dearest: a model not named (a gateway's alias may be one) is held to them.
  const mini = model === undefined || /4o-mini/i.test(model);
  let tiled: number;
  if (detail === "low") tiled = mini ? 2_833 : 85;
  else {
    const fit = Math.min(1, 2048 / Math.max(width, height));
    const short = 768 / Math.min(width * fit, height * fit);
    const tiles = Math.ceil((width * fit * short) / 512) * Math.ceil((height * fit * short) / 512);
    tiled = mini ? 2_833 + 5_667 * tiles : 85 + 170 * tiles;
  }
  const multiplier = openaiPatchMultiplier(model);
  const patched = multiplier > 0 ? Math.ceil(Math.ceil(width / 32) * Math.ceil(height / 32) * multiplier) : 0;
  return Math.min(OPENAI_IMAGE_TOKENS_MAX, Math.max(tiled, patched));
}

/** The multiplier OpenAI bills a patch-billed model's 32 px patches at: 2.46 for a nano model, 1.72 for o4-mini (and
 *  codex-mini, built on it), 1.62 for another mini model (gpt-4o-mini excepted: it bills tiles); 0 for a tile-billed
 *  model; 2.46, the largest, for a model not named. */
export function openaiPatchMultiplier(model: string | undefined): number {
  if (model === undefined) return 2.46;
  if (/nano/i.test(model)) return 2.46;
  if (/o4-mini|codex-mini/i.test(model)) return 1.72;
  if (/mini/i.test(model) && !/4o-mini/i.test(model)) return 1.62;
  return 0;
}

/** What Gemini bills a picture as at the most ("Media resolution" and "Image understanding" in its API docs): 258 tokens
 *  an image at most 384 px on each side, else 258 for each 768 px tile; and a picture at Gemini 3's high media resolution
 *  1,120 tokens. The more of the two. */
export const GEMINI_HIGH_RESOLUTION_TOKENS = 1_120;
export function geminiImageTokens(width: number, height: number): number {
  const tiled = width <= 384 && height <= 384 ? 258 : 258 * Math.ceil(width / 768) * Math.ceil(height / 768);
  return Math.max(tiled, GEMINI_HIGH_RESOLUTION_TOKENS);
}

/**
 * The most tokens `image` is billed as by the routed `model`'s provider: Anthropic's, OpenAI's or Google's rule by its
 * size; for a model of another provider, or of none known, the most any of the three rules bills it as. An image whose
 * size cannot be read counts at the largest per-image maximum documented, `OPENAI_IMAGE_TOKENS_MAX` (Anthropic's own,
 * `ANTHROPIC_IMAGE_TOKENS_MAX`, on a Claude model), never at its bytes.
 */
export function imageTokens(model: string | undefined, image: ImageInput): number {
  const provider = imageProviderOf(model);
  if (image.width === undefined || image.height === undefined) return provider === "anthropic" ? ANTHROPIC_IMAGE_TOKENS_MAX : OPENAI_IMAGE_TOKENS_MAX;
  const { width, height } = image;
  if (provider === "anthropic") return anthropicImageTokens(width, height);
  if (provider === "openai") return openaiImageTokens(width, height, model, image.detail);
  if (provider === "google") return geminiImageTokens(width, height);
  // Of no provider known: every OpenAI rule (no model named), beside Anthropic's and Google's.
  return Math.max(anthropicImageTokens(width, height), openaiImageTokens(width, height), geminiImageTokens(width, height));
}

/** The pixel size an image's base64 `data` says in its own header (PNG, JPEG, GIF or WebP), or undefined: another format,
 *  or a header that cannot be read. Only its start is decoded (a JPEG's frame header within its first 256 KiB). */
export function imageSizeOf(data: string): { width: number; height: number } | undefined {
  const head = Buffer.from(data.slice(0, 349_528), "base64");
  const sized = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.toString("latin1", 12, 16) === "IHDR") return sized(head.readUInt32BE(16), head.readUInt32BE(20));
  if (head.length >= 10 && head.toString("latin1", 0, 4) === "GIF8") return sized(head.readUInt16LE(6), head.readUInt16LE(8));
  if (head.length >= 30 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    const kind = head.toString("latin1", 12, 16);
    if (kind === "VP8X") return sized(1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3));
    if (kind === "VP8L") { const bits = head.readUInt32LE(21); return sized(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)); }
    if (kind === "VP8 ") return sized(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
    return undefined;
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    // Walk the segments to a start-of-frame marker (SOF0-SOF15, but not DHT, JPG or DAC), which holds the height then width.
    for (let at = 2; at + 9 <= head.length; ) {
      if (head[at] !== 0xff) return undefined;
      const marker = head[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized(head.readUInt16BE(at + 7), head.readUInt16BE(at + 5));
      at += 2 + head.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A Messages body's content blocks where the API reads them, in order: each message's, and each block inside a
 *  tool_result among them. */
function messagesBlocks(messages: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of list(messages)) {
    if (!plain(message)) continue;
    for (const block of list(message.content)) {
      if (!plain(block)) continue;
      out.push(block);
      if (block.type === "tool_result") for (const inner of list(block.content)) if (plain(inner)) out.push(inner);
    }
  }
  return out;
}

/** A Messages body's images, only where the API reads one as an image: a block of a message's content, or of a
 *  tool_result's content, in every turn. Each is a base64 source's data, or a URL's (no bytes). An image-shaped object
 *  anywhere else (a tool call's arguments) is text to the provider: its bytes stay counted as they are. */
export function messagesImagesIn(messages: unknown): ImageInput[] {
  return messagesBlocks(messages).filter((block) => block.type === "image").map((block) => (plain(block.source) && block.source.type === "base64" ? imageInputOf(block.source.data) : { bytes: 0 }));
}

/** The parts of a Responses body the API reads as images, in order: an `input_image` item, a part of an item's content,
 *  a part of a function call's output. */
function responsesImageParts(input: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const image = (part: unknown) => { if (plain(part) && part.type === "input_image") out.push(part); };
  for (const item of list(input)) {
    if (!plain(item)) continue;
    image(item);
    for (const part of list(item.content)) image(part);
    if (item.type === "function_call_output") for (const part of list(item.output)) image(part);
  }
  return out;
}

/** A Responses body's images, only where the API reads one as an image (`responsesImageParts`), in every turn. Each is a
 *  data URL's, or a URL's or file id's (no bytes). An image-shaped object anywhere else is text to the provider: its
 *  bytes stay counted as they are. */
export function responsesImagesIn(input: unknown): ImageInput[] {
  return responsesImageParts(input).map((part) => ({ ...imageInputOf(part.image_url), ...(typeof part.detail === "string" ? { detail: part.detail } : {}) }));
}

/** The items of `type` in `value`, at any depth (a tool's output holds them). */
function itemsIn(value: unknown, type: string): number {
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + itemsIn(item, type), 0);
  if (!plain(value)) return 0;
  return (value.type === type ? 1 : 0) + Object.values(value).reduce((n: number, item) => n + itemsIn(item, type), 0);
}

/**
 * The bytes JSON's escapes add to the text a Responses body carries for the model to read as it is, beyond that text's
 * own UTF-8 bytes: in `instructions`, and in each `input` item, a message's text, a function call's arguments, a custom
 * tool call's input, a tool's output (a string, or its text parts) and a reasoning summary's text.
 *
 * Why the input bound may count that text at its own bytes: the model reads it as the string itself, never as its JSON
 * spelling in the body. OpenAI's counting recipe encodes each message's decoded value and adds a fixed few tokens a
 * message (num_tokens_from_messages,
 * https://github.com/openai/openai-cookbook/blob/db3144982aa26b87a9bdfb692b4fbedfdf8a14d5/examples/How_to_count_tokens_with_tiktoken.ipynb),
 * and the harmony format OpenAI published for its models puts a message's content, a call's arguments and a tool's
 * output between its special tokens as raw text (`<|message|>{"location":"San Francisco"}<|call|>`,
 * https://github.com/openai/harmony/blob/e0ce87d1c3b9f59dec2e27de4770c769f03ebbd3/docs/format.md#receiving-tool-calls).
 * A byte-level BPE token covers at least one byte of the text it encodes, so that text is at most its UTF-8 bytes in
 * tokens; the escape characters JSON adds around it (`\"`, `\\`, `\n`, `\t`, `\u0000`) are bytes the body spends that no
 * token of it is billed for. Every other byte is counted as sent, as before: the keys, ids and structure of each item
 * still cover the framing the provider puts around it (a role, a recipient, a few special tokens: fewer than the bytes
 * of the keys the item spends); the tool definitions (`tools`, and code mode's `additional_tools` item) are counted
 * whole, since a template renders them into a prompt of its own that may quote their strings again (harmony's
 * TypeScript namespace); and encrypted reasoning is base64, which JSON never escapes, so it keeps its own bytes.
 */
export function responsesEscapedBytes(body: Record<string, unknown>): number {
  // What the proxy sends is JSON.stringify's spelling, so the escapes are measured by the same spelling.
  const escaped = (text: unknown) => (typeof text === "string" ? Buffer.byteLength(JSON.stringify(text), "utf8") - 2 - Buffer.byteLength(text, "utf8") : 0);
  const textOf = (content: unknown) => (typeof content === "string" ? escaped(content) : list(content).reduce((n: number, part) => n + (plain(part) && (part.type === "input_text" || part.type === "output_text" || part.type === "summary_text" || part.type === "reasoning_text") ? escaped(part.text) : 0), 0));
  let sum = escaped(body.instructions);
  for (const item of list(body.input)) {
    if (!plain(item)) continue;
    if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) sum += textOf(item.content);
    else if (item.type === "function_call") sum += escaped(item.arguments);
    else if (item.type === "custom_tool_call") sum += escaped(item.input);
    else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") sum += textOf(item.output);
    else if (item.type === "reasoning") sum += textOf(item.summary) + textOf(item.content);
  }
  return sum;
}

/**
 * The input tokens the provider bills for a Responses `body` beyond its bytes (`providerInputOverhead`, with its
 * sources), less the escapes in the text it carries (`responsesEscapedBytes`, with the argument for it). The Responses
 * API documents no prompt of its own that it adds on these routes, and the framing it puts around each input item and
 * tool definition is a few tokens each, fewer than the bytes of the JSON keys that item already spends in the body. An
 * image is billed by its area, not its bytes: each counts at the most it can be billed as, in place of the bytes its
 * data URL takes in the body. A file input (a PDF, billed by its pages) has no stated bound, so a body with one cannot
 * be measured: this throws, and the request's input is unknown. Codex's and OpenCode's policies both use it.
 */
export function responsesInputOverhead(body: Record<string, unknown>): number {
  if (itemsIn(body.input, "input_file") > 0) throw new Error("a file input's billed size has no stated bound");
  return providerInputOverhead("openai-responses", { tools: Array.isArray(body.tools) && body.tools.length > 0, images: responsesImagesIn(body.input), ...(typeof body.model === "string" ? { model: body.model } : {}) }) - responsesEscapedBytes(body);
}

/**
 * The margin a local count adds, and why each part:
 *  - `share`, 10% of the counted tokens: the count is o200k_base's, the vocabulary tiktoken names for gpt-4o, gpt-4.1,
 *    gpt-4.5, gpt-5, the o-series and gpt-oss (MODEL_PREFIX_TO_ENCODING,
 *    https://github.com/openai/tiktoken/blob/79dc2c0533685b893616c78160b5d9e40876e724/tiktoken/model.py#L7-L37). A later
 *    model that bills by a revised vocabulary may split some text finer; a tenth more covers a revision of that order.
 *  - `perItem`, 16 tokens for each input item (and each part of a tool's result), each tool and the instructions: the framing the provider renders around
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

/** `tokens` counted over a body of `items` items, with `opaque` tokens counted apart, as `LOCAL_COUNT_MARGIN` adds them. */
const withMargin = (tokens: number, items: number, opaque: number): number => Math.ceil(tokens * (1 + LOCAL_COUNT_MARGIN.share)) + LOCAL_COUNT_MARGIN.perItem * items + LOCAL_COUNT_MARGIN.perRequest + opaque;

/**
 * The local count of a Responses `body`'s input tokens, margin included (`LOCAL_COUNT_MARGIN`): its JSON as sent, counted
 * with o200k_base, with each `encrypted_content` at its bytes and each image at what it is billed as in place of their
 * text. Undefined (the body keeps its byte bound) for a model whose tokenizer is not o200k_base (`o200kModel`), for a body
 * with a file input (billed by its pages, with no stated bound), and for a body that is not an object.
 */
export async function responsesLocalInputTokens(body: Record<string, unknown>): Promise<number | undefined> {
  if (!plain(body) || !o200kModel(body.model)) return undefined;
  const model = body.model as string;
  if (itemsIn(body.input, "input_file") > 0) return undefined;
  const images = new Set<object>(responsesImageParts(body.input));
  // Every image the API reads counts once, at the most it is billed as, whatever names it: a data URL by its size, and an
  // http URL, a file id or no reference at all at the most an image of unknown size is billed (`imageTokens`), as the
  // byte bound counts it (`responsesImagesIn`). Never as the few tokens of its JSON.
  let opaque = 0;
  for (const part of images) {
    const { image_url: url, detail } = part as { image_url?: unknown; detail?: unknown };
    opaque += imageTokens(model, { ...imageInputOf(url), ...(typeof detail === "string" ? { detail } : {}) });
  }
  // The body as sent, with what the tokenizer cannot count left out of the text and counted on its own.
  const text = JSON.stringify(body, function (this: unknown, key: string, value: unknown) {
    if (key === "encrypted_content" && typeof value === "string") {
      opaque += Buffer.byteLength(value, "utf8");
      return "";
    }
    if (key === "image_url" && typeof value === "string" && typeof this === "object" && this !== null && images.has(this)) return "";
    return value;
  });
  // Each input item, and each part of a function call's output (the provider frames each part it renders, as it does a
  // Messages tool_result's blocks), each tool and the instructions.
  const outputParts = list(body.input).reduce<number>((sum, item) => sum + (plain(item) && item.type === "function_call_output" ? list(item.output).filter(plain).length : 0), 0);
  const items = list(body.input).length + outputParts + list(body.tools).length + (typeof body.instructions === "string" && body.instructions !== "" ? 1 : 0);
  return withMargin(await o200kTokens(text), items, opaque);
}

/**
 * The local count of a Messages `body`'s input tokens, margin included (`LOCAL_COUNT_MARGIN`), by the same rule as a
 * Responses body's (`responsesLocalInputTokens`), for a Messages request to a model whose tokenizer is o200k_base: one
 * serve's translation sends on to a provider of another API (pi's session on `openai/gpt-6.1-sol` through OpenRouter,
 * whose chat completions carry the same text). Its JSON as sent, counted with o200k_base, with a thinking block's
 * `signature` and a redacted one's `data` at their bytes and each image at what it is billed as on the routed model, in
 * place of their text. An item is each message's block and each block inside a tool_result (one for a message with
 * none), each tool and each system block: the provider frames each turn, call, result and part of a result it renders.
 * Undefined (the body keeps its byte bound) for a model whose tokenizer is not o200k_base (every Claude model: Anthropic
 * counts those itself, or the byte bound holds), for a body with a document (billed by its pages, with no stated bound),
 * and for a body that is not an object.
 */
export async function messagesLocalInputTokens(body: Record<string, unknown>): Promise<number | undefined> {
  if (!plain(body) || !o200kModel(body.model)) return undefined;
  const model = body.model as string;
  const blocks = messagesBlocks(body.messages);
  if (blocks.some((block) => block.type === "document")) return undefined;
  // Every image the API reads counts once, at the most it is billed as (`imageTokens`): a base64 source by the size its
  // header says, a URL's at the most an image of unknown size is billed, as the byte bound counts it (`messagesImagesIn`).
  let opaque = messagesImagesIn(body.messages).reduce((sum, image) => sum + imageTokens(model, image), 0);
  const sources = new Set(blocks.filter((block) => block.type === "image" && plain(block.source)).map((block) => block.source as object));
  // The body as sent, with what the tokenizer cannot count left out of the text and counted on its own.
  const text = JSON.stringify(body, function (this: unknown, key: string, value: unknown) {
    const holder = this as { type?: unknown } | null;
    if (typeof value === "string" && ((key === "signature" && holder?.type === "thinking") || (key === "data" && holder?.type === "redacted_thinking"))) {
      opaque += Buffer.byteLength(value, "utf8");
      return "";
    }
    if (key === "data" && typeof value === "string" && typeof this === "object" && this !== null && sources.has(this)) return "";
    return value;
  });
  const messages = list(body.messages).filter(plain);
  const system = typeof body.system === "string" ? (body.system === "" ? 0 : 1) : list(body.system).length;
  const items = messages.reduce((sum, message) => sum + Math.max(1, messagesBlocks([message]).length), 0) + list(body.tools).length + system;
  return withMargin(await o200kTokens(text), items, opaque);
}

/** The image a body's `data` (base64, or a data URL) carries: the bytes it takes, and its size when its header says it.
 *  Anything else (an http URL, a file id): no bytes, no size. */
export function imageInputOf(data: unknown): ImageInput {
  if (typeof data !== "string") return { bytes: 0 };
  const base64 = /^data:[^,]*;base64,/i.exec(data);
  if (data.startsWith("data:") && !base64) return { bytes: 0 };
  const payload = base64 ? data.slice(base64[0].length) : data;
  // A URL the provider fetches is billed by the image it finds, and only its own bytes are in the body.
  if (!base64 && /^[a-z][a-z0-9+.-]*:\/\//i.test(data)) return { bytes: 0 };
  const size = imageSizeOf(payload);
  // Its whole string, once JSON writes it: base64 and a data URL's prefix need no escaping.
  return { bytes: Buffer.byteLength(JSON.stringify(data), "utf8") - 2, ...(size ?? {}) };
}
