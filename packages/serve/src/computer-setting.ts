// An agent's computer, its one setting for where its tools run (Settings → Computers): `computer: { kind, provider?,
// image?, gpu?, persistent?, surface?, exec? }` on its revision. kind is none, sandbox, desktop, phone or browser;
// provider names one of the computer providers (the computer package's kind registry), and is absent for none; image
// names one the provider offers for the kind, and absent is the kind's default; a sandbox's gpu is { type, count };
// persistent: true keeps the agent's own computer between its runs, where the configuration declares persistence. A
// desktop's or a phone's surface ("code" or "tools") is how the agent drives it, and exec: false gives the agent no
// shell and no program start on it (run-tools.ts); the owner's own computer calls keep everything. The v2 API's `place` is this
// setting's view, one to one where it can say it: {mode: "runner"} is {kind: "none"}, and {mode: "sandbox", box: X} is
// {kind: "sandbox", provider: X}. Writing either sets both. A desktop, phone or browser computer leaves the run's folder
// on the runner, so its place reads runner.
import { configurationOf, PROVIDERS, serves } from "@parcha/agentrun-computer";
import type { InputIssue } from "./errors.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The kinds of computer an agent can be given. */
export const COMPUTER_KINDS = ["none", "sandbox", "desktop", "phone", "browser"] as const;
export type ComputerKind = (typeof COMPUTER_KINDS)[number];

/** A sandbox's GPUs: a type its provider declares (GET /v2/computers lists each provider's) and how many. */
export type GpuSetting = { readonly type: string; readonly count: number };

/** How an agent drives a desktop or a phone: "code", by scripts alone (its harness's code mode, else computer_script);
 *  "tools", by the per-step tools alone (computer_observe, computer_act, computer_screenshot). The hand-over is in both;
 *  absent, both (run-tools.ts surfaceKeeps). */
export const COMPUTER_SURFACES = ["code", "tools"] as const;
export type ComputerSurface = (typeof COMPUTER_SURFACES)[number];

/** The setting as a revision keeps it. `image`: one the provider's descriptor offers for the kind (Orgo's `windows`);
 *  absent, the kind's default. A sandbox may ask for GPUs; whether its provider gives them is the claim's check. A
 *  desktop or a phone may say its surface, and `exec: false`: the agent gets no shell and starts no program on it. */
export type ComputerSetting =
  | { readonly kind: "none" }
  | { readonly kind: "sandbox"; readonly provider: string; readonly image?: string; readonly gpu?: GpuSetting; readonly persistent?: boolean }
  | { readonly kind: "desktop" | "phone"; readonly provider: string; readonly image?: string; readonly persistent?: boolean; readonly surface?: ComputerSurface; readonly exec?: boolean }
  | { readonly kind: "browser"; readonly provider: string; readonly image?: string; readonly persistent?: boolean };

/** A GPU type's name as a setting keeps it: the vendor's own ("T4", "A100-80GB", "RTX-PRO-6000"); store/agent-body.ts
 *  keeps the same. */
const GPU_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The GPUs a setting asks for, or undefined. */
export const gpuOf = (computer: { readonly kind: string; readonly gpu?: GpuSetting }): GpuSetting | undefined => (computer.kind === "sandbox" ? computer.gpu : undefined);

/**
 * What a computer of a kind other than none may say beside its kind and provider: the kinds that take it (absent: any),
 * and its own rule, the issues of a value that is wrong at `field`. The providers' offers are the server's, so only the
 * shape is checked here. A sandbox's gpu is { type, count } in the words the computer package's checkGpu uses; whether
 * its provider offers that type and count is the readiness check's and the claim's (resolve-computer.ts).
 */
const OPTIONAL: Readonly<Record<string, { readonly kinds?: readonly ComputerKind[]; check(value: unknown, field: string): InputIssue[] }>> = {
  image: {
    check: (value, field) => (typeof value === "string" && value.trim() !== "" && value === value.trim() ? [] : [{ field, reason: "invalid", message: `${field} is the name of an image the provider offers for the kind (GET /computers lists them), with no spaces around it` }]),
  },
  // An agent's own computer, kept between its runs (workspace/agent-computer.ts): true asks for it, where the provider's
  // configuration keeps one (persistenceIssues); false or absent is a fresh computer for each run.
  persistent: {
    check: (value, field) => (typeof value === "boolean" ? [] : [{ field, reason: "wrong_type", message: `${field} is true (this agent keeps its own computer between runs) or false (a fresh one for each run)` }]),
  },
  // How the agent drives its desktop or phone (run-tools.ts surfaceKeeps): by scripts alone, or by the step tools alone.
  surface: {
    kinds: ["desktop", "phone"],
    check: (value, field) => ((COMPUTER_SURFACES as readonly unknown[]).includes(value) ? [] : [{ field, reason: "not_an_option", message: `${field} is "code" (the agent drives the computer by scripts alone) or "tools" (by its step tools alone); absent, both` }]),
  },
  // false: the agent's computer runs no program of its own (run-tools.ts runHands): no shell, no processes, no bash.
  exec: {
    kinds: ["desktop", "phone"],
    check: (value, field) => (typeof value === "boolean" ? [] : [{ field, reason: "wrong_type", message: `${field} is false (the agent gets no shell and starts no program on its computer) or true (as absent)` }]),
  },
  gpu: {
    kinds: ["sandbox"],
    check: (gpu, field) => {
      if (!isObject(gpu) || Object.keys(gpu).some((key) => key !== "type" && key !== "count")) return [{ field, reason: "wrong_type", message: "gpu is { type, count }: a GPU type this provider declares, and how many" }];
      if (typeof gpu.type !== "string" || gpu.type === "") return [{ field: `${field}.type`, reason: "missing", message: "gpu.type is a GPU type the provider declares (GET /v2/computers lists each provider's)" }];
      if (!GPU_TYPE.test(gpu.type)) return [{ field: `${field}.type`, reason: "wrong_type", message: `gpu.type ${JSON.stringify(gpu.type)} is not a GPU type name: letters, digits, dots, underscores and dashes, as GET /v2/computers lists each provider's` }];
      if (!Number.isSafeInteger(gpu.count) || (gpu.count as number) < 1) return [{ field: `${field}.count`, reason: "wrong_type", message: `gpu.count ${JSON.stringify(gpu.count)} is not a whole number from 1` }];
      return [];
    },
  },
};

