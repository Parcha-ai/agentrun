// The planted-secret harness's registry (planted-secrets.test.mjs). Each plant writes a distinct, real-looking value
// through a secret write route, as the owner's signed-in session, and answers the values it planted (and any the server
// minted and showed it once). The harness then reads everything a person, a script or another process could read (every
// GET of the served API document, by the ids the plants made too; the plants' own answers; the store's rows, the server's
// log, an export) and expects none of them to hold any planted value, in any of its forms.
//
// A lane adds its plants here (or calls registerPlant from its own fixture this file imports): a webhook secret, a GitHub
// App private key, Slack source settings, a computer vendor key, an Archil key, an MCP header, an OAuth refresh token.
//
// A plant's `write` answers its values as an array, or as { values, ids, mints, cleanup }:
// - `ids`: the ids it made, by the path parameter the API document names them with ({ trigger_id: "t1" }, or a list), so
//   the harness also reads every GET whose path takes them (GET /triggers/{trigger_id}, its firings);
// - `mints`: the operationIds whose answer to the owner's session may show a value once (secret-writes.ts, the shown-once
//   rule: a `<kind>_secret` beside `secret`, in the minting answer alone). The harness skips just those answers; the
//   same value anywhere else (a GET, a token caller's answer, a later answer, the store, the log) is a hit. A plant may
//   also declare `mints` on itself, for every write it makes;
// - `cleanup(ctx, ids)`: run once the harness has read everything, with every plant's ids.
import { randomBytes } from "node:crypto";

/** @typedef {{ status: number, text: string, json?: unknown }} Answer */
/** @typedef {{ owner: (method: string, path: string, body?: unknown) => Promise<Answer>, token: (method: string, path: string, body?: unknown) => Promise<Answer>, api: Function, server: { port: number, data: string, token: string } }} PlantContext */
/** @typedef {Record<string, string | string[]>} PlantIds */
/** @typedef {{ values: string[], ids?: PlantIds, mints?: string[], cleanup?: (ctx: PlantContext, ids: Record<string, string[]>) => Promise<void> }} Planted */
/** @typedef {{ name: string, mints?: string[], write: (ctx: PlantContext) => Promise<string[] | Planted> }} Plant */

/** @type {Plant[]} */
const plants = [];

/** Adds a plant: `write` puts its values through the server's secret write routes and answers them. */
export function registerPlant(plant) {
  if (plants.some((p) => p.name === plant.name)) throw new Error(`a plant named ${plant.name} is registered already`);
  plants.push(plant);
}

export const registeredPlants = () => [...plants];

/** What a plant's write answered, whole: an array of values reads as { values }. Its own `mints` join the answer's. */
export function plantedOf(plant, answered) {
  const planted = Array.isArray(answered) ? { values: answered } : answered;
  if (!planted || !Array.isArray(planted.values)) throw new Error(`the plant ${plant.name} answered no values`);
  return { values: planted.values, ids: planted.ids ?? {}, mints: [...(plant.mints ?? []), ...(planted.mints ?? [])], cleanup: planted.cleanup };
}

/** Every plant's ids, merged by path parameter, each a list. */
export function mergedIds(planteds, base = {}) {
  const ids = Object.fromEntries(Object.entries(base).map(([name, value]) => [name, [].concat(value)]));
  for (const { ids: made } of planteds) {
    for (const [name, value] of Object.entries(made)) ids[name] = [...new Set([...(ids[name] ?? []), ...[].concat(value)])];
  }
  return ids;
}

/** Each way to fill `path`'s parameters from `ids` (every combination), or none when one has no id. */
export function filledPaths(path, ids) {
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (params.some((name) => !ids[name]?.length)) return [];
  let fills = [{}];
  for (const name of params) fills = fills.flatMap((fill) => ids[name].map((id) => ({ ...fill, [name]: id })));
  return fills.map((fill) => path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(fill[name])));
}

