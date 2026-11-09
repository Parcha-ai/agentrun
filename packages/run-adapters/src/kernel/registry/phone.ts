// A phone computer's tools, on the run's hands' phone port (hands.phone): a screenshot, the screen's structure (the nodes
// a model can tap or type into), a tap, a swipe, typing into the field in focus, its back, home and enter keys, the
// installed apps, and opening one. The coordinates are the screenshot's pixels. Main has no model-visible phone tool, so
// these words are new.
import type { ToolDef } from "./defs.js";
import { answerOf, type Executor, type Hands, type PhoneKey, type PhoneNode, type PhonePoint, needsKindWords, shotAnswer } from "./hands.js";
import { HANDOFF_TOOL, handoffDef, handoffExecutor } from "./handoff.js";

/** How long a swipe takes when a call names no duration, and the longest one may. */
export const PHONE_SWIPE_MS = 300;
export const PHONE_SWIPE_MAX_MS = 10_000;
/** The most nodes phone_tree lists, and the most characters its answer takes: past either, one line counts the rest. A
 *  screen's structure can hold thousands of nodes; the answer stays a screenful, never a flood in the model's context or
 *  the run's journal. */
export const PHONE_TREE_MAX_NODES = 150;
export const PHONE_TREE_MAX_CHARS = 12_000;
/** The most characters of a node's text or label phone_tree shows. */
const PHONE_TREE_TEXT_CHARS = 80;
/** The keys phone_key presses. */
export const PHONE_KEYS: readonly PhoneKey[] = Object.freeze(["back", "home", "enter"]);

const def = (name: string, description: string, parameters: object, replaySafe: boolean): ToolDef => ({
  name, source: "host", gateName: `host:phone/${name}`, settingsKey: "phone", description, parameters, replaySafe,
});
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const COORDINATE = { type: "integer", minimum: 0 };
const POINT = { ...object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]), description: "A point in screenshot pixels, origin top left." };

export const PHONE_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  def("phone_screen", "Take a screenshot of the phone's screen, as an image. Its pixels are the coordinates phone_tap and phone_swipe take, origin top left.", object({}, []), true),
  def(
    "phone_tree",
    `List what on the phone's screen can be tapped or typed into, from the screen's structure: each node's class, its text or label, its id, and its center and bounds in a phone_screen screenshot's pixels (tap the center). At most ${PHONE_TREE_MAX_NODES} nodes; a last line counts any more.`,
    object({}, []),
    true,
  ),
  def("phone_tap", "Tap the phone's screen once at x, y, in the pixels of a phone_screen screenshot.", object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]), false),
  def(
    "phone_swipe",
    `Swipe on the phone's screen from one point to another, in screenshot pixels, over duration_ms (${PHONE_SWIPE_MS} ms when absent). A swipe up scrolls a list down.`,
    object({ from: POINT, to: POINT, duration_ms: { type: "integer", minimum: 1, maximum: PHONE_SWIPE_MAX_MS } }, ["from", "to"]),
    false,
  ),
  def("phone_type", "Type text into the field that has focus on the phone, as given. Tap the field first.", object({ text: { type: "string", minLength: 1 } }, ["text"]), false),
  def(
    "phone_key",
    "Press one of the phone's keys: back (the system back: leaves a page, closes a dialog or the keyboard), home (the home screen) or enter (submits the field in focus).",
    object({ key: { type: "string", enum: [...PHONE_KEYS] } }, ["key"]),
    false,
  ),
  def("phone_apps", "List the phone's installed apps, each by its id (and its name where the phone gives one), and which app is in front.", object({}, []), true),
  def("phone_open", "Open an app on the phone by its id (phone_apps lists them), bringing it to the front.", object({ id: { type: "string", minLength: 1 } }, ["id"]), false),
  // The agent's hand-over of the phone to the person (handoff.ts), under the phone's settings key.
  handoffDef("phone"),
]);

