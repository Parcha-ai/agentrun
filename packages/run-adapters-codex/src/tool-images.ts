// A host tool's images, checked before Codex's model is sent them, by the rule claude-agent's adapter holds them to
// (toolImageProblems there): a type the model takes, written as image/<subtype> with no parameters, and base64. Pure and
// self-contained, so it can move to the kernel's tool answer unchanged.

/** An image as a host tool returns it. */
export type ToolImageShape = { readonly mimeType?: unknown; readonly data?: unknown };

/** image/<subtype>: no parameter (no ';'), nothing else. */
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why a tool's images can't be sent, naming the tool and the image, or undefined. */
export function toolImageProblems(tool: string, images: readonly ToolImageShape[]): string | undefined {
  for (const [i, image] of images.entries()) {
    const at = `the tool ${tool}'s image ${i + 1}`;
    const type = image?.mimeType;
    if (typeof type !== "string" || !IMAGE_TYPE.test(type)) return `${at} is ${String(type).slice(0, 40)}, not an image type the model takes (image/<type>, no parameters)`;
    if (typeof image.data !== "string" || !BASE64.test(image.data)) return `${at} is not base64`;
  }
  return undefined;
}