/** The operationId of `method` on `path` (under /v2, its query left off) in the API document `doc`, or undefined. */
export function operationOf(doc, method, path) {
  const bare = path.replace(/^\/v2/, "").split("?")[0];
  for (const [template, item] of Object.entries(doc.paths ?? {})) {
    const op = item[method.toLowerCase()];
    if (!op) continue;
    const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`);
    if (pattern.test(bare)) return op.operationId;
  }
  return undefined;
}

/** The plants' answers (each { by: "session" | "token", method, path, operation, status, text }) as sources to scan: all
 *  but an answer to the owner's session from an operation in `mints`, the one place a value may show, once. */
export function answerSources(answers, mints) {
  const allowed = new Set(mints);
  return answers
    .filter((answer) => !(answer.by === "session" && answer.operation !== undefined && allowed.has(answer.operation)))
    .map((answer) => ({ where: `${answer.method} ${answer.path} (${answer.by}'s answer, ${answer.status})`, text: answer.text }));
}

/** A distinct value that looks like a real key, never one: long enough that a partial copy is a hit too. */
export const plantedValue = (prefix = "sk-planted") => `${prefix}-${randomBytes(18).toString("base64url")}`;

/** Each form a value could leak in: as is, base64, hex, URL-encoded and JSON-escaped, and its middle 16 characters (a
 *  partial copy, a truncated preview). */
export function formsOf(value) {
  const middle = value.length > 24 ? value.slice(Math.floor(value.length / 2) - 8, Math.floor(value.length / 2) + 8) : value;
  return {
    plain: value,
    base64: Buffer.from(value).toString("base64"),
    hex: Buffer.from(value).toString("hex"),
    url: encodeURIComponent(value),
    json: JSON.stringify(value).slice(1, -1),
    middle,
  };
}

/** Every hit of a planted value in `sources` (each `{ where, text }`): where, which value, in which form. */
export function findPlanted(sources, values) {
  const hits = [];
  for (const { where, text } of sources) {
    for (const value of values) {
      for (const [form, needle] of Object.entries(formsOf(value))) {
        if (needle && text.includes(needle)) hits.push({ where, value: `${value.slice(0, 6)}…`, form });
      }
    }
  }
  return hits;
}

// ---- the tool keys' and model keys' plants (tool-keys.ts): one tool key and one model key, saved by the owner ----

registerPlant({
  name: "tool key (monid)",
  write: async ({ owner }) => {
    const value = plantedValue("monid");
    const res = await owner("PUT", "/v2/settings/tool-keys/monid", { values: { MONID_API_KEY: value } });
    if (res.status !== 204) throw new Error(`the monid key was not saved: ${res.status} ${res.text}`);
    return [value];
  },
});

registerPlant({
  name: "model key (openrouter)",
  write: async ({ owner }) => {
    const value = plantedValue("sk-or-v1");
    const res = await owner("PUT", "/v2/settings/tool-keys/openrouter", { values: { OPENROUTER_API_KEY: value } });
    if (res.status !== 204) throw new Error(`the openrouter key was not saved: ${res.status} ${res.text}`);
    return [value];
  },
});

// ---- the computer keys' and the Archil account key's plants (computers.ts, archil-routes.ts): saved by the owner ----

/** The Archil settings the Archil plant saves beside its key: a disk, its region and S3 URL, none of them a secret. */
export const PLANTED_ARCHIL_SETTINGS = { diskId: "dsk-00000000000plant", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };

registerPlant({
  // The harness's server runs --faux: its computer providers are --faux's, and faux-sandbox's one key is FAUX_SANDBOX_KEY.
  name: "computer key (faux-sandbox)",
  write: async ({ owner }) => {
    const value = plantedValue("faux-sandbox");
    const res = await owner("PUT", "/v2/computers/faux-sandbox/keys", { FAUX_SANDBOX_KEY: value });
    if (res.status !== 200) throw new Error(`the faux-sandbox key was not saved: ${res.status} ${res.text}`);
    return {
      values: [value],
      ids: { provider: ["faux-sandbox"] },
      cleanup: async (ctx) => {
        const removed = await ctx.owner("PUT", "/v2/computers/faux-sandbox/keys", { FAUX_SANDBOX_KEY: null });
        if (removed.status !== 200) throw new Error(`the faux-sandbox key was not removed: ${removed.status} ${removed.text}`);
      },
    };
  },
});

registerPlant({
  name: "Archil account key",
  write: async ({ owner }) => {
    const value = plantedValue("archil-key");
    const res = await owner("PUT", "/v2/workspace/archil", { ...PLANTED_ARCHIL_SETTINGS, keys: { ARCHIL_API_KEY: value } });
    if (res.status !== 200) throw new Error(`the Archil account key was not saved: ${res.status} ${res.text}`);
    return {
      values: [value],
      // DELETE /workspace/archil clears the settings alone and keeps the key's row, so the key goes as a null.
      cleanup: async (ctx) => {
        const removed = await ctx.owner("PUT", "/v2/workspace/archil", { ...PLANTED_ARCHIL_SETTINGS, keys: { ARCHIL_API_KEY: null } });
        if (removed.status !== 200) throw new Error(`the Archil account key was not removed: ${removed.status} ${removed.text}`);
      },
    };
  },
});
