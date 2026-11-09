// The server's own secrets are one list (server-secrets.ts), fed by every sealed store: what a run shows (its answer, its
// Timeline) is cut of each of them, a webhook trigger's signing secret and the outbound webhook's among them. And a
// sealed secret that will not open is said, never dropped in silence.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { agent, client, FAUX, follow, runDir, scratch, secretWritePath, serve, triggerStore, withEnv } from "./support.mjs";

// Removing the outbound webhook takes its secret with it: the client sends it from the owner's session, as the console does.
secretWritePath(["DELETE"], /^\/settings\/webhook$/);

const sealKey = () => randomBytes(32).toString("base64");
/** Whether `text` holds any 8 characters of `secret` in a row. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("a run that quotes a webhook trigger's signing secret, or the outbound webhook's, whole or its key alone (the base64 after whsec_), shows neither: its answer and its Timeline are cut of both", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("quotes", { tools: ["read"] }))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "quotes", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const outbound = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
  const quoted = (what, secret) => [[what, secret], [`${what} key`, secret.slice("whsec_".length)]];
  for (const [what, secret] of [...quoted("the trigger's", trigger.body.signing_secret), ...quoted("the outbound webhook's", outbound.body.signing_secret)]) {
    const file = join(await scratch(t), "key.txt");
    await writeFile(file, secret);
    const started = await api("POST", "/agents/quotes/runs", { input: { content: `Quote the key in ${file}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"]);
    const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
    const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
    assert.ok(rows.some((r) => r.kind === "final_answer"), `${what}: a final answer`);
    for (const form of [secret, Buffer.from(secret).toString("base64")]) {
      assert.ok(!holdsRun(JSON.stringify(run), form), `${what} secret is not in the run: ${JSON.stringify(run.result)}`);
      assert.ok(!holdsRun(JSON.stringify(rows), form), `${what} secret is not on the Timeline`);
    }
  }
});

/** The spellings of a `whsec_` secret a redaction derives from no other: its key, the base64 after `whsec_`, as written,
 *  printed unpadded (`openssl base64 | tr -d =`), as base64url (- and _ for + and /, no padding), and its bytes as hex;
 *  and, when it holds a /, as a JSON encoder that escapes / writes it. */
const keyForms = (secret) => {
  const bare = secret.slice("whsec_".length);
  const key = Buffer.from(bare, "base64");
  return { bare, unpadded: bare.replace(/=+$/, ""), base64url: key.toString("base64url"), hex: key.toString("hex"), ...(bare.includes("/") ? { escaped: bare.replaceAll("/", "\\/") } : {}) };
};

/** A run of a new agent `id` whose message holds each of `forms`: everything the server shows of it, as one text. Every
 *  page its Timeline answered live, its view, and the runs list with its title. */
async function pasted(api, id, forms) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: `Keep these: ${Object.values(forms).join(", ")}` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows, pages } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const listed = (await api("GET", "/runs")).body;
  return JSON.stringify({ rows, pages, view, listed });
}

test("a run whose message holds a webhook trigger's key or the outbound webhook's, as base64 (padded or not), base64url, hex or with its / escaped, shows none of them: not its Timeline, live or final, its view, or its title on the runs list", { timeout: 300_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("target"))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  // A key whose base64 holds a /, as about half do: its unpadded and its escaped spellings differ from every other.
  let hooked = trigger.body.signing_secret;
  for (let i = 0; i < 40 && !hooked.includes("/"); i++) hooked = (await api("POST", `/triggers/${trigger.body.id}/secret`)).body.signing_secret;
  assert.ok(hooked.includes("/"), "a secret with a / within 40 rotations");
  const outbound = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
  for (const [what, secret] of [["trigger", hooked], ["outbound", outbound.body.signing_secret]]) {
    const forms = keyForms(secret);
    const shown = await pasted(api, `pastes-${what}`, forms);
    for (const [form, value] of Object.entries(forms)) assert.ok(!holdsRun(shown, value), `the ${what} secret's key as ${form} shows nowhere: ${shown.slice(0, 600)}`);
  }
});

