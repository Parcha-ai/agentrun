// The input a provider bills for a request beyond the bytes of its body, by the provider's API: one place for the figures
// and their sources, used by the model proxy's policies and by a host that bounds a request it sends itself. Written for
// AgentRun.
//
// A request's input can never be more tokens than its body's UTF-8 bytes (`inputTokensMaxOf`), except for what the
// provider adds or bills by another measure: a prompt it adds itself when tools are present, and images, which it bills by
// their area after it resizes them, not by their bytes. An image is counted at what it is billed as, in place of the bytes
// its data takes in the body (a screenshot's base64 is a megabyte; Claude bills it as some 1,200 tokens). Each figure is
// the largest the provider documents for any current model, so no model is undercounted.

/** One image a request carries: the bytes its data takes in the body (its base64, or its data URL; 0 for an image the
 *  provider fetches by URL), which are counted at the image's billed size instead, and its pixel size when its data's own
 *  header says it (PNG, JPEG, GIF, WebP). */
export interface ImageInput {
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
}

/** What of a request decides what its provider adds: whether it offers tools, how it asks for them, and its images. */
export interface InputShape {
  /** The request offers at least one tool. */
  tools: boolean;
  /** Its tool_choice, as Anthropic names them; absent for the provider's default. */
  toolChoice?: "auto" | "none" | "any" | "tool";
  /** Its image inputs, at any depth (a tool's result included). */
  images: readonly ImageInput[];
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
  const dataBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  if (api === "anthropic-messages") {
    const billed = images.reduce((sum, image) => sum + (image.width !== undefined ? anthropicImageTokens(image.width, image.height!) : ANTHROPIC_IMAGE_TOKENS_MAX), 0);
    return anthropicToolPrompt(shape) + billed - dataBytes;
  }
  const openai = images.length * OPENAI_IMAGE_TOKENS_MAX - dataBytes;
  if (api === CHAT_COMPLETIONS) return (shape.tools ? ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS.anyOrTool : 0) + openai;
  if (INPUT_OVERHEAD_APIS.includes(api)) return openai;
  return (shape.tools ? ASSUMED_TOOL_PROMPT_TOKENS : 0) + openai;
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
/** Each item of `type` at any depth of `value` (a tool's result holds them), as `read` reads it. */
function itemsOf(value: unknown, type: string, read: (item: Record<string, unknown>) => ImageInput, out: ImageInput[] = []): ImageInput[] {
  if (Array.isArray(value)) for (const item of value) itemsOf(item, type, read, out);
  else if (plain(value)) {
    if (value.type === type) out.push(read(value));
    for (const item of Object.values(value)) itemsOf(item, type, read, out);
  }
  return out;
}

/** A Messages body's images (`{type: "image", source}`), at any depth: a base64 source's data, or a URL's (no bytes). */
export function messagesImagesIn(value: unknown): ImageInput[] {
  return itemsOf(value, "image", (item) => (plain(item.source) && item.source.type === "base64" ? imageInputOf(item.source.data) : { bytes: 0 }));
}

/** A Responses body's images (`{type: "input_image", image_url}`), at any depth: a data URL, or a URL or file id (no bytes). */
export function responsesImagesIn(value: unknown): ImageInput[] {
  return itemsOf(value, "input_image", (item) => imageInputOf(item.image_url));
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
