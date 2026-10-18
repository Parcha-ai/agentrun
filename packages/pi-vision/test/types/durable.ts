// Type tests for the pi-durable adapter, checked by `npm run typecheck` on every pi-durable the peers accept: pi's
// `Models` is the door the eyes look through, the extension installs in pi's registry, results are pi's, and a host's
// own tool builds its call context from pi's tool API, and a host's code mode takes `vision.see` in one line. A line
// marked @ts-expect-error fails the check if it compiles.

import type { Context } from "@earendil-works/chord";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { createJevRunner, type JevJudge } from "@parcha/agentrun-jev";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type ConversationId, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CallContext, CallSetup, ToolResult, VisionEnv } from "../../src/index.js";
import { DEFAULT_LIMITS, visionContext } from "../../src/index.js";
import { callContext, createVisionExtension, modelsEyes, piResult, type ModelsDoor } from "../../src/durable.js";
import { inheritedEnv, nodeVisionEnv } from "../../src/node.js";

const door = (models: Models): ModelsDoor => models;
const eyes = (models: Models) => modelsEyes(models, { provider: "anthropic", modelId: "claude-sonnet-4-5" }, { thinking: "low" });
const vision = createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), eyesModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
createRegistry().install(vision.extension);
const result = (r: ToolResult): ToolExecutionResult => piResult(r);
const call = (api: ToolExecutionApi, context: Context): Promise<CallContext> => callContext(api, context);
// A host's code-mode tool builds the global per call and passes it to pi-codemode as it is.
const sandbox = async (api: ToolExecutionApi, context: Context) => new CodemodeSandbox({ globals: [vision.see(api.env, await callContext(api, context))] });
const global = (api: ToolExecutionApi, call: CallContext): CodemodeTool => vision.see(api.env, call);
// Jev is the port `@parcha/agentrun-jev` builds, passed as it is; a judge of any other shape is not one.
const judged = createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), jev: { judge: createJevRunner({ apiKey: "a key" }), model: "jev-1.14.0" } });
const viaPort = (judge: JevJudge) => createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), jev: { judge } });
// @ts-expect-error a judge whose answer has no answers is not Jev's port.
const notJev = createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), jev: { judge: async () => ({ model: "m" }) } });
// A host's own tool names itself for `fit`'s rows, and `scope` gets pi's own id beside the string.
const shot = (api: ToolExecutionApi, context: Context): Promise<CallContext> => callContext(api, context, "screenshot");
const byPiId = createVisionExtension({
  evidence: { file: async () => null },
  scope: (id, conversation) => {
    const pi: ConversationId | undefined = conversation;
    // @ts-expect-error pi's id is its own type, not the string the core passes first.
    const text: string = conversation!;
    return { label: `${id}-${pi}-${text}`, deriveDir: `media/${id}` };
  },
});
const env: VisionEnv = nodeVisionEnv({ cwd: "/" });
// A host that builds a call's setup by hand may give synchronous rows, as `VisionOptions` allows.
const handBuilt: CallSetup = { limits: DEFAULT_LIMITS, eyes: undefined, scope: { label: "l", deriveDir: "d" }, evidence: { file: async () => null }, providers: [], sources: {}, onLook: () => undefined, onMiss: () => undefined };
// A host names the environment its programs get: its own in full (its choice), or the default and more.
const passesItsOwn = createVisionExtension({ evidence: { file: async () => null }, scope: (id) => ({ label: id, deriveDir: `media/${id}` }), env: process.env });
const andMore: VisionEnv = nodeVisionEnv({ cwd: "/", env: { ...inheritedEnv(), FONTCONFIG_PATH: "/etc/fonts" } });
// The Node port is a VisionEnv, and its own `exec` takes pi's switch without a cast; the port's type alone does not.
const port = nodeVisionEnv({ cwd: "/" });
const named = () => port.exec(["true"], { env: { ONLY: "this" }, inheritEnv: false }, visionContext());
// @ts-expect-error `inheritEnv` is not part of the port every environment satisfies.
const unnamed = () => env.exec(["true"], { env: { ONLY: "this" }, inheritEnv: false }, visionContext());
// @ts-expect-error a door without `completeSimple` cannot look.
const blind: ModelsDoor = { getModel: () => undefined };

void [door, eyes, result, call, sandbox, global, judged, viaPort, notJev, shot, byPiId, env, blind, handBuilt, passesItsOwn, andMore, named, unnamed];
