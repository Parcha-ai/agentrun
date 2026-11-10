// The outbound webhook's tests' own: a receiver, a log, the webhook's state as the store holds it (its outbox, its tries
// and its ledger: channel_posts, channel_attempts and channel_told, channel "webhook-out"), awaited as the server writes
// it, and runs written into the store as a runner writes them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { openSqliteStore } from "../dist/store/index.js";
import { startServe } from "../dist/index.js";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, printed, startInProcessRunner } from "./support.mjs";

// The spec's own library, in the lockfile through the Anthropic SDK: what a receiver would install.
export const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const CHANNEL = "webhook-out";
const STATUS = { queued: "pending", sending: "pending", sent: "delivered", dropped: "failed" };

/** How long an awaited event may be missing before its test fails, naming it: a fence against a test that would hang to
 *  the runner's timeout when what it waits on never comes, never a timing (every pass waits for the event itself). */
const ARRIVAL_MS = 60_000;

/** The webhook's state in the store of data directory `dir`, read on a connection of the test's own: its messages
 *  (`status` pending, delivered or failed, as the API words them), its tries, oldest first, and its ledger by run (the
 *  end and the wait it told). Nothing when the store is not there yet. */
export function outboxOf(dir) {
  const file = join(dir, "store.sqlite");
  if (!existsSync(file)) return { messages: [], attempts: [], notices: {} };
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    const messages = db.prepare("SELECT id, moment, body, attempts, next_at, state, reason FROM channel_posts WHERE channel = ? ORDER BY created_at, id").all(CHANNEL)
      .map((m) => ({ id: m.id, type: m.moment, body: m.body, attempts: Number(m.attempts), next_at: Number(m.next_at), status: STATUS[m.state], reason: m.reason }));
    const attempts = db.prepare("SELECT post_id, moment, status_code, error, redelivery FROM channel_attempts WHERE channel = ? ORDER BY seq").all(CHANNEL)
      .map((a) => ({ webhook_id: a.post_id, type: a.moment, status_code: a.status_code === null ? null : Number(a.status_code), error: a.error, redelivery: Number(a.redelivery) === 1 }));
    const notices = {};
    for (const row of db.prepare("SELECT run_id, marker FROM channel_told WHERE channel = ? ORDER BY at").all(CHANNEL)) {
      const kind = row.marker.startsWith("ended:") ? "ended" : "wait";
      (notices[row.run_id] ??= {})[kind] = row.marker.slice(kind === "ended" ? 6 : 5);
    }
    return { messages, attempts, notices };
  } finally {
    db.close();
  }
}
/** What the webhook holds in `dir`, in one line, for a failure's words: each message's type and status, and the ledger. */
function outboxState(dir) {
  try {
    const outbox = outboxOf(dir);
    return `outbox: ${outbox.messages.map((m) => `${m.type} ${m.status}`).join(", ") || "no message"}; ledger: ${JSON.stringify(outbox.notices)}`;
  } catch (error) {
    return `outbox: not read (${error.message})`;
  }
}
/** `promise`, or a failure naming `what` (a string, or one made at the failure) once ARRIVAL_MS pass without it, with the
 *  webhook's state in `dir` as it stood then. */
