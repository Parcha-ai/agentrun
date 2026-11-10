// An agent's computer, its one setting for where its tools run (Settings → Computers): `computer: { kind, provider?, gpu? }`
// on its revision. kind is none, sandbox, desktop, phone or browser; provider names one of the computer providers (the
// computer package's kind registry), and is absent for none; a sandbox's gpu is { type, count }. The v2 API's `place` is this setting's view, one to one where
// it can say it: {mode: "runner"} is {kind: "none"}, and {mode: "sandbox", box: X} is {kind: "sandbox", provider: X}.
// Writing either sets both. A desktop, phone or browser computer leaves the run's folder on the runner, so its place reads
// runner.
import type { InputIssue } from "./errors.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The kinds of computer an agent can be given. */
export const COMPUTER_KINDS = ["none", "sandbox", "desktop", "phone", "browser"] as const;
export type ComputerKind = (typeof COMPUTER_KINDS)[number];

/** A sandbox's GPUs: a type its provider declares (GET /v2/computers lists each provider's) and how many. */
export type GpuSetting = { readonly type: string; readonly count: number };

/** The setting as a revision keeps it. A sandbox may ask for GPUs; whether its provider gives them is the claim's check. */
export type ComputerSetting =
  | { readonly kind: "none" }
  | { readonly kind: "sandbox"; readonly provider: string; readonly gpu?: GpuSetting }
  | { readonly kind: Exclude<ComputerKind, "none" | "sandbox">; readonly provider: string };

/** A GPU type's name as a setting keeps it: the vendor's own ("T4", "A100-80GB", "RTX-PRO-6000"); store/agent-body.ts
 *  keeps the same. */
const GPU_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The GPUs a setting asks for, or undefined. */
export const gpuOf = (computer: { readonly kind: string; readonly gpu?: GpuSetting | null }): GpuSetting | undefined => (computer.kind === "sandbox" && computer.gpu ? computer.gpu : undefined);

/** A place as the v2 API names it. */
export type PlaceView = { mode: "runner" } | { mode: "sandbox"; box: string };

/** The place the setting reads as: sandbox on its provider, else the runner (no computer holds the run's folder). */
export const placeOfComputer = (computer: ComputerSetting): PlaceView => (computer.kind === "sandbox" ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });

/** The setting a place says: runner is no computer, a sandbox place a sandbox on its box. */
export const computerOfPlace = (place: PlaceView): ComputerSetting => (place.mode === "sandbox" ? { kind: "sandbox", provider: place.box } : { kind: "none" });

/** Whether two settings are the one setting: the kind and the provider (a place says no GPUs, so they are not compared). */
export const sameComputer = (a: ComputerSetting, b: ComputerSetting): boolean => a.kind === b.kind && (a.kind === "none" || a.provider === (b as { provider: string }).provider);

/** What is wrong with `value` as a computer setting, at `field`: its shape only (the providers are the server's). A
 *  sandbox's gpu is { type, count } in the words the computer package's checkGpu uses; whether its provider offers that
 *  type and count is the readiness check's and the claim's (resolve-computer.ts), in checkGpu's own words. */
export function computerIssues(value: unknown, field: string): InputIssue[] {
  const bad = (reason: string, message: string, fix?: string): InputIssue[] => [{ field, reason, message, ...(fix ? { fix } : {}) }];
  if (!isObject(value)) return bad("wrong_type", `${field} is an object: {kind}, or {kind, provider}, and a sandbox's optional gpu`);
  const extra = Object.keys(value).filter((key) => key !== "kind" && key !== "provider" && key !== "gpu");
  if (extra.length) return bad("not_allowed", `${field} keeps only kind, provider and a sandbox's gpu, not ${extra.join(" or ")}`, `Remove ${extra.map((key) => `${field}.${key}`).join(" and ")}.`);
  if (typeof value.kind !== "string" || !(COMPUTER_KINDS as readonly string[]).includes(value.kind)) return bad(value.kind === undefined ? "missing" : "not_an_option", `${field}.kind is one of ${COMPUTER_KINDS.join(", ")}`);
  if (value.gpu !== undefined && value.kind !== "sandbox") return bad("not_allowed", `only a sandbox computer takes a gpu, not a ${value.kind} one`, `Remove ${field}.gpu.`);
  if (value.kind === "none") return value.provider === undefined ? [] : bad("not_allowed", "no computer names no provider", `Remove ${field}.provider.`);
  if (typeof value.provider !== "string" || value.provider === "") return bad("missing", `a ${value.kind} computer names its provider (Settings → Computers lists them)`);
  if (value.gpu !== undefined) {
    const gpu = value.gpu;
    if (!isObject(gpu) || Object.keys(gpu).some((key) => key !== "type" && key !== "count")) return [{ field: `${field}.gpu`, reason: "wrong_type", message: "gpu is { type, count }: a GPU type this provider declares, and how many" }];
    if (typeof gpu.type !== "string" || gpu.type === "") return [{ field: `${field}.gpu.type`, reason: "missing", message: "gpu.type is a GPU type the provider declares (GET /v2/computers lists each provider's)" }];
    if (!GPU_TYPE.test(gpu.type)) return [{ field: `${field}.gpu.type`, reason: "wrong_type", message: `gpu.type ${JSON.stringify(gpu.type)} is not a GPU type name: letters, digits, dots, underscores and dashes, as GET /v2/computers lists each provider's` }];
    if (!Number.isSafeInteger(gpu.count) || (gpu.count as number) < 1) return [{ field: `${field}.gpu.count`, reason: "wrong_type", message: `gpu.count ${JSON.stringify(gpu.count)} is not a whole number from 1` }];
  }
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
