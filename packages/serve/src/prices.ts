// The prices in force (GET /v2/settings/prices): what this server prices computer time and browser time at, read from
// the same settings and list the run's meters read (compute-cost.ts computeRate, browser-cost.ts browserPrice), so a
// caller can show estimates and turn a budget of its own into the server's figures. Each price is a decimal string, as
// its setting says it (never a float's rounding), with where it comes from:
//   - `setting`: the operator's setting (AGENTRUN_COMPUTE_USD_PER_*, AGENTRUN_BROWSER_USD_PER_HOUR_*);
//   - `list`: no setting, a price built in (a browser provider's list price, $0 for a provider that bills nothing);
//   - `unpriced`: none, a setting that can't be read, or a provider whose create never says a computer's size: its time
//     runs outside the cap, as the meters say.
import { PROVIDERS } from "@parcha/agentrun-computer";
import { BROWSER_PRICE_ENV, BROWSER_PRICES, browserPrice, priceEnvOf } from "./browser-cost.js";
import { COMPUTE_PRICE_ENV, COMPUTE_UNITS, type ComputeResource, computePriceEnvOf, unmetered, unsized } from "./compute-cost.js";

export type PriceSource = "setting" | "list" | "unpriced";
export type ComputePrice = { provider: string; resource: ComputeResource; gpu_type: string | null; unit: (typeof COMPUTE_UNITS)[ComputeResource]; usd: string | null; source: PriceSource };
export type BrowserPrice = { provider: string; unit: "hour"; usd: string | null; minimum_s: number; source: PriceSource };

/** A setting's decimal as the meters read it (a non-negative decimal), trimmed; undefined when it can't be read. */
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
const readable = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed && DECIMAL.test(trimmed) && Number.isFinite(Number(trimmed)) ? trimmed : undefined;
};
/** A list price as a decimal string: its shortest form (0.12, never 0.1199…), with an exponent written out in digits. */
export function decimalOf(usd: number): string {
  const shortest = String(usd);
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
  if (!match) return shortest;
  const [, whole, fraction = "", exponent] = match;
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  return point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
}

const named = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** One compute resource's price for `provider`: $0 (list) for a provider that bills nothing, unpriced for one that never
 *  says a computer's size, else its setting, else unpriced. */
function computePrice(provider: string, resource: ComputeResource, gpuType: string | null, env: NodeJS.ProcessEnv): ComputePrice {
  const base = { provider, resource, gpu_type: gpuType, unit: COMPUTE_UNITS[resource] };
  if (unmetered(provider)) return { ...base, usd: "0", source: "list" };
  if (unsized(provider)) return { ...base, usd: null, source: "unpriced" };
  const set = readable(env[computePriceEnvOf(resource, provider, gpuType)]);
  return set === undefined ? { ...base, usd: null, source: "unpriced" } : { ...base, usd: set, source: "setting" };
}

/** The GPU types a setting names for `provider` (AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_<PROVIDER>_<GPU_TYPE>), as the setting
 *  spells them: a GPU type is only ever named by its setting here. */
function gpuTypesOf(provider: string, env: NodeJS.ProcessEnv): string[] {
  const prefix = `${COMPUTE_PRICE_ENV.gpu}${named(provider)}_`;
  return Object.keys(env).filter((name) => name.startsWith(prefix) && name.length > prefix.length).map((name) => name.slice(prefix.length));
}

/** Every computer provider's prices: vCPU, memory and disk, and each GPU type a setting names. */
export function computePrices(env: NodeJS.ProcessEnv): ComputePrice[] {
  const rows: ComputePrice[] = [];
  for (const provider of [...PROVIDERS.map((entry) => entry.id)].sort()) {
    for (const resource of ["vcpu", "memory", "disk"] as const) rows.push(computePrice(provider, resource, null, env));
    for (const gpuType of gpuTypesOf(provider, env).sort()) rows.push(computePrice(provider, "gpu", gpuType, env));
  }
  return rows;
}

/** Every browser provider's price an hour: each with a list price, each a setting names, and each computer provider that
 *  bills nothing; the setting wins, as browserPrice reads it. */
export function browserPrices(env: NodeJS.ProcessEnv): BrowserPrice[] {
  const set = Object.keys(env).filter((name) => name.startsWith(BROWSER_PRICE_ENV) && name.length > BROWSER_PRICE_ENV.length);
  // A setting names its provider in capitals; a provider the server knows is listed under its own id.
  const known = [...Object.keys(BROWSER_PRICES), ...PROVIDERS.filter((entry) => !entry.metered).map((entry) => entry.id)];
  const providers = new Set(known);
  for (const name of set) if (!known.some((id) => priceEnvOf(id) === name)) providers.add(name.slice(BROWSER_PRICE_ENV.length).toLowerCase());
  return [...providers].sort().map((provider) => {
    const price = browserPrice(provider, env);
    const base = { provider, unit: "hour" as const, minimum_s: price.minimumS };
    if (price.usdPerHour === null) return { ...base, usd: null, source: "unpriced" as const };
    const setting = readable(env[priceEnvOf(provider)]);
    return setting !== undefined ? { ...base, usd: setting, source: "setting" as const } : { ...base, usd: decimalOf(price.usdPerHour), source: "list" as const };
  });
}

/** GET /settings/prices' answer. */
export const pricesInForce = (env: NodeJS.ProcessEnv): { compute: ComputePrice[]; browser: BrowserPrice[] } => ({ compute: computePrices(env), browser: browserPrices(env) });
