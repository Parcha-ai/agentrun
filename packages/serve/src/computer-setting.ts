// An agent's computer, its one setting for where its tools run (Settings → Computers): `computer: { kind, provider? }` on
// its revision. kind is none, sandbox, desktop, phone or browser; provider names one of the computer providers (the
// computer package's kind registry), and is absent for none. The v2 API's `place` is this setting's view, one to one where
// it can say it: {mode: "runner"} is {kind: "none"}, and {mode: "sandbox", box: X} is {kind: "sandbox", provider: X}.
// Writing either sets both. A desktop, phone or browser computer leaves the run's folder on the runner, so its place reads
// runner.
import type { InputIssue } from "./errors.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The kinds of computer an agent can be given. */
export const COMPUTER_KINDS = ["none", "sandbox", "desktop", "phone", "browser"] as const;
export type ComputerKind = (typeof COMPUTER_KINDS)[number];

/** The setting as a revision keeps it. */
export type ComputerSetting = { readonly kind: "none" } | { readonly kind: Exclude<ComputerKind, "none">; readonly provider: string };

/** A place as the v2 API names it. */
export type PlaceView = { mode: "runner" } | { mode: "sandbox"; box: string };

/** The place the setting reads as: sandbox on its provider, else the runner (no computer holds the run's folder). */
export const placeOfComputer = (computer: ComputerSetting): PlaceView => (computer.kind === "sandbox" ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });

/** The setting a place says: runner is no computer, a sandbox place a sandbox on its box. */
export const computerOfPlace = (place: PlaceView): ComputerSetting => (place.mode === "sandbox" ? { kind: "sandbox", provider: place.box } : { kind: "none" });

/** Whether two settings are the one setting. */
export const sameComputer = (a: ComputerSetting, b: ComputerSetting): boolean => a.kind === b.kind && (a.kind === "none" || a.provider === (b as { provider: string }).provider);

/** Why a browser computer is refused on this server for now: nothing here wires a Browser computer's CDP connection into
 *  a run, so a run of one would fail at its start. Refused instead, in these words, at the agent's save (computerIssues),
 *  at a run's start (resolve-computer.ts computerReadiness) and in Settings → Computers (computers.ts view). The browser
 *  tool (Settings → Tools) browses the web without one. */
export const BROWSER_COMPUTER_REFUSED = "Browser computers don't run on this server yet: use the browser tool (Settings → Tools) for web browsing.";

/** Whether a computer setting's kind is a browser computer's, which this server refuses for now (BROWSER_COMPUTER_REFUSED). */
export const isRefusedBrowserComputer = (kind: unknown): boolean => kind === "browser";

/** What is wrong with `value` as a computer setting, at `field`: its shape (the providers are the server's), and a
 *  browser computer, refused here for now (BROWSER_COMPUTER_REFUSED). */
export function computerIssues(value: unknown, field: string): InputIssue[] {
  const bad = (reason: string, message: string, fix?: string): InputIssue[] => [{ field, reason, message, ...(fix ? { fix } : {}) }];
  if (!isObject(value)) return bad("wrong_type", `${field} is an object: {kind}, or {kind, provider}`);
  const extra = Object.keys(value).filter((key) => key !== "kind" && key !== "provider");
  if (extra.length) return bad("not_allowed", `${field} keeps only kind and provider, not ${extra.join(" or ")}`, `Remove ${extra.map((key) => `${field}.${key}`).join(" and ")}.`);
  if (typeof value.kind !== "string" || !(COMPUTER_KINDS as readonly string[]).includes(value.kind)) return bad(value.kind === undefined ? "missing" : "not_an_option", `${field}.kind is one of ${COMPUTER_KINDS.join(", ")}`);
  if (isRefusedBrowserComputer(value.kind)) return bad("not_an_option", BROWSER_COMPUTER_REFUSED, `Set ${field} to {"kind": "none"} and grant the browser tool.`);
  if (value.kind === "none") return value.provider === undefined ? [] : bad("not_allowed", "no computer names no provider", `Remove ${field}.provider.`);
  if (typeof value.provider !== "string" || value.provider === "") return bad("missing", `a ${value.kind} computer names its provider (Settings → Computers lists them)`);
  return [];
}

/** The setting and its place a definition says, from `computer` or `place` (both: they must agree), or undefined when
 *  it says neither. Each is checked already (computerIssues, placeIssues). */
export function settingOfDefinition(definition: { computer?: unknown; place?: unknown }): { computer: ComputerSetting; place: PlaceView } | undefined {
  if (isObject(definition.computer)) {
    const computer = definition.computer as ComputerSetting;
    return { computer, place: placeOfComputer(computer) };
  }
  if (isObject(definition.place)) {
    const place = definition.place as PlaceView;
    return { computer: computerOfPlace(place), place };
  }
  return undefined;
}

/** Why `computer` and `place`, both given, are not one setting, at `field`; none when they agree. */
export function settingConflict(computer: unknown, place: unknown, field: string): InputIssue[] {
  if (!isObject(computer) || !isObject(place) || computerIssues(computer, `${field}.computer`).length) return [];
  const said = computerOfPlace(place as PlaceView);
  if (sameComputer(computer as ComputerSetting, said)) return [];
  return [{ field: `${field}.place`, reason: "invalid", message: "computer and place say two settings: give one (place is computer's v2 view)", fix: `Remove ${field}.place, or make it ${JSON.stringify(placeOfComputer(computer as ComputerSetting))}.` }];
}
