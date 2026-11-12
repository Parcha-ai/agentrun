// A desktop's or a phone's tools, the same in both kinds: computer_observe (an app's window as a compact outline of its
// elements, by ref, and its image when asked), computer_act (steps on an app, each saying how it ran, an expect waited
// for, the new state), computer_screenshot (the whole screen), computer_script (JavaScript against the `computer`
// object, many steps in one call), and the hand-over (handoff.ts). Each runs on the hands' one computer port
// (hands.computer), which @parcha/agentrun-computer's surface answers the same for a tool, a script and an MCP client.
// Their schemas and the script's declarations are generated from that surface's api.ts (computer-surface.generated.ts),
// so the words a model reads can't drift from what answers them. On a computer with no ui group, observe is a
// screenshot and act's steps are raw input at its pixels: the surface's fallback, said in its answers.
import type { JsonValue } from "../../types.js";
import type { ToolDef } from "./defs.js";
import { ACT_STEPS, COMPUTER_TOOL_SCHEMAS, computerDeclarations } from "./computer-surface.generated.js";
import { answerOf, type CapabilityKind, type Executor, needsKindWords } from "./hands.js";
import { HANDOFF_TOOL, handoffDef, handoffExecutor } from "./handoff.js";

/** The computer's tools, in the order a run lists them (the hand-over last). */
export const COMPUTER_TOOLS = ["computer_observe", "computer_act", "computer_screenshot", "computer_script", HANDOFF_TOOL] as const;
/** The tool a host runs itself: a script runs in the host's isolate, over the same port. */
export const SCRIPT_TOOL = "computer_script";

// The words are short on purpose: every request of a run with a computer carries them. The kind skill (desktop-computer,
// phone-computer) teaches how to work; a description says only what its tool does.
const OBSERVE = `An app's window as its elements, one line each (@e12 button "Save"), under a head line naming the state (s7). With no ui group: a screenshot.`;

const ACT = `Run steps on an app, each on an element's ref or at a point in the window (refused as stale once the window changed under it). The answer says how each step ran and whether the window changed. The first refused step stops the rest. steps: UiStep[]\n\`\`\`ts\n${ACT_STEPS}\n\`\`\``;

const SCREENSHOT = "The whole screen as an image, or a region of it.";

/** computer_script's words: what a script is, and the `computer` object's declarations for these groups. */
const scriptWords = (groups: readonly string[]): string =>
  `Run JavaScript with \`computer\` bound: many steps in one call. Return only what you need; text() and image() show words and pictures. A refused step throws.\n\`\`\`ts\n${computerDeclarations(groups)}\n\`\`\``;

/** The tools a computer with `groups` offers: observe and act with the ui group, or a screen (observe) and input (act)
 *  without it; the screenshot with a screen; the script with any of them. */
export function computerToolsFor(groups: readonly string[]): readonly string[] {
  const has = (group: string) => groups.includes(group);
  const input = has("input.pointer") || has("input.touch") || has("input.keys");
  const observe = has("ui") || has("screen");
  const act = has("ui") || input;
  return [...(observe ? ["computer_observe"] : []), ...(act ? ["computer_act"] : []), ...(has("screen") ? ["computer_screenshot"] : []), ...(observe || act ? [SCRIPT_TOOL] : []), HANDOFF_TOOL];
}

const def = (kind: CapabilityKind, name: (typeof COMPUTER_TOOLS)[number], description: string, replaySafe: boolean): ToolDef => ({
  name,
  source: "host",
  gateName: `host:${kind}/${name}`,
  settingsKey: kind,
  description,
  parameters: COMPUTER_TOOL_SCHEMAS[name as keyof typeof COMPUTER_TOOL_SCHEMAS],
  replaySafe,
});

/** The computer's tools in `kind`, under its settings key, for a computer with `groups` (the script's declarations
 *  hold only what they offer). A script and an act change the computer: never replayed. */
export function computerToolDefs(kind: CapabilityKind, groups: readonly string[]): readonly ToolDef[] {
  return Object.freeze([
    def(kind, "computer_observe", OBSERVE, true),
    def(kind, "computer_act", ACT, false),
    def(kind, "computer_screenshot", SCREENSHOT, true),
    def(kind, "computer_script", scriptWords(groups), false),
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

/** The kernel's own executors of the computer's tools in `kind`: all but the script, which the host runs. */
export const computerExecutors = (kind: CapabilityKind): Readonly<Record<string, Executor>> => ({
  computer_observe: surfaceExecutor(kind, "computer_observe", "observe"),
  computer_act: surfaceExecutor(kind, "computer_act", "act"),
  computer_screenshot: surfaceExecutor(kind, "computer_screenshot", "screenshot"),
  [HANDOFF_TOOL]: handoffExecutor(kind),
});
