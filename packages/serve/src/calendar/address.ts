// The server's one calendar (Settings → Calendar, /v2/settings/calendar): its iCal address, which is a credential (anyone
// who has it reads the calendar), kept in ONE row of the one store's sealed keys (CALENDAR_ROW, beside the tool keys and
// the email account) with the calendar's own name and time zone as the save last read them. Opened only with the seal
// key: by the server for the settings view and the test, and by a runner for a run whose revision names calendar_events
// (tools.ts). No answer, event, log line or run input holds the address: the runner's one redactor holds each of its
// forms (addressForms), read out of this row (runner/store-secrets.ts), and the server's list holds the ones saved since
// it started (server.ts).
import { ApiError, invalid } from "../errors.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "../server-keys.js";
import type { SealedKeys } from "../store/index.js";
import { isObject, unknownFields } from "../validate.js";
import { ADDRESS_MAX, CALENDAR_ROW, NO_CALENDAR } from "./names.js";

export type CalendarStore = { sealedKeys: Pick<SealedKeys, "get" | "put" | "remove">; flush?(): Promise<void> };
/** The calendar as the server keeps it: its address (https, or http to a loopback fake), and its own name
 *  (X-WR-CALNAME) and time zone as the save read them, null when that read failed. */
export type SavedCalendar = { url: string; name: string | null; time_zone: string | null };

/** A URL's hostname on loopback as written (localhost, 127.0.0.0/8, [::1]): only there is plain http taken, for the fakes. */
export const LOOPBACK_NAME = /^(?:localhost|\[::1\]|127(?:[.]\d{1,3}){3})$/; // key-gate: loopback-rule only a loopback fake calendar is read over plain http
const CONTROL = /[\u0000- \u007f-\u009f]/;

/** The address a body gives, as it is kept: `webcal://` (and `webcals://`) read as https, any other scheme but https
 *  refused, and plain http taken to a loopback address alone. 422 by `field`, in words, never echoing the address. */
export function addressOf(value: unknown, field = "url"): string {
  const bad = (message: string) => invalid([{ field, reason: "invalid", message }]);
  if (typeof value !== "string") throw invalid([{ field, reason: value === undefined ? "missing" : "wrong_type", message: `${field} is the calendar's iCal address, as text (https://… or webcal://…).` }]);
  const given = value.trim();
  if (!given || given.length > ADDRESS_MAX) throw bad(`${field} is 1 to ${ADDRESS_MAX} characters.`);
  if (CONTROL.test(given)) throw bad(`${field} holds a space or a control character: paste the address whole, on one line.`);
  const swapped = given.replace(/^webcals?:\/\//i, "https://");
  const url = URL.parse(swapped);
  if (!url) throw bad(`${field} is not an address: paste the calendar's iCal address (https://… or webcal://…).`);
  if (url.username || url.password) throw bad(`${field} carries a user and password: use the calendar's secret iCal address, which needs none.`);
  if (url.protocol === "http:" && !LOOPBACK_NAME.test(url.hostname)) throw bad(`${field} is http: a calendar is read over https only (webcal:// is read as https://).`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad(`${field} is ${url.protocol.replace(/:$/, "")}: a calendar is read over https only (webcal:// is read as https://).`);
  url.hash = "";
  return url.href;
}

/** Every form of `url` that text may carry it in, longest first: as kept, as webcal, decoded, and its path with its
 *  query (where a provider keeps the secret part) when that is long enough to be one. What the redactors hold. */
export function addressForms(url: string): string[] {
  const forms = new Set<string>([url]);
  const parsed = URL.parse(url);
  if (parsed) {
    forms.add(parsed.href);
    if (parsed.protocol === "https:") forms.add(`webcal://${parsed.href.slice("https://".length)}`);
    const secret = `${parsed.pathname}${parsed.search}`;
    if (secret.length >= 16) forms.add(secret);
    for (const one of [...forms]) {
      try {
        forms.add(decodeURIComponent(one));
      } catch {}
    }
  }
  return [...forms].filter((one) => one.length >= 8).sort((a, b) => b.length - a.length);
}

/** Each form of `url` cut from `text` (a fetch error, a calendar's own text): the address is never said. */
export function scrubAddress(text: string, url: string | undefined): string {
  if (!url) return text;
  let out = text;
  for (const form of addressForms(url)) out = out.split(form).join("[the calendar's address]");
  return out;
}

/** An opened row read: the calendar, or undefined when it is not the shape a save writes. */
function keptOf(plain: string | undefined): SavedCalendar | undefined {
  let value: unknown;
  try {
    value = plain === undefined ? undefined : JSON.parse(plain);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.v !== 1 || typeof value.url !== "string") return undefined;
  const text = (one: unknown) => (typeof one === "string" ? one : null);
  return { url: value.url, name: text(value.name), time_zone: text(value.time_zone) };
}

/** The address of an opened calendar row, in each of its forms (runner/store-secrets.ts: the one redactor holds them, not
 *  the row's JSON). */
export const calendarRowSecrets = (plain: string): string[] => {
  const url = keptOf(plain)?.url;
  return url ? addressForms(url) : [];
};

/** The calendar kept now, opened with `sealKey`; undefined when none is kept, or its row does not open (sealed under
 *  another key) or read. */
export async function openCalendar(store: CalendarStore, sealKey: Buffer): Promise<SavedCalendar | undefined> {
  if ((await store.sealedKeys.get(CALENDAR_ROW)) === undefined) return undefined;
  return keptOf(await getSealedKey(store, sealKey, CALENDAR_ROW));
}

/** The calendar's view (GET /settings/calendar): whether one is kept, the host it is read from, and its own name and time
 *  zone. Never its address. */
export async function calendarView(store: CalendarStore, sealKey: Buffer) {
  const kept = await openCalendar(store, sealKey);
  if (!kept) return { configured: false, host: null, name: null, time_zone: null };
  return { configured: true, host: URL.parse(kept.url)?.host ?? null, name: kept.name, time_zone: kept.time_zone };
}

/** The calendar saved whole, in one write. */
export async function saveCalendar(store: CalendarStore, sealKey: Buffer, calendar: SavedCalendar): Promise<void> {
  await putSealedKey(store, sealKey, CALENDAR_ROW, JSON.stringify({ v: 1, url: calendar.url, name: calendar.name, time_zone: calendar.time_zone }));
  await store.flush?.();
}

/** The calendar forgotten: its one row, in one write. */
export async function removeCalendar(store: CalendarStore): Promise<void> {
  await removeSealedKey(store, CALENDAR_ROW);
  await store.flush?.();
}

/** A PUT's or a test's body, `{url}`, read: its address, or 422 in words. */
export function bodyAddress(body: unknown): string {
  if (!isObject(body)) throw invalid([{ field: "", reason: "wrong_type", message: "The body is {url}: the calendar's iCal address." }]);
  const unknown = unknownFields(body, ["url"]);
  if (unknown.length) throw invalid(unknown);
  return addressOf(body.url);
}

/** The refusal for a test of the saved calendar when none is kept. */
export const noCalendar = () => new ApiError("input_invalid", NO_CALENDAR, { fields: [{ field: "url", reason: "not_set", message: NO_CALENDAR }] });