/** A place as the v2 API names it. */
export type PlaceView = { mode: "runner" } | { mode: "sandbox"; box: string };

/** The place the setting reads as: sandbox on its provider, else the runner (no computer holds the run's folder). */
export const placeOfComputer = (computer: ComputerSetting): PlaceView => (computer.kind === "sandbox" ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });

/** The setting a place says: runner is no computer, a sandbox place a sandbox on its box. */
export const computerOfPlace = (place: PlaceView): ComputerSetting => (place.mode === "sandbox" ? { kind: "sandbox", provider: place.box } : { kind: "none" });

/** Whether two settings are the one setting: the same kind and provider, and the same of each optional field. */
export const sameComputer = (a: ComputerSetting, b: ComputerSetting): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "none" || b.kind === "none") return true;
  const one = a as Readonly<Record<string, unknown>>;
  const other = b as Readonly<Record<string, unknown>>;
  return a.provider === b.provider && Object.keys(OPTIONAL).every((key) => JSON.stringify(one[key]) === JSON.stringify(other[key]));
};

/** What is wrong with `value` as a computer setting, at `field`: its shape only (the providers are the server's). */
export function computerIssues(value: unknown, field: string): InputIssue[] {
  const bad = (reason: string, message: string, fix?: string): InputIssue[] => [{ field, reason, message, ...(fix ? { fix } : {}) }];
  const keeps = ["kind", "provider", ...Object.keys(OPTIONAL)];
  if (!isObject(value)) return bad("wrong_type", `${field} is an object: {kind}, or {kind, provider}, with ${Object.keys(OPTIONAL).join(" and ")} where its kind takes them`);
  const extra = Object.keys(value).filter((key) => !keeps.includes(key));
  if (extra.length) return bad("not_allowed", `${field} keeps only ${keeps.join(", ")}, not ${extra.join(" or ")}`, `Remove ${extra.map((key) => `${field}.${key}`).join(" and ")}.`);
  if (typeof value.kind !== "string" || !(COMPUTER_KINDS as readonly string[]).includes(value.kind)) return bad(value.kind === undefined ? "missing" : "not_an_option", `${field}.kind is one of ${COMPUTER_KINDS.join(", ")}`);
  const kind = value.kind as ComputerKind;
  for (const [key, { kinds }] of Object.entries(OPTIONAL)) {
    if (value[key] !== undefined && kinds !== undefined && !kinds.includes(kind)) return bad("not_allowed", `only a ${kinds.join(" or ")} computer takes a ${key}, not a ${kind} one`, `Remove ${field}.${key}.`);
  }
  if (kind === "none") {
    const named = keeps.filter((key) => key !== "kind" && value[key] !== undefined);
    return named.length === 0 ? [] : bad("not_allowed", `no computer names no ${named.join(" or ")}`, `Remove ${named.map((key) => `${field}.${key}`).join(" and ")}.`);
  }
  if (typeof value.provider !== "string" || value.provider === "") return bad("missing", `a ${kind} computer names its provider (Settings → Computers lists them)`);
  const issues = Object.entries(OPTIONAL).flatMap(([key, { check }]) => (value[key] === undefined ? [] : check(value[key], `${field}.${key}`)));
  if (issues.length > 0 || value.persistent !== true) return issues;
  return persistenceIssues(kind, value.provider, typeof value.image === "string" ? value.image : undefined, `${field}.persistent`);
}

/**
 * Why `persistent: true` is refused, at `field`: the configuration the setting selects keeps no computer for an agent.
 * Read from the computer package's registry, each configuration's declared persistence (kinds.test holds it equal to the
 * built provider's), so a save needs no vendor call. A provider the registry does not list (a --faux one, or one the
 * readiness check names as unknown) is left to the claim's refusal.
 */
function persistenceIssues(kind: Exclude<ComputerKind, "none">, provider: string, image: string | undefined, field: string): InputIssue[] {
  const entry = PROVIDERS.find((one) => one.id === provider);
  if (!entry) return [];
  const configuration = configurationOf(entry.capabilities.filter((one) => serves(one, kind)), image, entry.defaultImage?.[kind]);
  if (!configuration || configuration.persistence !== undefined) return [];
  return [{
    field,
    reason: "not_allowed",
    message: `${entry.label}'s ${image === undefined ? "default" : JSON.stringify(image)} ${kind} keeps no computer for an agent between runs: it declares no persistence`,
    fix: `Remove ${field}, or pick a computer that keeps one (GET /v2/computers shows which do).`,
  }];
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
  // A place says a kind and a provider only: a computer's image or GPUs are not ones it can contradict.
  const said = computerOfPlace(place as PlaceView);
  const { kind, provider } = computer as { kind: ComputerSetting["kind"]; provider?: string };
  if (sameComputer((kind === "none" ? { kind } : { kind, provider }) as ComputerSetting, said)) return [];
  return [{ field: `${field}.place`, reason: "invalid", message: "computer and place say two settings: give one (place is computer's v2 view)", fix: `Remove ${field}.place, or make it ${JSON.stringify(placeOfComputer(computer as ComputerSetting))}.` }];
}
