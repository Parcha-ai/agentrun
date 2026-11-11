// The outbound webhook in the one store, on SQLite and on Postgres (AGENTRUN_TEST_PG_URL, `npm run test:pg`): the webhook,
// its sealed signing secret and its outbox are store rows, so a webhook saved before a restart is still set after it,
// signs with the same secret, and tells each moment once across restarts.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { sealedSettingsOverStore } from "../dist/sealed-settings-store.js";
import { OUTBOUND_WEBHOOK, Webhooks } from "../dist/webhooks.js";
import { dropSchema, freshSchema, onPostgres, PG_URL } from "./store-target.mjs";

/** A place for one store, opened and closed by the test as a server's starts and stops would: a schema of its own on
 *  Postgres, a data directory of its own on SQLite; removed after the test. */
async function place(t) {
  if (onPostgres) {
    const schema = await freshSchema();
    t.after(() => dropSchema(schema));
    return () => openPostgresStore({ url: PG_URL, schema });
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "webhook-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return () => openSqliteStore({ dataDir: dir });
}

/** A server's start on the store `open` opens: the store, and the webhook over it, its secret among the store's sealed
 *  settings under seal key `key`. `stop()` stops the webhook, then closes the store. */
async function start(open, key) {
  const store = await open();
  const secret = sealedSettingsOverStore(store, OUTBOUND_WEBHOOK.id, OUTBOUND_WEBHOOK.settings, key, () => undefined);
  await secret.load();
  const webhooks = new Webhooks(store, secret, () => undefined, []);
  await webhooks.load();
  return { store, webhooks, stop: async () => (await webhooks.close(), await store.close()) };
}

/** A receiver on the loopback interface: every request it gets, each answered 200; `when(n)` once it holds `n`. */
async function receiver(t) {
  const got = [];
  const waiting = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      for (const w of [...waiting]) if (got.length >= w.n) (waiting.splice(waiting.indexOf(w), 1), w.resolve());
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  const when = (n) => (got.length >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve })));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, when };
}

/** The Standard Webhooks signature of a request under `secret`, as a receiver checks it. */
const signs = (secret, { headers, body }) => {
  const expected = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
  return String(headers["webhook-signature"]).split(" ").includes(`v1,${expected}`);
};

test(`a webhook saved before a restart is still set after it, signs with the secret it was saved with, and tells a run's end once across restarts (${onPostgres ? "Postgres" : "SQLite"})`, async (t) => {
  const open = await place(t);
  const key = randomBytes(32);
  const hook = await receiver(t);
  // Saved, then the server stops.
  const first = await start(open, key);
  const saved = await first.webhooks.save({ url: hook.url });
  assert.equal(saved.created, true);
  assert.match(saved.secret, /^whsec_/);
  await first.stop();

  // Restarted: the webhook is still set, its secret still opens, and a run's end is sent once, signed with it.
  const second = await start(open, key);
  const view = second.webhooks.view();
  assert.deepEqual([view.configured, view.url, view.signing, view.disabled], [true, hook.url, "sealed", null], "the webhook survives the restart");
  const run = { run_id: "run-1", agent_id: "agent-1", status: "completed", title: "t" };
  const ended = new Date().toISOString();
  assert.equal(await second.webhooks.emit("run.ended", run, ended), "queued");
  assert.equal(await second.webhooks.emit("run.ended", run, ended), "queued", "the same end again: already queued");
  await hook.when(1);
  // Received is not answered: the try is in the log once its answer is read, and the stop then waits for its write (a
  // stop before it would cut the try, and the next start would send it again, as it should).
  while (second.webhooks.attemptsView().attempts.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await second.stop();
  assert.equal(hook.got.length, 1, "sent once");
  assert.ok(signs(saved.secret, hook.got[0]), "signed with the secret the first PUT showed");
  assert.equal(JSON.parse(hook.got[0].body).data.run_id, "run-1");

  // Restarted again: the ledger kept that end, so the same end queues nothing, and nothing is pending to send.
  const third = await start(open, key);
  t.after(() => third.stop());
  assert.equal(await third.webhooks.emit("run.ended", run, ended), "queued", "already queued, in the store's ledger");
  assert.deepEqual(third.webhooks.attemptsView().attempts.map((a) => [a.webhook_id, a.status_code]), [[hook.got[0].headers["webhook-id"], 200]], "the delivery log survives too");
  assert.equal(hook.got.length, 1, "never sent twice");
});
