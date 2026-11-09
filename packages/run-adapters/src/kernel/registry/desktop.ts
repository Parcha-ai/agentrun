// A desktop computer's tools: desktop_screen takes a screenshot (computerd's screen.shot), desktop_input runs a batch of
// pointer and keyboard actions (computerd's input.actions), each on the run's hands' narrow port (hands.screen,
// hands.input). The actions are computerd's own, of the pointer and the keys and nothing more: the computer checks each
// batch whole (its key table, its limits) and refuses it in its own words before anything runs. Main has no model-visible
// desktop tool, so these words are new; the key names and the batch's limit are computerd's, held equal to its own by a
// test (serve's computer-tools parity test).
import type { ToolDef } from "./defs.js";
import { answerOf, type Executor, type Hands, type InputAction, needsKindWords, shotAnswer } from "./hands.js";

/** computerd's key table (protocol.ts KEYS): a key is one of these names, or one printable ASCII character. */
export const DESKTOP_KEYS = [
  "enter", "tab", "space", "backspace", "delete", "escape", "insert",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "shift", "ctrl", "alt", "super", "capslock",
] as const;
/** The most actions one desktop_input call holds: computerd's MAX_ACTIONS. */
export const DESKTOP_MAX_ACTIONS = 100;
/** The actions desktop_input offers, of computerd's input.actions. */
export const DESKTOP_ACTIONS = ["move", "click", "drag", "scroll", "type", "key"] as const;

const def = (name: string, description: string, parameters: object, replaySafe: boolean): ToolDef => ({
  name, source: "host", gateName: `host:desktop/${name}`, settingsKey: "desktop", description, parameters, replaySafe,
});
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const POINT = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in screenshot pixels, origin top left." };
const BUTTON = { type: "string", enum: ["left", "right", "middle"], description: "left when absent." };
const KEY = { type: "string", description: "A key name (enter, tab, space, backspace, delete, escape, insert, up, down, left, right, home, end, pageup, pagedown, f1 to f12, shift, ctrl, alt, super, capslock) or one printable character (\"a\", \"A\", \"/\")." };
const action = (type: string, properties: Record<string, unknown>, required: string[], description: string) =>
  ({ ...object({ type: { const: type }, ...properties }, ["type", ...required]), description });

export const DESKTOP_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  def(
    "desktop_screen",
    "Take a screenshot of the desktop computer's screen, as an image. Its pixels are the coordinates desktop_input takes, origin top left. With region, only that part of the screen, still in the whole screen's coordinates.",
    object({
      region: { ...object({ x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, w: { type: "integer", minimum: 1 }, h: { type: "integer", minimum: 1 } }, ["x", "y", "w", "h"]), description: "Only this part of the screen: its top left corner and its size, in screenshot pixels." },
    }, []),
    true,
  ),
  def(
    "desktop_input",
    `Act on the desktop computer with a list of actions, run in order: move the pointer, click, drag, scroll, type text, press keys. Points are [x, y] in the pixels of a desktop_screen screenshot, origin top left. Several keys in one key action press together, as a combo ("ctrl", "c"). A list with a malformed action runs nothing; one that fails partway says how many ran. It answers no image: take a screenshot to see what the actions did. At most ${DESKTOP_MAX_ACTIONS} actions a call.`,
    object({
      actions: {
        type: "array",
        minItems: 1,
        maxItems: DESKTOP_MAX_ACTIONS,
        items: {
          oneOf: [
            action("move", { at: POINT }, ["at"], "Move the pointer to at."),
            action("click", { at: POINT, button: BUTTON, count: { type: "integer", enum: [1, 2, 3], description: "1 when absent; 2 is a double click." } }, [], "Click at at (where the pointer is when absent)."),
            action("drag", { path: { type: "array", items: POINT, minItems: 2, description: "The points to drag through, from the first to the last." }, button: BUTTON }, ["path"], "Press at the path's first point, move through it, release at its last."),
            action("scroll", { at: POINT, dx: { type: "number" }, dy: { type: "number", description: "Above 0 scrolls down." }, unit: { type: "string", enum: ["clicks", "px"], description: "Wheel clicks, or pixels where the computer scrolls by pixels." } }, ["unit"], "Scroll at at (where the pointer is when absent)."),
            action("type", { text: { type: "string" } }, ["text"], "Type text, as given, into what has focus."),
            action("key", { keys: { type: "array", items: KEY, minItems: 1 } }, ["keys"], "Press a key, or several together as a combo."),
          ],
        },
      },
    }, ["actions"]),
    false,
  ),
]);

const isWhole = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const regionOf = (value: unknown) => {
  if (value === undefined) return undefined;
  const region = value as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  if (typeof region !== "object" || region === null || !isWhole(region.x, 0) || !isWhole(region.y, 0) || !isWhole(region.w, 1) || !isWhole(region.h, 1)) {
    throw new Error("region is {x, y, w, h}: x and y whole numbers from 0, w and h whole numbers above 0");
  }
  return { x: region.x, y: region.y, w: region.w, h: region.h };
};

/** The batch as given, once each action is one of the six: the computer checks the rest, whole, before anything runs. */
const actionsOf = (value: unknown): readonly InputAction[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > DESKTOP_MAX_ACTIONS) throw new Error(`actions is a list of 1 to ${DESKTOP_MAX_ACTIONS} actions`);
  for (const [index, one] of value.entries()) {
    const type = (one as { type?: unknown } | null)?.type;
    if (!(DESKTOP_ACTIONS as readonly unknown[]).includes(type)) throw new Error(`action ${index} is a ${JSON.stringify(type)}: an action is one of ${DESKTOP_ACTIONS.join(", ")}`);
  }
  return value as InputAction[];
};

const port = <K extends "screen" | "input">(hands: Hands, key: K, tool: string): NonNullable<Hands[K]> => {
  const found = hands[key];
  if (!found) throw new Error(needsKindWords(tool, "desktop"));
  return found;
};

/** The desktop's tools' runs, on the hands' screen and input. */
export const DESKTOP_EXECUTORS: Readonly<Record<string, Executor>> = Object.freeze({
  desktop_screen: (args, call) => answerOf(call, async () => {
    const screen = port(call.hands, "screen", "desktop_screen");
    const region = regionOf((args as { region?: unknown } | null)?.region);
    const shot = await screen.shot(region ? { region } : {});
    return shotAnswer(
      region
        ? `A screenshot of the screen's region at (${region.x}, ${region.y}), ${region.w}x${region.h} pixels, in the whole screen's coordinates.`
        : `A screenshot of the whole screen, ${shot.width}x${shot.height} pixels.`,
      shot,
    );
  }),
  desktop_input: (args, call) => answerOf(call, async () => {
    const input = port(call.hands, "input", "desktop_input");
    const actions = actionsOf((args as { actions?: unknown } | null)?.actions);
    await input.actions(actions);
    return { text: `Ran ${actions.length} action${actions.length === 1 ? "" : "s"}. desktop_screen shows what ${actions.length === 1 ? "it" : "they"} did.` };
  }),
});
