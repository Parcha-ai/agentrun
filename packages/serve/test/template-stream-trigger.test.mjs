// A template's webhook trigger may take Stream's signature (stream). Its apply says to give Stream's secret, never to
// rotate one, and says so beside a trigger whose secret is made here and shown once. An update that moves a trigger
// between a secret made here and Stream's makes it again, as a trigger of another kind is, and says its hook URL is new.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { asOwner, serve, withEnv } from "./support.mjs";

const ID = "upload:notes";
const APPLY = `/templates/${encodeURIComponent(ID)}/apply`;

/** The package: a `ring` webhook trigger signed as `signature` says (absent: standard), and a `deploys` one beside it. */
const manifest = (signature, version) => `---
name: notes
version: ${version}
description: Reads each note.
tools: []
budget: { per_run_usd: 0.5 }
triggers:
  - name: ring
    source: { kind: webhook${signature ? `, signature: ${signature}` : ""} }
    target: { kind: start_run, input: { content: "A note arrived." } }
  - name: deploys
    source: { kind: webhook }
    target: { kind: start_run, input: { content: "A deploy finished." } }
---
Read the note.
`;

async function upload(owner, signature, version) {
  const stored = await owner("POST", "/templates/import", { files: [{ path: "agent.md", encoding: "utf8", content: manifest(signature, version) }] });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
}

test("a template's stream trigger: its apply says to give Stream's secret, beside a trigger whose secret is shown once, and never to rotate it", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const owner = asOwner(server);
  await upload(owner, "stream", "0.1.0");
  const applied = await owner("POST", APPLY, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  // The deploys trigger's secret is made here and shown once, to the owner's first answer; the ring's is Stream's.
  assert.deepEqual(applied.body.webhook_secrets.map((one) => [one.trigger_id === applied.body.triggers[1].trigger_id, typeof one.signing_secret]), [[true, "string"]]);
  const ring = applied.body.warnings.filter((w) => w.field === "triggers.0.secret");
  assert.equal(ring.length, 1, JSON.stringify(applied.body.warnings));
  assert.equal(ring[0].reason, "not_set_up_here");
  assert.match(ring[0].message, /^Stream makes this trigger's secret: give it on the trigger's page \(Set secret\), or with PUT \/v2\/triggers\/\{id\}\/secret/);
  assert.doesNotMatch(JSON.stringify(applied.body.warnings), /rotate it/i, "a stream trigger's secret is never rotated here");
});

test("an update that moves a template's trigger between a secret made here and Stream's makes it again, says its hook URL is new, and asks for Stream's secret", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const owner = asOwner(server);
  await upload(owner, undefined, "0.1.0");
  const first = await owner("POST", APPLY, { parameters: {} });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const before = first.body.triggers.find((one) => one.name === "ring").trigger_id;
  await upload(owner, "stream", "0.2.0");
  const updated = await owner("POST", APPLY, { parameters: {}, agent_id: first.body.agent_id });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const after = updated.body.triggers.find((one) => one.name === "ring").trigger_id;
  assert.notEqual(after, before, "made again, as no PATCH moves a trigger between the two");
  assert.equal((await server.api("GET", `/triggers/${before}`)).status, 404, "the old one is gone");
  const ring = (await server.api("GET", `/triggers/${after}`)).body;
  assert.deepEqual([ring.source.signature, ring.secret.set], ["stream", false]);
  const said = updated.body.warnings.filter((w) => w.field === "triggers.0" || w.field === "triggers.0.secret").map((w) => w.message);
  assert.equal(said.length, 2, JSON.stringify(updated.body.warnings));
  assert.match(said[0], /^The trigger ring was made again, since its secret now comes from Stream: its hook URL is new/);
  assert.match(said[1], /^Stream makes this trigger's secret/);
  // The deploys trigger kept its kind and its secret: changed in place, its id as it was.
  assert.equal(updated.body.triggers.find((one) => one.name === "deploys").trigger_id, first.body.triggers.find((one) => one.name === "deploys").trigger_id);
});
