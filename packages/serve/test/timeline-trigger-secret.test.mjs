// A webhook trigger's signing secret is one of the values this server holds: a run's Timeline, its title and its answer
// cut it as they cut a saved key, by its value in each of its forms (hex, base64, the bare key after `whsec_`), not only by its `whsec_` shape. After
// a rotation the new secret is cut the same, read as it is now.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const hooked = { source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Go." }, max_cost_usd: 0.5 } };
const holdsPiece = (text, secret) => [...Array(Math.max(0, secret.length - 7)).keys()].some((i) => text.includes(secret.slice(i, i + 8)));
/** The forms of `secret` its `whsec_` shape does not catch, but its value does: what a person may paste of it. Its body,
 *  the base64 after `whsec_`, is the signing key itself. */
const formsOf = (secret) => ({ hex: Buffer.from(secret).toString("hex"), base64: Buffer.from(secret).toString("base64"), body: secret.slice("whsec_".length) });

/** A run of agent `id` whose message holds each of `forms`: everything the server shows of it, as one text. */
async function pasted(api, id, forms) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const content = `Keep these: ${forms.hex}, ${forms.base64} and ${forms.body}`;
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const listed = (await api("GET", "/runs")).body;
  return JSON.stringify({ rows, view, listed });
}

test("a webhook trigger's secret pasted into a run's message, as hex, base64 or its bare key, is cut from every Timeline row, the run's title and its answer; after a rotation the new secret is cut the same", { timeout: 300_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("target"))).status, 201);
  const created = await api("POST", "/triggers", hooked);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = formsOf(created.body.secret);
  const shown = await pasted(api, "pasted", first);
  for (const [form, value] of Object.entries(first)) assert.equal(holdsPiece(shown, value), false, `the secret's ${form} form shows nowhere: ${shown.slice(0, 600)}`);
  const rotated = await api("POST", `/triggers/${created.body.id}/secret`);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const next = formsOf(rotated.body.secret);
  const after = await pasted(api, "rotated", next);
  for (const [form, value] of Object.entries(next)) assert.equal(holdsPiece(after, value), false, `the new secret's ${form} form shows nowhere: ${after.slice(0, 600)}`);
});
