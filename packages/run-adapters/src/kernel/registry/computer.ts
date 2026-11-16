// A desktop's or a phone's tools, the same in both kinds: computer_observe (an app's window as a compact outline of its
// elements, by ref, and its image when asked), computer_act (steps on an app, each saying how it ran, an expect waited
// for, the new state), computer_screenshot (the whole screen), computer_op (one of the computer's other ops: its shell,
// its files, its apps, raw input), and the hand-over (handoff.ts). Each runs on the hands' one computer port
// (hands.computer), which @parcha/agentrun-computer's surface answers the same for a tool and an MCP client. Many steps
// in one call are a script: the host's codemode binds the surface's `computer` object over these tools, each of its
// calls a nested call of its own, gated and recorded (observe, act and screenshot as their own tools, every other op as
// computer_op, which a host lists to no model that has a codemode of the host's). Their schemas are generated from
// that surface's api.ts (computer-surface.generated.ts), so the words a model reads can't drift from what answers them.
// On a computer with no ui group, observe is a screenshot and act's steps are raw input at its pixels: the surface's
// fallback, said in its answers.
import type { JsonValue } from "../../types.js";
import type { ToolDef } from "./defs.js";
import { ACT_STEPS, COMPUTER_TOOL_SCHEMAS } from "./computer-surface.generated.js";
import { answerOf, type CapabilityKind, type Executor, needsKindWords } from "./hands.js";
import { HANDOFF_TOOL, handoffDef, handoffExecutor } from "./handoff.js";

/** The tool a script's `computer` runs every op through that no step tool runs. */
export const COMPUTER_OP_TOOL = "computer_op";
/** The computer's tools, in the order a run lists them (the hand-over last). */
export const COMPUTER_TOOLS = ["computer_observe", "computer_act", "computer_screenshot", COMPUTER_OP_TOOL, HANDOFF_TOOL] as const;
/** The ops computer_op runs, each with the groups that offer it (one of them): the surface's ops (SURFACE_OPS) but the
 *  three the step tools run. */
export const COMPUTER_OPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "input.act": ["input.pointer", "input.touch", "input.keys"],
  "apps.list": ["apps"],
  "apps.open": ["apps"],
  "shell.run": ["exec"],
  "processes.start": ["processes"],
  "files.read": ["files"],
  "files.write": ["files"],
  "files.list": ["files"],
  "files.stat": ["files"],
});
/** The op of each step tool, as a script's `computer` names it. */
export const STEP_TOOL_OPS: Readonly<Record<string, string>> = Object.freeze({ observe: "computer_observe", act: "computer_act", screenshot: "computer_screenshot" });

// The words are short on purpose: every request of a run with a computer carries them. The kind skill (desktop-computer,
// phone-computer) teaches how to work; a description says only what its tool does.
const OBSERVE = `An app's window as its elements, one line each (@e12 button "Save"), under a head line naming the state (s7). With no ui group: a screenshot.`;

const ACT = `Run steps on an app, each on an element's ref or at a point in the window (refused as stale once the window changed under it). The answer says how each step ran and whether the window changed. The first refused step stops the rest. steps: UiStep[]\n\`\`\`ts\n${ACT_STEPS}\n\`\`\``;

const SCREENSHOT = "The whole screen as an image, or a region of it.";

const OP = `One of the computer's ops no other tool runs, as a script's \`computer\` calls it: input.act {actions}, apps.list, apps.open {id, url?, background?}, shell.run {command, cwd?, env?, timeoutMs?}, processes.start {command, cwd?, env?}, files.read {path, encoding?}, files.write {path, data, encoding?}, files.list {path}, files.stat {path}. An op this computer does not offer is refused.`;

/** The ops computer_op runs on a computer with `groups`. */
export function computerOpsFor(groups: readonly string[]): readonly string[] {
  return Object.keys(COMPUTER_OPS).filter((op) => COMPUTER_OPS[op]!.some((group) => groups.includes(group)));
}

/** The tools a computer with `groups` offers: observe and act with the ui group, or a screen (observe) and input (act)
 *  without it; the screenshot with a screen; computer_op with any op past those (computerOpsFor). */
export function computerToolsFor(groups: readonly string[]): readonly string[] {
  const has = (group: string) => groups.includes(group);
  const input = has("input.pointer") || has("input.touch") || has("input.keys");
  const observe = has("ui") || has("screen");
  const act = has("ui") || input;
  return [...(observe ? ["computer_observe"] : []), ...(act ? ["computer_act"] : []), ...(has("screen") ? ["computer_screenshot"] : []), ...(computerOpsFor(groups).length > 0 ? [COMPUTER_OP_TOOL] : []), HANDOFF_TOOL];
}

