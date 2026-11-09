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
import { createRequire } from "node:module";

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

// ---- the triggers' plants (trigger-secrets-shown.ts): a webhook trigger's minted secret, rotated, with a signed delivery
// fired under it, so its firing's rows are read too; and the outbound webhook's minted secret, its URL then changed with
// the token. Each value shows once, in its minting answer to the owner's session alone ----

/** A body signed by `secret` by the Standard Webhooks spec, POSTed with no token to trigger `id`'s hook: its status. */
async function deliver(server, id, secret) {
  const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
  const msg = `msg_${randomBytes(8).toString("hex")}`;
  const at = new Date();
  const body = JSON.stringify({ type: "lead.created", data: { company: "Planted Co" } });
  const res = await fetch(`http://127.0.0.1:${server.port}/v2/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": msg, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(msg, at, body) }, body });
  await res.text();
  return res.status;
}

registerPlant({
  name: "webhook trigger secret",
  mints: ["createTrigger", "rotateTriggerSecret"],
  write: async ({ owner, api, server }) => {
    const agentId = "planted-hook-agent";
    const agent = await api("POST", "/agents", { definition: { id: agentId, version: 1, name: agentId, instructions: "Answer.", skills: [], tools: [] } });
    if (agent.status !== 201) throw new Error(`the trigger's agent was not made: ${agent.status} ${JSON.stringify(agent.body)}`);
    const made = await owner("POST", "/v2/triggers", { name: "planted hook", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this event." }, max_cost_usd: 0.5 } });
    if (made.status !== 201) throw new Error(`the webhook trigger was not made: ${made.status} ${made.text}`);
    const { id, signing_secret: first } = made.json;
    const rotated = await owner("POST", `/v2/triggers/${id}/secret`);
    if (rotated.status !== 200) throw new Error(`the trigger's secret was not rotated: ${rotated.status} ${rotated.text}`);
    const second = rotated.json.signing_secret;
    const fired = await deliver(server, id, second);
    if (fired !== 202) throw new Error(`a delivery signed by the rotated secret was answered ${fired}`);
    return { values: [first, second], ids: { trigger_id: id } };
  },
});

registerPlant({
  name: "outbound webhook secret",
  mints: ["saveWebhook"],
  write: async ({ owner, token }) => {
    const saved = await owner("PUT", "/v2/settings/webhook", { url: "https://hooks.example.com/planted" });
    if (saved.status !== 201) throw new Error(`the outbound webhook was not set: ${saved.status} ${saved.text}`);
    // A later save is no secret write: the token changes the URL, and its answer is read like any other.
    const moved = await token("PUT", "/v2/settings/webhook", { url: "https://hooks.example.com/planted-2" });
    if (moved.status !== 200) throw new Error(`the token could not change the webhook's URL: ${moved.status} ${moved.text}`);
    return [saved.json.signing_secret];
  },
});
