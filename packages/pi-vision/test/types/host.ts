// Type tests, checked by `npm run typecheck`: the ports are structural subsets of what pi ships, so a host passes pi's
// own objects in. A line marked @ts-expect-error fails the check if it ever compiles.

import type { Api, ImageContent as PiImageContent, Model, TextContent as PiTextContent, Usage as PiUsage } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { BinaryReader, ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Eyes, ImageContent, ImageProcessor, LimitsOverride, PreparedImage, TextContent, ToolResult, Usage, VisionBinaryReader, VisionEnv, VisionOptions } from "../../src/index.js";
import { piAiEyes } from "../../src/eyes/pi-ai.js";
import { fakeEyes } from "../../src/testing/index.js";

// pi-durable's Node environment, and any of its environments, is a VisionEnv as it is; its readers are ours.
const node: VisionEnv = new NodeExecutionEnv({ cwd: "/" });
const any = (env: ExecutionEnv): VisionEnv => env;
const reader = (r: BinaryReader): VisionBinaryReader => r;
// @ts-expect-error an environment that cannot run a program is not one.
const partial: VisionEnv = { id: "x", cwd: "/", readBinaryFile: node.readBinaryFile };

// pi's image processor and prepared image, as pi-durable's main branch declares them (packages/durable/src/tools/
// image-processor.ts at 42a3497d, 2026-10-09; not released), are ours in both directions.
type PiImageLimits = { readonly maxWidth: number; readonly maxHeight: number; readonly maxBytes: number };
type PiPreparedImage = {
  readonly data: string;
  readonly mimeType: string;
  readonly resized?: { readonly from: { readonly width: number; readonly height: number }; readonly to: { readonly width: number; readonly height: number } };
  readonly convertedFrom?: string;
};
type PiImageProcessor = { prepare(bytes: Uint8Array, mimeType: string, limits: PiImageLimits): Promise<PiPreparedImage | undefined> };
const fromPi = (p: PiImageProcessor): ImageProcessor => p;
const toPi = (p: ImageProcessor): PiImageProcessor => p;
const prepared = (p: PiPreparedImage): PreparedImage => p;
const preparedBack = (p: PreparedImage): PiPreparedImage => p;

// pi-ai's usage and content blocks pass through unchanged.
const usage = (u: PiUsage): Usage => u;
const blocks = (t: PiTextContent, i: PiImageContent): [TextContent, ImageContent] => [t, i];
const result = (t: PiTextContent, i: PiImageContent, u: PiUsage): ToolResult => ({ content: [t, i], usage: u });

// The eyes take a pi-ai model as the host builds it; the fake eyes are eyes.
const eyes = (model: Model<Api>): Eyes => piAiEyes(model, { apiKey: () => undefined, reasoning: "low", timeoutMs: 1 });
const fake: Eyes = fakeEyes();

// A host's route limits as it writes them: a gateway cap and native video, nothing else.
const route: LimitsOverride = { requestBytes: 20 * 1024 * 1024, video: { native: true } };
const options: VisionOptions = { evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `evidence/${id}/media` }), limits: () => route, install: { read: "off", look: true, guard: false } };

void [node, any, reader, partial, fromPi, toPi, prepared, preparedBack, usage, blocks, result, eyes, fake, options];