/** computer_act's parameters on a computer with no ui group: no expect, which only the ui group checks, so neither the
 *  expect nor the wait on one (an empty act with an expect) is offered there. */
const ACT_WITHOUT_UI: object = (() => {
  const schema = COMPUTER_TOOL_SCHEMAS.computer_act as { properties: { steps: { description?: string }; expect?: unknown } };
  const { expect: _, ...properties } = schema.properties;
  return { ...schema, properties: { ...properties, steps: { ...properties.steps, description: "Run in order." } } };
})();

const def = (kind: CapabilityKind, name: (typeof COMPUTER_TOOLS)[number], description: string, replaySafe: boolean, parameters: object = COMPUTER_TOOL_SCHEMAS[name as keyof typeof COMPUTER_TOOL_SCHEMAS]): ToolDef => ({
  name,
  source: "host",
  gateName: `host:${kind}/${name}`,
  settingsKey: kind,
  description,
  parameters,
  replaySafe,
});

/** computer_op's parameters: the op, and its arguments as a script's `computer` gives them. */
const OP_PARAMETERS: object = {
  type: "object",
  properties: {
    op: { type: "string", enum: Object.keys(COMPUTER_OPS) },
    args: { type: "object", description: "The op's arguments." },
  },
  required: ["op"],
  additionalProperties: false,
};

/** The computer's tools in `kind`, under its settings key, for a computer with `groups`. An act or an op changes the
 *  computer: never replayed. */
export function computerToolDefs(kind: CapabilityKind, groups: readonly string[]): readonly ToolDef[] {
  return Object.freeze([
    // With apps and no ui group, an observe that names an app opens it first: it changes the screen, so it never runs again.
    def(kind, "computer_observe", OBSERVE, groups.includes("ui") || !groups.includes("apps")),
    def(kind, "computer_act", ACT, false, groups.includes("ui") ? undefined : ACT_WITHOUT_UI),
    def(kind, "computer_screenshot", SCREENSHOT, true),
    def(kind, COMPUTER_OP_TOOL, OP, false, OP_PARAMETERS),
    handoffDef(kind),
  ]);
}

/** A value with its images' data left out: they travel in the answer's images. */
const withoutImageData = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key === "data" && record.type === "image")).map(([key, entry]) => [key, withoutImageData(entry)]));
};

/** A tool's run on the hands' computer port: the surface's op, answered as its text, its images and its value. */
const surfaceExecutor = (kind: CapabilityKind, tool: string, op: string): Executor => (args, call) =>
  answerOf(call, async () => {
    const port = call.hands.computer;
    if (!port) throw new Error(needsKindWords(tool, kind));
    const answer = await port.call(op, args ?? {}, call.signal);
    return { text: answer.text, ...(answer.images.length > 0 ? { images: answer.images } : {}), structured: (withoutImageData(answer.value) ?? null) as JsonValue };
  });

/** computer_op's run: `op` with `args` on the hands' computer port. An op a step tool runs is sent to that tool, so each
 *  is held and recorded as that tool's call; any other the port refuses where the computer does not offer it. */
const opExecutor = (kind: CapabilityKind): Executor => (args, call) => {
  const { op, args: given } = (args ?? {}) as { op?: unknown; args?: unknown };
  const tool = typeof op === "string" ? STEP_TOOL_OPS[op] : undefined;
  if (tool) return answerOf(call, async () => { throw new Error(`${COMPUTER_OP_TOOL} does not run ${op}: call ${tool}, which does`); });
  if (typeof op !== "string" || !Object.hasOwn(COMPUTER_OPS, op)) return answerOf(call, async () => { throw new Error(`${COMPUTER_OP_TOOL} runs one of ${Object.keys(COMPUTER_OPS).join(", ")}: not ${JSON.stringify(op)}`); });
  return surfaceExecutor(kind, COMPUTER_OP_TOOL, op)(given !== null && typeof given === "object" && !Array.isArray(given) ? given : {}, call);
};

/** The kernel's own executors of the computer's tools in `kind`. */
export const computerExecutors = (kind: CapabilityKind): Readonly<Record<string, Executor>> => ({
  computer_observe: surfaceExecutor(kind, "computer_observe", "observe"),
  computer_act: surfaceExecutor(kind, "computer_act", "act"),
  computer_screenshot: surfaceExecutor(kind, "computer_screenshot", "screenshot"),
  [COMPUTER_OP_TOOL]: opExecutor(kind),
  [HANDOFF_TOOL]: handoffExecutor(kind),
});
