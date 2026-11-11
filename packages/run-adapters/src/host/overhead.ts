// The input a provider bills for a request beyond the bytes of its body, by the provider's API: one place for the figures
// and their sources, used by the model proxy's policies and by a host that bounds a request it sends itself. Written for
// AgentRun.
//
// A request's input can never be more tokens than its body's UTF-8 bytes (`inputTokensMaxOf`), except for what the
// provider adds or bills by another measure: a prompt it adds itself when tools are present, and images, which it bills by
// their area after it resizes them, not by their bytes. An image is counted at what the routed model's provider bills it
// as by its size (Anthropic's, OpenAI's or Google's rule; the most of the three for another provider), in place of the
// bytes its data takes in the body: a screenshot's base64 is a megabyte, and Claude bills it as some 1,200 tokens. Each
// figure is the largest the provider documents for any current model, so no model is undercounted.

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
 * At most `OPENAI_IMAGE_TOKENS_MAX`. With no model named, every rule (the patches at the largest multiplier, 2.46).
 */
export function openaiImageTokens(width: number, height: number, model?: string, detail?: string): number {
  const mini = model !== undefined && /4o-mini/i.test(model);
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

/** A Messages body's images, only where the API reads one as an image: a block of a message's content, or of a
 *  tool_result's content, in every turn. Each is a base64 source's data, or a URL's (no bytes). An image-shaped object
 *  anywhere else (a tool call's arguments) is text to the provider: its bytes stay counted as they are. */
export function messagesImagesIn(messages: unknown): ImageInput[] {
  const out: ImageInput[] = [];
  const image = (block: unknown) => {
    if (plain(block) && block.type === "image") out.push(plain(block.source) && block.source.type === "base64" ? imageInputOf(block.source.data) : { bytes: 0 });
  };
  for (const message of list(messages)) {
    if (!plain(message)) continue;
    for (const block of list(message.content)) {
      image(block);
      if (plain(block) && block.type === "tool_result") for (const inner of list(block.content)) image(inner);
    }
  }
  return out;
}

/** A Responses body's images, only where the API reads one as an image: an `input_image` item, a part of an item's
 *  content, or a part of a function call's output, in every turn. Each is a data URL's, or a URL's or file id's (no
 *  bytes). An image-shaped object anywhere else is text to the provider: its bytes stay counted as they are. */
export function responsesImagesIn(input: unknown): ImageInput[] {
  const out: ImageInput[] = [];
  const image = (part: unknown) => {
    if (plain(part) && part.type === "input_image") out.push({ ...imageInputOf(part.image_url), ...(typeof part.detail === "string" ? { detail: part.detail } : {}) });
  };
  for (const item of list(input)) {
    if (!plain(item)) continue;
    image(item);
    for (const part of list(item.content)) image(part);
    if (item.type === "function_call_output") for (const part of list(item.output)) image(part);
  }
  return out;
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