test("after a webhook trigger's secret is rotated, or the outbound webhook is deleted and set again, a run that pastes the old secret, whole or its key in any form, still shows none of it", { timeout: 300_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("target"))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const rotated = await api("POST", `/triggers/${trigger.body.id}/secret`);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.notEqual(rotated.body.signing_secret, trigger.body.signing_secret);
  const forms = { whole: trigger.body.signing_secret, ...keyForms(trigger.body.signing_secret) };
  const shown = await pasted(api, "pastes-old", forms);
  for (const [form, value] of Object.entries(forms)) assert.ok(!holdsRun(shown, value), `the old secret as ${form} shows nowhere: ${shown.slice(0, 600)}`);
  const outbound = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
  assert.equal((await api("DELETE", "/settings/webhook")).status, 204);
  const again = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.signing_secret, outbound.body.signing_secret);
  const outboundForms = { whole: outbound.body.signing_secret, ...keyForms(outbound.body.signing_secret) };
  const outboundShown = await pasted(api, "pastes-old-outbound", outboundForms);
  for (const [form, value] of Object.entries(outboundForms)) assert.ok(!holdsRun(outboundShown, value), `the old outbound secret as ${form} shows nowhere: ${outboundShown.slice(0, 600)}`);
});

// BLOCKED on the switch: a run's error is written only through the fenced run-patch (a live claim). An ended, released run
// cannot have a crafted error injected — store.runs.update fences it, importRun has no error field, and no raw store write is
// exposed. Un-skip once the store (or support.mjs) offers a post-end error write, or when the runner can fail a run with a
// chosen message. Redaction of a webhook key in a run's error is still covered by the redactor tests (user-row-redact).
test("an ended run the next server holds no Run for, listed from its row alone, shows no webhook trigger's key in its error", { timeout: 120_000, skip: "waits on a faux provider failing the run on the runner (slot 4b's harness wiring)" }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const first = await serve(t);
  assert.equal((await first.api("POST", "/agents", agent("target"))).status, 201);
  const trigger = await first.api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const runId = (await first.api("POST", "/agents/target/runs", { input: { content: "Fail with a refused key." } })).body.run_id;
  await follow(first.api, runId, ["failed"], { deadlineMs: 60_000 });
  await first.close();
  // Its error as a server that did not cut it kept it: the trigger's key in the clear, as written and as hex.
  const forms = keyForms(trigger.body.signing_secret);
  // The switch keeps the run's error in the store, not a serve.json file: write the crafted error (the key in the clear)
  // onto the run's row there, as a server that did not cut it would have, then read it back from a fresh server.
  const store = await openSqliteStore({ dataDir: first.data, role: "server" });
  try {
    const row = await store.runs.get(runId);
    await store.runs.update({ runId, epoch: row.epoch }, { error: { code: "run_failed", message: `The hook signed with ${forms.bare}, or ${forms.hex}.` } });
  } finally {
    await store.close();
  }
  const { api } = await serve(t, { data: first.data });
  const listed = [(await api("GET", "/runs")).body, (await api("GET", "/agents/target/runs")).body];
  for (const body of listed) {
    const row = body.runs.find((r) => r.run_id === runId);
    assert.ok(row?.error, JSON.stringify(body));
    for (const [form, value] of Object.entries(forms)) assert.ok(!holdsRun(JSON.stringify(row), value), `the key as ${form} is not in the row: ${JSON.stringify(row.error)}`);
  }
});

test("a webhook trigger's secret that does not open under the server's seal key is said at the start, naming its trigger, and the trigger stays refused", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  // The triggers' store, the next server's too: the trigger it made is read again there.
  const store = await triggerStore();
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", store });
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("hooked"))).status, 201);
  const made = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await first.close();
  // Another seal key: the secret is still in the file, sealed, but does not open here.
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const lines = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", log: (line) => lines.push(line), store: await triggerStore(store) });
  t.after(() => next.close());
  const said = lines.filter((line) => line.includes(made.body.id) && /does not open|not_open|unopened|unreadable/.test(line));
  assert.equal(said.length, 1, `said once, naming the trigger: ${JSON.stringify(lines)}`);
  api = client(next.baseUrl, next.token);
  const hook = await fetch(`${next.baseUrl}/hooks/${made.body.id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_1", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }, body: "{}" });
  assert.equal(hook.status, 401, "still refused");
});