const POINT_WORDS = "x and y are whole numbers from 0, in the screenshot's pixels";
const pointOf = (value: unknown, what = POINT_WORDS): PhonePoint => {
  const point = value as { x?: unknown; y?: unknown } | null;
  if (typeof point !== "object" || point === null || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || (point.x as number) < 0 || (point.y as number) < 0) throw new Error(what);
  return { x: point.x as number, y: point.y as number };
};
const said = (point: PhonePoint) => `(${point.x}, ${point.y})`;
const phoneOf = (hands: Hands, tool: string): NonNullable<Hands["phone"]> => {
  if (!hands.phone) throw new Error(needsKindWords(tool, "phone"));
  return hands.phone;
};
const run = (tool: string, body: (phone: NonNullable<Hands["phone"]>, args: Record<string, unknown>) => Promise<{ text: string } | ReturnType<typeof shotAnswer>>): Executor =>
  (args, call) => answerOf(call, async () => body(phoneOf(call.hands, tool), (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>));

/** A node's class as a model reads it: the platform's, its package or iOS prefix dropped ("Button", "EditText"). */
const classOf = (role: string) => role.replace(/^XCUIElementType/, "").split(".").pop() || role;
const clip = (text: string) => (text.length > PHONE_TREE_TEXT_CHARS ? `${text.slice(0, PHONE_TREE_TEXT_CHARS - 1)}…` : text);
/** One node, on one line: its class, its text or label, its id, whether it is a field (and in focus), its center to tap and
 *  its bounds. */
function nodeLine(node: PhoneNode): string {
  const name = node.text || node.label;
  const { x, y, w, h } = node.bounds;
  const state = node.editable ? `a field${node.focused ? ", focused" : ""}; ` : node.focused ? "focused; " : "";
  const center = `(${Math.round(x + w / 2)}, ${Math.round(y + h / 2)})`;
  return `- ${clip(classOf(node.role))}${name ? ` ${JSON.stringify(clip(name))}` : ""}${node.id ? ` [${clip(node.id)}]` : ""}: ${state}center ${center}, bounds ${x},${y} ${w}x${h}`;
}
/** phone_tree's answer: a head line, then a line a node, at most PHONE_TREE_MAX_NODES of them and PHONE_TREE_MAX_CHARS
 *  characters in all; one last line counts the nodes not shown. */
function treeAnswer(tree: Awaited<ReturnType<NonNullable<Hands["phone"]>["tree"]>>): string {
  const nodes = tree.nodes.filter((node) => node.clickable || node.editable);
  const head = `${nodes.length} node${nodes.length === 1 ? "" : "s"} you can tap or type into, of ${tree.total} on the screen. Coordinates are a phone_screen screenshot's pixels.${tree.truncated ? " The phone gave only part of the screen's structure: take a phone_screen screenshot for the rest." : ""}`;
  const lines = [head];
  // Room kept for the last line, whatever it counts.
  let room = PHONE_TREE_MAX_CHARS - head.length - `\n${nodes.length} more nodes not shown.`.length;
  let shown = 0;
  for (const node of nodes) {
    if (shown >= PHONE_TREE_MAX_NODES) break;
    const line = nodeLine(node);
    if (line.length + 1 > room) break;
    lines.push(line);
    room -= line.length + 1;
    shown += 1;
  }
  if (shown < nodes.length) lines.push(`${nodes.length - shown} more node${nodes.length - shown === 1 ? "" : "s"} not shown.`);
  return lines.join("\n");
}

/** The phone's tools' runs, on the hands' phone. */
export const PHONE_EXECUTORS: Readonly<Record<string, Executor>> = Object.freeze({
  phone_screen: run("phone_screen", async (phone) => {
    const shot = await phone.shot();
    return shotAnswer(`A screenshot of the phone's screen, ${shot.width}x${shot.height} pixels.`, shot);
  }),
  phone_tree: run("phone_tree", async (phone) => ({ text: treeAnswer(await phone.tree()) })),
  phone_key: run("phone_key", async (phone, args) => {
    const key = args.key;
    if (typeof key !== "string" || !(PHONE_KEYS as readonly string[]).includes(key)) throw new Error(`key is ${PHONE_KEYS.slice(0, -1).join(", ")} or ${PHONE_KEYS.at(-1)}`);
    await phone.key(key as PhoneKey);
    return { text: `Pressed ${key}.` };
  }),
  phone_tap: run("phone_tap", async (phone, args) => {
    const at = pointOf(args);
    await phone.tap(at);
    return { text: `Tapped at ${said(at)}.` };
  }),
  phone_swipe: run("phone_swipe", async (phone, args) => {
    const from = pointOf(args.from, `from: ${POINT_WORDS}`);
    const to = pointOf(args.to, `to: ${POINT_WORDS}`);
    const durationMs = args.duration_ms ?? PHONE_SWIPE_MS;
    if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 1 || (durationMs as number) > PHONE_SWIPE_MAX_MS) throw new Error(`duration_ms is a whole number of milliseconds from 1 to ${PHONE_SWIPE_MAX_MS}`);
    await phone.swipe({ from, to, durationMs: durationMs as number });
    return { text: `Swiped from ${said(from)} to ${said(to)} over ${durationMs} ms.` };
  }),
  phone_type: run("phone_type", async (phone, args) => {
    if (typeof args.text !== "string" || args.text === "") throw new Error("text is the text to type");
    await phone.type(args.text);
    return { text: `Typed ${[...args.text].length} characters.` };
  }),
  phone_apps: run("phone_apps", async (phone) => {
    const { apps, foreground } = await phone.apps.list();
    const head = `${apps.length} app${apps.length === 1 ? "" : "s"}; ${foreground === null ? "none is in front" : `${foreground} is in front`}.`;
    return { text: [head, ...apps.map((app) => (app.name ? `${app.id} (${app.name})` : app.id))].join("\n") };
  }),
  phone_open: run("phone_open", async (phone, args) => {
    if (typeof args.id !== "string" || args.id === "") throw new Error("id is an app's id, as phone_apps lists it");
    await phone.apps.open(args.id);
    return { text: `Opened ${args.id}.` };
  }),
  [HANDOFF_TOOL]: handoffExecutor("phone"),
});
