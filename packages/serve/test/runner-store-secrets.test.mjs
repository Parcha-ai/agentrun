// At each claim the runner's redaction set is its environment's secrets and every secret the server keeps sealed, from one
// read of the store across all its planes (store.sealedSecrets, runner/store-secrets.ts), not only the keys a claim hands
// its run (runner-claim-redact). A run whose provider fails with an error quoting one writes it nowhere in the clear: not
// in the run's row and summary, its journal, the store's files or the runner's log. One row per plane; each value is
// planted in the store (or, for the outbound webhook's secret, beside it in the data directory) and never in the runner's
// environment. A run's live viewer token, minted in the run, is held as its browser hands it over.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { seal } from "@parcha/pi-durable-agent";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { openSqliteStore, sealColumn, sealedAt, sealMcpCredential } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { sealedSettingsOverStore } = await import("../dist/sealed-settings-store.js");
const { webhook } = await import("../dist/trigger-webhook.js");
const { Webhooks } = await import("../dist/webhooks.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch, liveViewersOf } = await import("../dist/runner/adapter-run-spec.js");
const { heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");
after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const AGENT = "agent-1";
/** A planted value: distinct per row, long enough to be a key, built for the test and no real one. */
const planted = (name) => `planted${name}${"q8".repeat(12)}`;
/** A trigger setting written as the store-backed settings write one (sealed-settings-store.ts), any field's value. */
const putSetting = (server, adapter, scope, field, value) => server.triggerSettings.put({ adapter, scope, field, sealed: seal(SEAL_KEY, Buffer.from(value, "utf8"), `trigger_settings|${adapter}|${scope}|${field}`).toString("base64") });

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** What this process writes to stderr and the console while `t` runs. */
function captureLogs(t) {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  const consoled = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoled[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  t.after(() => {
    process.stderr.write = write;
    for (const [level, fn] of Object.entries(consoled)) console[level] = fn;
  });
  return () => lines.join("\n");
}

const storeText = (dir) => ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("latin1")).join("\n");

/** A pi run through the runner after `plant(server, dir)` keeps a secret, whose provider refuses its first request with an
 *  error quoting each value `plant` gives back; each value is checked in the run's row, journal, the store's files and the
 *  runner's log. */
async function runQuoting(t, plant) {
  const logs = captureLogs(t);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-store-secrets-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly." } });
  const values = await plant(server, dir);
  const launch = { input: { content: "Answer." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  let asked = 0;
  const fetch = async () => (asked += 1, new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `the request quoted ${values.join(" and ")}, which may not be sent` } }), { status: 400, headers: { "content-type": "application/json" } }));
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `routecredential${"r".repeat(12)}` }, fetch, price: () => 0 };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  await store.flush?.();
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  assert.ok(asked >= 1, "the provider was asked, and refused quoting the values");
  const sources = { "the run's row and summary": JSON.stringify(row), "the run's journal": JSON.stringify(entries), "the store's files": storeText(dir), "the runner's log": logs() };
  for (const value of values) {
    const found = Object.entries(sources).filter(([, text]) => text.includes(value)).map(([where]) => where);
    assert.deepEqual(found, [], `${JSON.stringify(value.slice(0, 16))}… is in none of the run's records`);
  }
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });

