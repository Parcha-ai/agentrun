// A hosted machine's minted token on serve's side (computer-attach.ts machineTokens, spec/computer/attach.md): a dial
// provider's create mints it for the machine's name, the store keeps its SHA-256 alone, and it lets the machine's
// computerd dial the attach socket, where its socket stands for that machine and its hello must say what it was minted
// as, and fetch this server's computerd build (GET /v2/computers/daemon, ten a minute per machine). Unknown, revoked and
// expired tokens are 401 before anything; a revoke closes the live socket with 4401. Neither the token nor its SHA-256 is
// ever in a log line of the server's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { serve, storeBytes } from "./support.mjs";
import { attachDriver, DRIVER_HELLO } from "./fixtures/attach-driver.mjs";

const { ATTACH_PATH, ATTACH_SUBPROTOCOL } = await import("@parcha/agentrun-computer");
const { DAEMON_FETCHES_PER_MINUTE } = await import("../dist/computer-attach.js");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MINT = { kind: DRIVER_HELLO.kind, os: DRIVER_HELLO.os, arch: DRIVER_HELLO.arch };
const UNKNOWN = `art_${"0".repeat(64)}`;
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
const inMs = (ms) => new Date(Date.now() + ms);

/** Polls `read` until `done` holds of its answer, or fails after `ms` with the last answer. */
async function until(read, done, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The attach upgrade's answer to `token`: its status when refused, or open. */
function dial(server, token) {
  const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}` } });
  ws.on("error", () => undefined);
  return new Promise((resolve) => {
    ws.once("open", () => (resolve({ open: true }), ws.terminate()));
    ws.once("unexpected-response", (req, res) => (resolve({ open: false, status: res.statusCode }), req.destroy()));
  });
}

/** GET /v2/computers/daemon with `token`. */
const fetchDaemon = (server, token, arch = "amd64") => fetch(`${server.baseUrl}/computers/daemon?arch=${arch}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

test("a minted token: kept as its SHA-256, it dials the attach socket as its machine; a hello of another kind is 4400; unknown, expired and revoked tokens are 401, and a revoke closes the live socket with 4401", async (t) => {
  const lines = [];
  const server = await serve(t, { runner: false, log: (line) => lines.push(line) });
  assert.equal(server.dial.hub, server.attachHub, "a dial provider's machines land in the server's hub");
  assert.equal(server.dial.url, undefined, "with no public URL, no address to dial: a dial provider's create refuses");
  const token = await server.dial.tokens.mint("computer-00000000000a", { ...MINT, expiresAt: inMs(60_000) });
  assert.match(token, /^art_[0-9a-f]{64}$/, "art_ and 32 random bytes in hex");
  const row = await server.store.mintedTokens.get("computer-00000000000a");
  assert.deepEqual({ ...row, createdAt: typeof row.createdAt }, { machine: "computer-00000000000a", ...MINT, expiresAt: row.expiresAt, revokedAt: null, createdAt: "number" });
  const db = new DatabaseSync(join(server.data, "store.sqlite"), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT token_sha256 FROM minted_tokens WHERE machine = ?").get("computer-00000000000a").token_sha256, sha256(token), "the store keeps the SHA-256");
  assert.equal(storeBytes(server.data).includes(token), false, "and never the token");

  const address = server.url;
  const driver = attachDriver({ address, token, scale: 0.01 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => server.attachHub.online("computer-00000000000a"), Boolean, "the machine is in the hub under its name");
  assert.equal(server.attachHub.hello("computer-00000000000a").kind, DRIVER_HELLO.kind);

  // Minted as another kind than its hello says: closed with 4400, and it dials no more.
  const other = await server.dial.tokens.mint("computer-00000000000b", { ...MINT, kind: "linux", expiresAt: inMs(60_000) });
  const wrong = attachDriver({ address, token: other, scale: 0.01 });
  t.after(() => wrong.stop());
  wrong.start();
  await until(async () => wrong.stopped, Boolean, "the mismatched machine stops dialing");
  assert.deepEqual(wrong.stopped, { code: 4400 });
  assert.equal(server.attachHub.online("computer-00000000000b"), false);

  assert.deepEqual(await dial(server, UNKNOWN), { open: false, status: 401 }, "an unknown token");
  const expiring = await server.dial.tokens.mint("computer-00000000000c", { ...MINT, expiresAt: inMs(200) });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await dial(server, expiring), { open: false, status: 401 }, "a token past its end");

  await server.dial.tokens.revoke("computer-00000000000a");
  await until(async () => driver.stopped, Boolean, "the machine stops dialing once its token is revoked");
  assert.deepEqual(driver.stopped, { code: 4401 });
  assert.equal(server.attachHub.online("computer-00000000000a"), false);
  assert.deepEqual(await dial(server, token), { open: false, status: 401 }, "a revoked token");

  // The daemon route takes the same token, refused alike.
  for (const [said, refused] of [["unknown", UNKNOWN], ["expired", expiring], ["revoked", token], ["none", undefined]]) {
    assert.equal((await fetchDaemon(server, refused)).status, 401, `a daemon fetch with a token ${said}`);
  }
  const logged = lines.join("\n");
  for (const secret of [token, other, expiring]) {
    assert.equal(logged.includes(secret), false, "no log line holds a token");
    assert.equal(logged.includes(sha256(secret)), false, "nor its SHA-256");
  }
  assert.match(logged, /machine_attached/);
  assert.match(logged, /machine_refused/);
  assert.match(logged, /machine_token_revoked/);
});

test("the daemon route serves this server's computerd build for the machine's arch, the bytes a hosted provider uploads; ten fetches a minute per machine, then 429; another arch is 422; the token is in no log line", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const lines = [];
  const server = await serve(t, { runner: false, publicUrl: "https://agentrun.example.com/", log: (line) => lines.push(line) });
  assert.equal(server.dial.url, "https://agentrun.example.com", "the public URL (AGENTRUN_PUBLIC_URL) is the address its machines dial");
  const token = await server.dial.tokens.mint("computer-00000000000d", { ...MINT, expiresAt: inMs(60_000) });
  const first = await fetchDaemon(server, token);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "application/octet-stream");
  assert.equal(sha256(Buffer.from(await first.arrayBuffer())), sha256(readFileSync(DAEMON)), "the build's bytes");
  const arch = await fetchDaemon(server, token, "x86");
  assert.equal(arch.status, 422);
  assert.equal((await arch.json()).error.fields[0].field, "arch");
  for (let i = 2; i < DAEMON_FETCHES_PER_MINUTE; i++) assert.equal((await fetchDaemon(server, token, "x86")).status, 422);
  const limited = await fetchDaemon(server, token);
  assert.equal(limited.status, 429, "the eleventh fetch in a minute");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  // Another machine's token is not held by it.
  const other = await server.dial.tokens.mint("computer-00000000000e", { ...MINT, expiresAt: inMs(60_000) });
  assert.equal((await fetchDaemon(server, other, "x86")).status, 422);
  const logged = lines.join("\n");
  for (const secret of [token, other]) {
    assert.equal(logged.includes(secret), false, "no log line holds a token");
    assert.equal(logged.includes(sha256(secret)), false, "nor its SHA-256");
  }
});
