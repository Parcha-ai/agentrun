// A phone computer's tools, on the run's hands' phone port (hands.phone): a screenshot, a tap, a swipe, typing into the
// field in focus, the installed apps, and opening one. The coordinates are the screenshot's pixels. Main has no
// model-visible phone tool, so these words are new.
import type { ToolDef } from "./defs.js";
import { answerOf, type Executor, type Hands, type PhonePoint, needsKindWords, shotAnswer } from "./hands.js";

/** How long a swipe takes when a call names no duration, and the longest one may. */
export const PHONE_SWIPE_MS = 300;
export const PHONE_SWIPE_MAX_MS = 10_000;

const def = (name: string, description: string, parameters: object, replaySafe: boolean): ToolDef => ({
  name, source: "host", gateName: `host:phone/${name}`, settingsKey: "phone", description, parameters, replaySafe,
});
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const COORDINATE = { type: "integer", minimum: 0 };
const POINT = { ...object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]), description: "A point in screenshot pixels, origin top left." };

export const PHONE_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  def("phone_screen", "Take a screenshot of the phone's screen, as an image. Its pixels are the coordinates phone_tap and phone_swipe take, origin top left.", object({}, []), true),
  def("phone_tap", "Tap the phone's screen once at x, y, in the pixels of a phone_screen screenshot.", object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]), false),
  def(
    "phone_swipe",
    `Swipe on the phone's screen from one point to another, in screenshot pixels, over duration_ms (${PHONE_SWIPE_MS} ms when absent). A swipe up scrolls a list down.`,
    object({ from: POINT, to: POINT, duration_ms: { type: "integer", minimum: 1, maximum: PHONE_SWIPE_MAX_MS } }, ["from", "to"]),
    false,
  ),
  def("phone_type", "Type text into the field that has focus on the phone, as given. Tap the field first.", object({ text: { type: "string", minLength: 1 } }, ["text"]), false),
  def("phone_apps", "List the phone's installed apps, each by its id (and its name where the phone gives one), and which app is in front.", object({}, []), true),
  def("phone_open", "Open an app on the phone by its id (phone_apps lists them), bringing it to the front.", object({ id: { type: "string", minLength: 1 } }, ["id"]), false),
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

/** The phone's tools' runs, on the hands' phone. */
export const PHONE_EXECUTORS: Readonly<Record<string, Executor>> = Object.freeze({
  phone_screen: run("phone_screen", async (phone) => {
    const shot = await phone.shot();
    return shotAnswer(`A screenshot of the phone's screen, ${shot.width}x${shot.height} pixels.`, shot);
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
});
