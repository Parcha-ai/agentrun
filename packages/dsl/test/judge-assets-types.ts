// The judge seam's optional `assets` and `model`: a host judge that reads an image's bytes, and the shapes that are not an image.
import type { JudgeImage, WorkflowDeps } from '../dist/index.js';

type RunJudge = NonNullable<WorkflowDeps['runJudge']>;
type Params = Parameters<RunJudge>[0];

// A host's fake judge reads each image's bytes and type, and the model asked, without a cast.
export const reading: RunJudge = async (params) => {
  const sizes: Record<string, number> = {};
  for (const [reference, image] of Object.entries(params.assets ?? {})) {
    const bytes: Uint8Array = image.bytes;
    const mime: 'image/png' | 'image/jpeg' = image.mime;
    sizes[`${reference}:${mime}`] = bytes.byteLength;
  }
  const model: string | undefined = params.model;
  return { answers: {}, model: model ?? null, usage: null, cost_usd: sizes ? 0 : null };
};
export const first = (params: Params): number | undefined => params.assets?.['<photo>']?.bytes[0];

// Additive: a judge that reads neither field, and a call that sets neither, still type.
export const plain: RunJudge = async () => ({ answers: {} });
export const call: Params = { label: 'x', kind: 'judge', state: null, questions: {} };

// The image type is the PNG or JPEG file and its bytes, and nothing looser.
export const png: JudgeImage = { bytes: new Uint8Array([0x89]), mime: 'image/png' };
// @ts-expect-error a GIF is not an image a judge takes.
export const gif: JudgeImage = { bytes: new Uint8Array(1), mime: 'image/gif' };
// @ts-expect-error base64 text is not the file's bytes.
export const text: JudgeImage = { bytes: 'AAAA', mime: 'image/png' };
// @ts-expect-error the mime type is required.
export const untyped: JudgeImage = { bytes: new Uint8Array(1) };
// @ts-expect-error assets map references to images, not to bytes alone.
export const bare: Params = { ...call, assets: { '<photo>': new Uint8Array(1) } };
// @ts-expect-error the model is a name.
export const named: Params = { ...call, model: 1 };