export function arriving(promise, what, dir) {
  let timer;
  const fence = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${typeof what === "function" ? what() : what} did not come within ${ARRIVAL_MS / 1000} s${dir ? ` (${outboxState(dir)})` : ""}`)), ARRIVAL_MS);
    timer.unref();
  });
  return Promise.race([promise, fence]).finally(() => clearTimeout(timer));
}


/** A receiver on 127.0.0.1 at a port of its own: each request to its own path, with its headers and body, answered
 *  `answer(n)` (n from 1; a promise holds the answer until it settles). A request to another path (another process's,
 *  at a port it once had) is not counted. `down`: every connection is reset, as a receiver that is not there.
 *  `when(n)`: once it holds `n` requests (or `when(check)`, once `check(got)`), the requests, as each one comes: no
 *  poll; `what` names it in the failure when it does not come (arriving), with the outbox in `dir` as it stood then. */
export async function receiver(t, answer = () => 200, down = false) {
  const got = [];
  const waiting = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (down) return void req.socket.destroy();
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      for (const w of [...waiting]) if (w.check(got)) (waiting.splice(waiting.indexOf(w), 1), w.resolve(got));
      void Promise.resolve(answer(got.length)).then((status) => {
        if (!res.destroyed) res.writeHead(status, status >= 300 && status < 400 ? { location: "http://127.0.0.1:1/elsewhere" } : {}).end();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  const when = (want, what = typeof want === "number" ? `request ${want} at the receiver` : "the request awaited at the receiver", dir) => {
    const check = typeof want === "number" ? (all) => all.length >= want : want;
    return check(got) ? Promise.resolve(got) : arriving(new Promise((resolve) => waiting.push({ check, resolve })), () => `${typeof what === "function" ? what() : what} (the receiver holds ${got.length}: ${got.map((r) => JSON.parse(r.body).type).join(", ") || "none"})`, dir);
  };
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got, server, when };
}

/** A log for a server or a Webhooks: `push` takes a line (or a say's fields, as a line), `when(...parts)` the first line
 *  holding every part, as it is said. */
export function logged() {
  const lines = [];
  const waiting = [];
  const push = (line) => {
    const text = typeof line === "string" ? line : Object.entries(line).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(text);
    for (const w of [...waiting]) if (w.parts.every((part) => text.includes(part))) (waiting.splice(waiting.indexOf(w), 1), w.resolve(text));
  };
  const when = (...parts) => {
    const found = lines.find((line) => parts.every((part) => line.includes(part)));
    return found ? Promise.resolve(found) : arriving(new Promise((resolve) => waiting.push({ parts, resolve })), `the log line with ${parts.join(" and ")}`);
  };
  return { lines, push, when };
}

/** `check()`'s value once truthy, read again at each change in `dir` (the store's file or its write-ahead log written
 *  there): what the server writes, awaited as it is written, never polled. A read that meets a write mid-way is read again
 *  at the next change. */
export function onDisk(dir, check, what = `the state awaited in ${dir}`) {
  const read = () => {
    try {
      return check();
    } catch {
      return undefined;
    }
  };
  const now = read();
  if (now) return Promise.resolve(now);
  let watcher;
  const written = new Promise((resolve) => {
    watcher = watch(dir, (_, file) => {
      // A reader's own shared-memory or journal file is no write of the server's.
      if (file && /-(shm|journal)$/.test(file)) return;
      const value = read();
      if (value) (watcher.close(), resolve(value));
    });
    // A change between the first read and the watch: read once more, now that it watches.
    const value = read();
    if (value) (watcher.close(), resolve(value));
  });
  return arriving(written, what, dir).finally(() => watcher.close());
}

/** The webhook's messages, none still to try. A message is tried only while pending (webhooks.ts schedule), so with none
 *  pending no try is armed and nothing more is sent. */
export function nothingPending(dir) {
  const { messages } = outboxOf(dir);
  assert.deepEqual(messages.filter((m) => m.status === "pending").map((m) => m.id), [], "no message still to try");
  return messages;
}
/** Once the store holds no message still to try (each answered and written): then nothing more is sent. */
export const settled = (dir) => onDisk(dir, () => outboxOf(dir).messages.every((m) => m.status !== "pending"), "every message answered and written");
/** What the webhook's ledger holds of a run: undefined for none. */
export const noticed = (dir, runId) => outboxOf(dir).notices[runId];
/** The ledger's end of the run, as `{ended_at, queued}`. */
export const endNotice = (dir, runId) => (noticed(dir, runId)?.ended ? { ended_at: noticed(dir, runId).ended, queued: true } : undefined);
/** The ledger's wait of the run, as `{marker}`. */
export const waitNotice = (dir, runId) => (noticed(dir, runId)?.wait ? { marker: noticed(dir, runId).wait } : undefined);
/** The webhook-id a run's notice has (webhooks.ts emit): its run, its type and the marker of its moment. */
export const noticeId = (runId, type, marker) => `msg_${createHash("sha256").update(`${runId}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;

/** The store in `dir` refusing every write `when` names (a SQLite trigger that aborts it, put in on a connection of the
 *  test's own), as a store that cannot take that write: the webhook's messages (`outbox`) or its setting (`setting`). The
 *  rest of the store is written as ever. Answers its release; the test's end releases it at the latest. */
export function refusing(t, dir, when) {
  const name = `test_refuses_${when}`;
  const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 10_000 });
  const on = when === "outbox"
    ? [`BEFORE INSERT ON channel_posts WHEN NEW.channel = '${CHANNEL}'`]
    : [`BEFORE INSERT ON settings WHEN NEW.key = '${CHANNEL}'`, `BEFORE UPDATE ON settings WHEN NEW.key = '${CHANNEL}'`];
  on.forEach((what, i) => db.exec(`CREATE TRIGGER ${name}_${i} ${what} BEGIN SELECT RAISE(ABORT, 'the test refuses this write'); END`));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    on.forEach((_, i) => db.exec(`DROP TRIGGER IF EXISTS ${name}_${i}`));
    db.close();
  };
  t.after(release);
  return release;
}

/** A server on `data` in a process of its own, started by `script` (the CLI's banner, or a fixture's address line), killed
 *  as a crash does at the test's end at the latest. */
export async function processOn(t, data, args = [CLI, "--data", data, "--port", "0", "--faux", FAUX]) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  // Everything it prints, from its start: its log lines are on stdout (the CLI's log), its errors on stderr.
  child.printed = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (child.printed += chunk));
  const out = await printed(child, /^AGENTRUN_API_KEY=/m);
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], readFileSync(join(data, ".token"), "utf8").trim()) };
}
export const killed = async (child) => {
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
};
/** Every unhandled rejection while `t` runs: one would stop a server. */
export function rejections(t) {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on("unhandledRejection", on);
  t.after(() => process.off("unhandledRejection", on));
  return seen;
}

/** A server on `options.data` with a runner beside it on the same data (support's in-process runner, as serve() starts
 *  one), so a run it starts runs: `close()` stops the runner, letting go of its claims, then the server. `runner: false`:
 *  the server alone, for a test that writes its runs into the store itself. */
export async function startWithRunner({ runner = true, ...options }) {
  const server = await startServe({ port: 0, faux: FAUX, drainTimeout: "5s", ...options });
  const stopRunner = runner ? await startInProcessRunner(options.data, { faux: FAUX }) : async () => {};
  return { ...server, close: async () => (await stopRunner(), await server.close()) };

}
/** A turn of the event loop: past the microtasks, where an unhandled rejection is said. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

/** The spec's verification, as its text gives it: the HMAC-SHA256 of "{id}.{timestamp}.{body}" under the secret's
 *  base64 bytes, base64, among the header's space-separated `v1,` signatures; a timestamp within 5 minutes. */
export function verifies(secret, { headers, body }, now = Date.now() / 1000) {
  const [id, timestamp] = [headers["webhook-id"], headers["webhook-timestamp"]];
  if (!id || !/^\d+$/.test(timestamp ?? "") || Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest();
  return String(headers["webhook-signature"] ?? "").split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
export const ofType = (got, type) => got.filter((r) => JSON.parse(r.body).type === type);

export async function meetsDocument(api, path, method, status, value) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[status].content["application/json"].schema, value), [], JSON.stringify(value));
}

/** Every file under `dir`, read. */
export const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name)));

/** Run `id` of `agentId`, parked on the question it asked, as a runner leaves it (its ask, then its release as parked):
 *  written into the store by `writer` (a runner's handle), so no runner's ask_person is needed. Its wake time is past, so
 *  the test can claim it again (no runner runs beside these tests' servers to claim it first). */
export async function parkedOnQuestion(writer, agentId, id, question, { wake = true } = {}) {
  const ROOT = 1;
  const at = Date.now();
  await writer.runs.create({ id, agentId, revisionId: `${agentId}-rev` }, { body: { input: { message: "Help me." }, title: `Asks ${id}`, place: { mode: "runner" } } });
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  const journal = writer.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: at }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "ask_person", arguments: { question } }], usage: { cost: { total: 0.01 } }, timestamp: at + 1 }] };
  const r = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: [{ type: "text", text: "asked" }], timestamp: at + 2 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, { type: "entry", value: r }], BACKGROUND_CONTEXT);
  // Its wake time past, the test can claim it again; with a runner up (`wake: false`), none, so no runner claims it.
  await writer.release(claim, { state: "parked", wakeAt: wake ? Date.now() - 1 : null });
}
/** Run `id` of `agentId`, ended with its answer, as a runner ends one: written into the store by `writer`. Its end's time,
 *  as the store stamped it (ISO), which its run.ended's webhook-id is made from. */
export async function endedInStore(writer, agentId, id, { beforeEnd } = {}) {
  const ROOT = 1;
  const at = Date.now();
  await writer.runs.create({ id, agentId, revisionId: `${agentId}-rev` }, { body: { input: { message: "Answer." }, title: `Ends ${id}`, place: { mode: "runner" } } });
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  const journal = writer.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Answer.", timestamp: at }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0.01 } }, timestamp: at + 1 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }], BACKGROUND_CONTEXT);
  await beforeEnd?.();
  const row = await writer.runs.update(claim, { state: "ended" });
  return new Date(row.endedAt).toISOString();
}
/** Run `id`, parked, ended by `state` under a new claim (stopped, as a cancel leaves it; or ended). */
export async function endParked(writer, id, state) {
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  return (await writer.runs.update(claim, { state })).endedAt;
}
/** A server on `data` that had the webhook set to `hook` and stopped: what a restart starts from. */
export async function hadWebhook(data, hook) {
  const first = await startWithRunner({ data, runner: false });
  assert.equal((await client(first.baseUrl, first.token)("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await first.close();
}
/** Run `id`, parked, read again under a new claim: claimed and let go as parked, its wait as it was (a new epoch). */
export async function reclaimed(writer, id) {
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  await writer.release(claim, { state: "parked", wakeAt: Date.now() - 1 });
}
/** The server's store, as a runner's handle on it, and the agent `asker` in it. */
export async function askerStore(t, data) {
  const writer = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(() => writer.close());
  await writer.agents.create({ id: "asker", name: "asker" }, { id: "asker-rev", kind: "agentic", body: { instructions: "Answer." } });
  return writer;
}


/** The outbound webhook on a store of its own (a fresh SQLite file in a scratch directory), as a server holds it: `open()`
 *  is a server's start (a new Webhooks on the same store, loaded), so two opens are a restart. `runs(...ids)` puts the runs
 *  a notice names in the store (a told row names its run); `setAt(iso)` moves when the webhook was set. */
export async function webhookOn(t, dir, { retryMs = [] } = {}) {
  const { Webhooks } = await import("../dist/webhooks.js");
  const store = await openSqliteStore({ file: join(dir, "store.sqlite") });
  t.after(() => store.close());
  await store.agents.create({ id: "a", name: "a" }, { id: "rev-a", kind: "agentic", body: {} });
  const key = randomBytes(32);
  const made = new Set();
  return {
    store,
    open: async (say = () => undefined) => {
      const webhooks = new Webhooks(store, key, say, retryMs);
      t.after(() => webhooks.close());
      await webhooks.load();
      return webhooks;
    },
    runs: async (...ids) => {
      for (const id of ids) if (!made.has(id)) (made.add(id), await store.runs.create({ id, agentId: "a", revisionId: "rev-a" }));
    },
    setAt: async (iso) => store.settings.put("webhook-out", { ...(await store.settings.get("webhook-out")), updated_at: iso }),
  };
}

/** Once a server in a process of its own (processOn) has printed `text` (its log is on stdout), what it printed. */
export function saidBy(child, text) {
  let onData;
  const heard = new Promise((resolve) => {
    onData = () => child.printed.includes(text) && resolve(child.printed);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    onData();
  });
  return arriving(heard, `the line with ${text} from the server's process`).finally(() => (child.stdout.off("data", onData), child.stderr.off("data", onData)));
}

/** The webhook's store in `dir` as an earlier server, or a pruning, left it: `told` its ledger rows ({run: {ended, wait}}),
 *  written as they stand, and its messages and tries gone (`cleared`), as later attempts push them out of the log. */
export function leftAs(dir, { told, cleared = false } = {}) {
  const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 10_000 });
  try {
    if (cleared) {
      db.prepare("DELETE FROM channel_attempts WHERE channel = 'webhook-out'").run();
      db.prepare("DELETE FROM channel_posts WHERE channel = 'webhook-out'").run();
    }
    if (told) {
      db.prepare("DELETE FROM channel_told WHERE channel = 'webhook-out'").run();
      for (const [runId, noticed] of Object.entries(told)) {
        for (const [kind, marker] of Object.entries(noticed)) db.prepare("INSERT INTO channel_told (channel, run_id, marker, at) VALUES ('webhook-out', ?, ?, ?)").run(runId, `${kind === "ended" ? "ended" : "wait"}:${marker}`, Date.now());
      }
    }
  } finally {
    db.close();
  }
}
