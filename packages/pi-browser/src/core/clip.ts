// A screenshot of a region: the page's own rectangle for a clip the model names, or for an element it names by snapshot ID or CSS
// selector. Every refusal is typed and says why, before a capture is made.
import { BrowserFailureError } from "./custody.js";
import type { Clip } from "./images.js";

export type Target = { id?: string; selector?: string };
/** What the page says about a target now: the viewport, and for an element how many match and, when one does, its box in CSS pixels
 *  from the viewport's top-left corner after it was scrolled into view. */
export type Located = { viewport: { width: number; height: number }; matches?: number; box?: Clip | null };
export type Locate = (target?: Target) => Promise<Located>;
export type Region = { clip: Clip; of: { id: string } | { selector: string } | null };

const refuse = (message: string): never => { throw new BrowserFailureError({ ok: false, code: "refused", retryable: false, effect: "none", message: `screenshot: ${message} No capture was made.` }); };
const fits = (box: Clip, viewport: Located["viewport"]): boolean => box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;
const shown = (box: Clip): string => `x ${round(box.x)}, y ${round(box.y)}, ${round(box.width)} wide, ${round(box.height)} high`;
const round = (n: number): number => Math.round(n * 10) / 10;

/** The model this harness runs sends every property of a tool's schema, an empty one for each it has no use for: "" for text, 0 for
 *  numbers. So a blank id or selector, and a clip with no width and no height, are no request at all, and `fullPage` beside a region
 *  gives way to the region. */
const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const unsetClip = (c: unknown): boolean => c === undefined || c === null || (typeof c === "object" && Number((c as { width?: unknown }).width) === 0 && Number((c as { height?: unknown }).height) === 0);

/** The region the arguments ask for, or null for the whole page; throws a typed `refused` for one that cannot be captured. */
export async function regionOf(args: { clip?: unknown; id?: unknown; selector?: unknown; fullPage?: boolean }, locate: Locate | undefined): Promise<Region | null> {
  const given = [!unsetClip(args.clip), !blank(args.id), !blank(args.selector)].filter(Boolean).length;
  if (given === 0) return null;
  if (given > 1) refuse("give one of clip, id or selector, not several.");
  if (!locate) refuse("this browser driver cannot place a region on the page.");
  const place = locate!;

  if (!unsetClip(args.clip)) {
    const c = args.clip as Partial<Record<keyof Clip, unknown>> | null;
    const clip = { x: Number(c?.x), y: Number(c?.y), width: Number(c?.width), height: Number(c?.height) };
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) refuse("clip needs numbers for x, y, width and height.");
    if (clip.width <= 0 || clip.height <= 0) refuse(`the clip is empty (${clip.width} wide, ${clip.height} high).`);
    const { viewport } = await place();
    if (!fits(clip, viewport)) refuse(`the clip (${shown(clip)}) leaves the viewport (${viewport.width} wide, ${viewport.height} high); scroll to it, or ask for a smaller one.`);
    return { clip, of: null };
  }

  const id = blank(args.id) ? undefined : String(args.id).trim();
  const selector = blank(args.selector) ? undefined : String(args.selector).trim();
  const what = id !== undefined ? `id ${id}` : `selector ${selector}`;
  const found = await place(id !== undefined ? { id } : { selector });
  if (!found.matches) refuse(`${what} matches nothing on the page now.`);
  if (found.matches! > 1) refuse(`${what} matches ${found.matches} elements; it must match exactly one.`);
  const box = found.box;
  if (!box || !(box.width > 0) || !(box.height > 0)) refuse(`the element ${what} has no area (it is empty or hidden).`);
  if (!fits(box!, found.viewport)) refuse(`the element ${what} (${shown(box!)}) does not fit the viewport (${found.viewport.width} wide, ${found.viewport.height} high) once scrolled into view; use a clip inside it.`);
  return { clip: box!, of: id !== undefined ? { id } : { selector: selector! } };
}
