/** Where an agent's runs execute (a definition's `place`, a run's `place`) and what this server offers
 *  (capabilities `places`). The server's words for a box it lacks (`reason`) are shown as it gives them. */
export type Place = { mode: "runner" } | { mode: "sandbox"; box: string };
export type BoxOffer = { id: string; available: boolean; reason?: string };
export type Places = { modes: string[]; default: string; boxes: BoxOffer[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A place as the server sent it, or undefined for none (the server's default) or a shape this console does not know. */
export function placeOf(v: unknown): Place | undefined {
  if (!isObject(v)) return undefined;
  if (v.mode === "runner") return { mode: "runner" };
  if (v.mode === "sandbox" && typeof v.box === "string") return { mode: "sandbox", box: v.box };
  return undefined;
}

/** Capabilities' `places`, or null on a server without places (it has no picker to offer). */
export function placesOf(caps: unknown): Places | null {
  const p = isObject(caps) ? caps.places : undefined;
  if (!isObject(p) || !Array.isArray(p.modes) || !Array.isArray(p.boxes)) return null;
  const boxes = p.boxes.filter(isObject).filter((b) => typeof b.id === "string")
    .map((b) => ({ id: b.id as string, available: b.available === true, ...(typeof b.reason === "string" ? { reason: b.reason } : {}) }));
  return { modes: p.modes.filter((m): m is string => typeof m === "string"), default: typeof p.default === "string" ? p.default : "runner", boxes };
}

/** Where a place runs, in words: "Runs in a docker box" or "Runs on the server". None is the server's default. */
export function placeWords(place: Place | undefined, places: Places | null): string {
  const p = place ?? (places?.default === "sandbox" ? undefined : { mode: "runner" as const });
  if (!p) return "Runs where this server's default puts it";
  return p.mode === "sandbox" ? `Runs in a ${p.box} box` : "Runs on the server";
}

/** A run that ran on the server though its revision names a box: its start narrowed the place (a "Run on the server
 *  instead", say). */
export const narrowed = (revision: Place | undefined, run: Place | undefined) => revision?.mode === "sandbox" && run?.mode === "runner";
