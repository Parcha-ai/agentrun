// The planted-secret harness's registry (planted-secrets.test.mjs). Each plant writes a distinct, real-looking value
// through a secret write route, as the owner's signed-in session, and answers the values it planted. The harness then
// reads everything a person, a script or another process could read (every GET of the served API document, the store's
// rows, the server's log, an export) and expects none of them to hold any planted value, in any of its forms.
//
// A lane adds its plants here (or calls registerPlant from its own fixture this file imports): a webhook secret, a GitHub
// App private key, Slack source settings, a computer vendor key, an Archil key, an MCP header, an OAuth refresh token.
// `needs` names what its write requires of the server (e.g. a fake provider module), so the harness can say which it ran.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

/** `ids`: the path parameters the harness fills its GETs with; a plant adds the ids it made (a trigger's), so the GETs
 *  under them are read too.
 *  @typedef {{ owner: (method: string, path: string, body?: unknown) => Promise<{ status: number, text: string }>, api: Function, server: { port: number, data: string }, ids: Record<string, string> }} PlantContext */
/** @typedef {{ name: string, write: (ctx: PlantContext) => Promise<string[]> }} Plant */

/** @type {Plant[]} */
const plants = [];

/** Adds a plant: `write` puts its values through the server's secret write routes and answers them. */
export function registerPlant(plant) {
  if (plants.some((p) => p.name === plant.name)) throw new Error(`a plant named ${plant.name} is registered already`);
  plants.push(plant);
}

export const registeredPlants = () => [...plants];

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
// fired under it, so its firing's payload row is read too; and the outbound webhook's minted secret ----

/** A body signed by `secret` by the Standard Webhooks spec, POSTed with no token to trigger `id`'s hook. */
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
  write: async ({ owner, ids, server }) => {
    const made = await owner("POST", "/v2/triggers", { name: "planted hook", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: ids.agent_id, input: { content: "Triage this event." }, max_cost_usd: 0.5 } });
    if (made.status !== 201) throw new Error(`the webhook trigger was not made: ${made.status} ${made.text}`);
    const { id, signing_secret: first } = JSON.parse(made.text);
    ids.trigger_id = id;
    const rotated = await owner("POST", `/v2/triggers/${id}/secret`);
    if (rotated.status !== 200) throw new Error(`the trigger's secret was not rotated: ${rotated.status} ${rotated.text}`);
    const { signing_secret: secret } = JSON.parse(rotated.text);
    const fired = await deliver(server, id, secret);
    if (fired !== 202) throw new Error(`a delivery signed by the rotated secret was answered ${fired}`);
    return [first, secret];
  },
});

registerPlant({
  name: "outbound webhook secret",
  write: async ({ owner }) => {
    const saved = await owner("PUT", "/v2/settings/webhook", { url: "https://hooks.example.com/planted" });
    if (saved.status !== 201) throw new Error(`the outbound webhook was not set: ${saved.status} ${saved.text}`);
    return [JSON.parse(saved.text).signing_secret];
  },
});
