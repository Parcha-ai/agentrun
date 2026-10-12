// Type tests for the pi-durable adapter, checked by `npm run typecheck` on every pi-durable the peers accept: pi's
// `Models` is the door the eyes look through, the extension installs in pi's registry, results are pi's, and a host's
// own tool builds its call context from pi's tool API. A line marked @ts-expect-error fails the check if it compiles.

import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CallContext, CallSetup, ToolResult, VisionEnv } from "../../src/index.js";
import { DEFAULT_LIMITS } from "../../src/index.js";
import { callContext, createVisionExtension, modelsEyes, piResult, type ModelsDoor } from "../../src/durable.js";
import { nodeVisionEnv } from "../../src/node.js";

const door = (models: Models): ModelsDoor => models;
const eyes = (models: Models) => modelsEyes(models, { provider: "anthropic", modelId: "claude-sonnet-4-5" }, { thinking: "low" });
const vision = createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), eyesModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
createRegistry().install(vision.extension);
const result = (r: ToolResult): ToolExecutionResult => piResult(r);
const call = (api: ToolExecutionApi, context: Context): Promise<CallContext> => callContext(api, context);
const env: VisionEnv = nodeVisionEnv({ cwd: "/" });
// A host that builds a call's setup by hand may give synchronous rows, as `VisionOptions` allows.
const handBuilt: CallSetup = { limits: DEFAULT_LIMITS, eyes: undefined, scope: { label: "l", deriveDir: "d" }, evidence: { file: async () => null }, providers: [], sources: {}, onLook: () => undefined, onMiss: () => undefined };
// @ts-expect-error a door without `completeSimple` cannot look.
const blind: ModelsDoor = { getModel: () => undefined };

void [door, eyes, result, call, env, blind, handBuilt];
