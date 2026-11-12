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
import { COMPUTER_TOOL_SCHEMAS, computerDeclarations } from "./computer-surface.generated.js";
import { answerOf, type CapabilityKind, type Executor, needsKindWords } from "./hands.js";
import { HANDOFF_TOOL, handoffDef, handoffExecutor } from "./handoff.js";

/** The computer's tools, in the order a run lists them (the hand-over last). */
export const COMPUTER_TOOLS = ["computer_observe", "computer_act", "computer_screenshot", "computer_script", HANDOFF_TOOL] as const;
/** The tool a host runs itself: a script runs in the host's isolate, over the same port. */
export const SCRIPT_TOOL = "computer_script";

const OBSERVE = `Look at an app on the computer: its window's elements, one line each, as @e12 button "Save", indented under their parents, below a head line with the state's id (state s7). Act on an element by its ref with computer_act. image: true adds the window's image, for what the elements don't say (a picture, a canvas, a layout). With no app, the app in front. On a computer with no element tree, it answers a screenshot instead: act at its pixels.`;

const ACT = `Run steps on an app, in order: press (an element's own action: the surest), set (a field's text, a switch's "on"), click, type, key (a chord: "enter", "super+s"), scroll, drag, nav (back, home, app_switch), perform. A step names an element by its ref from computer_observe, or a point in the window's points; a step at a point is read against a state (the app's last observe when you give none) and is refused as stale once the window changed under it. expect waits after the steps until a text shows (with gone: until it is gone); no steps and an expect is a wait. Each step says its route (semantic, page, background, foreground) and whether a readback verified it, and the answer ends with whether the window changed and the new state. observe: true adds the new outline, one call instead of two. The first refused step stops the rest. Several known steps go in one call; for longer known sequences, or reading many elements, use computer_script.`;

const SCREENSHOT = "A screenshot of the computer's whole screen, as an image, in screen pixels. region: only that part, [x, y, w, h], still in the whole screen's pixels. computer_observe with image: true shows one app's window, beside its elements: prefer it.";

/** computer_script's words: what a script is, and the `computer` object's declarations for these groups. */
const scriptWords = (groups: readonly string[]): string =>
  `Run JavaScript against the computer: the body of an async function, with \`computer\` bound. Use it for steps you already know (one script instead of many calls) and to read what you need out of an observation; return only what your next decision needs (a few fields, a short outline), never whole observations. text(...) and image(...) show words and images (an Image from observe or screen.shot) beside the returned value. A refused step throws with the computer's words. No network, no keys: only the computer. The \`computer\` object:\n\n\`\`\`ts\n${computerDeclarations(groups)}\n\`\`\``;

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