/** One row per plane: its name, and what plants its secret and gives back the values a run's text may quote. */
const PLANES = [
  ["a tool key the run is not handed (sealed_keys)", async (server) => {
    const value = planted("toolkey");
    await putSealedKey(server, SEAL_KEY, "MONID_API_KEY", value);
    return [value];
  }],
  ["a computer vendor's key (sealed_keys)", async (server) => {
    const value = planted("computerkey");
    await putSealedKey(server, SEAL_KEY, "DAYTONA_API_KEY", value);
    return [value];
  }],
  ["the Archil key (sealed_keys)", async (server) => {
    const value = planted("archilkey");
    await putSealedKey(server, SEAL_KEY, "archil.api_key", value);
    return [value];
  }],
  ["an MCP server's header (mcp_servers)", async (server) => {
    const value = planted("mcpheader");
    const url = "https://mcp.invalid/mcp";
    await server.mcp.put({ name: "headers", url, auth: "bearer", tools: [], sealed: sealMcpCredential(SEAL_KEY, "headers", { type: "headers", headers: { authorization: `Bearer ${value}` } }, url) });
    return [value];
  }],
  ["an MCP server's OAuth tokens and client secret (mcp_servers)", async (server) => {
    const [access, refresh, client] = [planted("mcpaccess"), planted("mcprefresh"), planted("mcpclient")];
    const url = "https://oauth-mcp.invalid/mcp";
    await server.mcp.put({ name: "oauth", url, auth: "oauth", tools: [], sealed: sealMcpCredential(SEAL_KEY, "oauth", { type: "oauth", set: { tokens: { access_token: access, refresh_token: refresh, token_type: "Bearer" }, client: { client_id: "agentrun", client_secret: client } } }, url) });
    return [access, refresh, client];
  }],
  ["an MCP sign-in in flight (mcp_oauth_pending)", async (server) => {
    const [verifier, client] = [planted("pkceverifier"), planted("pendingclient")];
    await server.mcpOauth.put({ state: "st-1", server: "oauth", sealed: sealColumn(SEAL_KEY, sealedAt.oauthPending("st-1"), JSON.stringify({ verifier, client: { client_id: "agentrun", client_secret: client } })), working: {}, expiresAt: Date.now() + 600_000 });
    return [verifier, client];
  }],
  ["the GitHub App's private key and webhook secret (trigger_settings, the github source)", async (server) => {
    const secret = planted("githubhook");
    await putSetting(server, "github", "server", "private_key", PEM);
    await putSetting(server, "github", "server", "webhook_secret", secret);
    const line = PEM.split("\n").find((one) => one && !one.startsWith("-----"));
    return [secret, line];
  }],
  ["a webhook trigger's signing secret, in its spellings (trigger_settings, the webhook source)", async (server) => {
    const settings = sealedSettingsOverStore(server, webhook.id, webhook.settings, SEAL_KEY, () => {});
    await settings.load();
    const secret = await settings.mint("trg-1", "secret");
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    return [secret, secret.slice("whsec_".length), key.toString("hex")];
  }],
  ["a retired webhook trigger secret and a retired GitHub App key (trigger_settings, scope retired:<scope>:<n>)", async (server) => {
    // As the trigger settings keep a value they no longer hold (rotated, or its trigger deleted): sealed in a row of its own,
    // scope retired:<scope>:<n>, under that row's AAD.
    const secret = planted("retiredhook");
    await putSetting(server, "webhook", "retired:trg-9:1", "secret", secret);
    const { privateKey: old } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = old.export({ type: "pkcs8", format: "pem" });
    await putSetting(server, "github", "retired:server:1", "private_key", pem);
    return [secret, pem.split("\n").find((one) => one && !one.startsWith("-----"))];
  }],
  ["the agent's browser sign-in pointer (sign_ins)", async (server) => {
    const pointer = planted("signinpointer");
    await server.signIns.save({ agentId: AGENT, provider: "browserbase", name: "Work", pointerSealed: sealColumn(SEAL_KEY, sealedAt.signIn(AGENT, "browserbase"), pointer) });
    return [pointer];
  }],
  ["a forgotten browser sign-in pointer (sign_in_tombstones)", async (server) => {
    const pointer = planted("forgottenpointer");
    await server.signIns.save({ agentId: AGENT, provider: "steel", name: "Old", pointerSealed: sealColumn(SEAL_KEY, sealedAt.signIn(AGENT, "steel"), pointer) });
    await server.signIns.forget(AGENT, "steel", {});
    return [pointer];
  }],
  ["the server's outbound webhook signing secret, in its spellings (trigger_settings, adapter webhook-out)", async (server) => {
    const hooks = new Webhooks(server, SEAL_KEY, () => {});
    await hooks.load();
    const { secret } = await hooks.save({ url: "https://hooks.invalid/agentrun" });
    await hooks.close();
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    return [secret, secret.slice("whsec_".length), key.toString("hex")];
  }],
];

for (const [plane, plant] of PLANES) {
  test(`${plane} is cut from a run's records`, { timeout: 120_000 }, async (t) => {
    await runQuoting(t, plant);
  });
}

test("a run's live viewer token (computer_viewers) is held by the run's one redactor from the hand-over", async () => {
  const token = `${"v".repeat(40)}abc`;
  const redact = heldRedactor(secretRedactor([]));
  const put = [];
  const viewers = liveViewersOf({ liveViewers: { put: async (_claim, viewer) => (put.push(viewer), true), drop: async () => {} } }, SEAL_KEY, { runId: RUN, epoch: 1 }, redact);
  assert.equal(await viewers.put({ port: 4100, id: "i".repeat(22), token, tag: "s1" }), true);
  assert.equal(put.length, 1, "the hand-over was written");
  assert.equal(redact(`the viewer is at /view?token=${token}`), "the viewer is at /view?token=[redacted]");
});
