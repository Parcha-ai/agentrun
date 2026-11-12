// Each image a model request carries, checked where pi-ai attaches it to the request (the session's provider,
// port-models.ts): a provider refuses a whole request over one image it cannot read ("Invalid image data URL"), which
// fails the run, and pi resends every earlier tool result on each later request, so one bad image would refuse every
// request after it. An image of a type no provider takes, an empty one, one whose data is not base64, one whose bytes
// are not the type it names, or one whose size its header does not say goes to the model as a short text in its place.
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { imageSizeOf } from "@parcha/agentrun-kernel/host";

/** The first bytes of each image type every provider takes, by its MIME type. */
const SIGNATURES: Readonly<Record<string, (head: Buffer) => boolean>> = {
  "image/png": (head) => head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a,
  "image/jpeg": (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  "image/gif": (head) => head.toString("latin1", 0, 4) === "GIF8",
  "image/webp": (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why `image` (pi-ai's image part) cannot be attached to a model request; undefined when it can. */
export function unattachable(image: { readonly data?: unknown; readonly mimeType?: unknown }): string | undefined {
  const { data, mimeType } = image;
  if (typeof mimeType !== "string" || !SIGNATURES[mimeType]) return `its type ${JSON.stringify(mimeType ?? null)} is not PNG, JPEG, GIF or WebP`;
  if (typeof data !== "string" || data.length === 0) return "it is empty";
  if (data.length % 4 !== 0 || !BASE64.test(data)) return "its data is not base64";
  if (!SIGNATURES[mimeType](Buffer.from(data.slice(0, 16), "base64"))) return `its bytes are not a ${mimeType}`;
  if (!imageSizeOf(data)) return `its ${mimeType} header does not say its size`;
  return undefined;
}

/** The text a model is sent in place of an image that cannot be attached. */
export const notAttached = (why: string): string => `[the image could not be attached: ${why}]`;

/** `context` with each image part that cannot be attached (unattachable) replaced by a text saying why; `context` itself
 *  when every image can be. */
export function attachableImages<C extends { readonly messages: readonly unknown[] }>(context: C): C {
  let changed = false;
  const messages = context.messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let replaced = false;
    const parts = content.map((part: unknown) => {
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "image") return part;
      const why = unattachable(part as { data?: unknown; mimeType?: unknown });
      if (why === undefined) return part;
      replaced = true;
      return { type: "text", text: notAttached(why) };
    });
    if (!replaced) return message;
    changed = true;
    return { ...(message as object), content: parts };
  });
  return changed ? { ...context, messages } : context;
}

/** `api` whose every request is sent with its images checked (attachableImages). */
export function attachingImages(api: ProviderStreams): ProviderStreams {
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, attachableImages(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, attachableImages(context), options),
  };
}
