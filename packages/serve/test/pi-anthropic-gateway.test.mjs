// pi's Anthropic route honors ANTHROPIC_BASE_URL as claude-agent's does (adapters.ts claudeProvider): every Anthropic
// model request of a pi run goes to <base>/v1/messages with ANTHROPIC_API_KEY as x-api-key, and nothing else of the
// host's (ANTHROPIC_AUTH_TOKEN as a bearer, OpenRouter's key) goes there. Capabilities say pi's default model is ready
// only where that route can run: a gateway it could not reach, or one with no ANTHROPIC_API_KEY, is not ready.
// Every request goes to a loopback gateway (fixtures/faux-gateway.mjs) on a port below the ephemeral range, with dummy
// keys, and the run's processes load the net guard, so nothing leaves this machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** Dummy keys: none is a real one. */
const KEY = (name) => `not-a-secret-${name}`;
/** Every variable these tests set or clear, so one test's settings never reach the next. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NET_GUARD_LOG", "NODE_OPTIONS"];
const MODEL = "anthropic/claude-haiku-4-5";
/** Every answer's usage: 1000 tokens in, 100 out. claude-haiku-4-5 in serve's catalog: $1 in, $5 out per million. */
const USAGE = { input: 1000, output: 100 };
const AT_PRICE = (USAGE.input * 1 + USAGE.output * 5) / 1e6;
const GUARD = new URL("./fixtures/net-guard.mjs", import.meta.url);

/** A port free on 127.0.0.1 now, below the kernel's ephemeral range (no listen(0) or outbound connection is handed it). */
async function freePort() {
  let low = 32768;
  try {
    low = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768;
  } catch {}
  const to = Math.min(low, 32768);
  const from = Math.max(1024, Math.min(20000, to - 1000));
  for (let tries = 0; tries < 200; tries++) {
    const port = from + Math.floor(Math.random() * (to - from));
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}-${to - 1}`);
}

async function gateway(t) {
  const gw = await startFauxGateway({ usage: USAGE, port: await freePort() });
  t.after(() => gw.close());
  return gw;
}

test("pi through ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY: POST /v1/messages at the gateway, the key in x-api-key only and never ANTHROPIC_AUTH_TOKEN as a bearer, an anthropic-version, Anthropic's own model id, nothing off this machine, booked at the catalog's price", { timeout: 90_000 }, async (t) => {
  const gw = await gateway(t);
  const guardLog = join(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "net-guard-")), "guard.jsonl");
  withEnv(t, { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_API_KEY: KEY("anthropic"), ANTHROPIC_AUTH_TOKEN: KEY("host-token"), AGENT_MODEL: MODEL, NET_GUARD_LOG: guardLog, NODE_OPTIONS: `--import=${GUARD.href}` }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const { models } = (await api("GET", "/capabilities")).body;
  assert.deepEqual([models.source, models.default, models.ready], ["providers", MODEL, true], JSON.stringify(models));
  assert.equal((await api("POST", "/agents", agent("pi-anthropic-gw"))).status, 201);
  const started = await api("POST", "/agents/pi-anthropic-gw/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const posts = gw.requests.filter((r) => r.method === "POST");
  const shapes = [...new Set(posts.map((r) => JSON.stringify([r.path, r.headers.authorization ?? null, r.headers["x-api-key"] ?? null, r.body?.model])))].map((s) => JSON.parse(s));
  assert.deepEqual(shapes, [["/v1/messages", null, KEY("anthropic"), "claude-haiku-4-5"]], JSON.stringify({ requests: gw.requests, error: run.error }));
  assert.ok(posts.every((r) => typeof r.headers["anthropic-version"] === "string"), "each request names an anthropic-version");
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: Math.round(posts.length * AT_PRICE * 1e6) / 1e6, requests: posts.length }, "each answer once, from its usage, at the catalog's price");
  const refused = readFileSync(guardLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.kind === "refused");
  assert.deepEqual(refused, [], "nothing left this machine");
});

for (const [host, settings] of [
  ["only ANTHROPIC_AUTH_TOKEN, which a gateway never gets", (gw) => ({ ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: KEY("host-token") })],
  ["an ANTHROPIC_BASE_URL a key may not go to (plain http to another host)", () => ({ ANTHROPIC_BASE_URL: "http://gateway.example/anthropic", ANTHROPIC_API_KEY: KEY("anthropic") })],
]) {
  test(`capabilities: pi's Anthropic default is not ready where its route cannot run, with ANTHROPIC_BASE_URL and ${host}; claude-agent says the same`, { timeout: 60_000 }, async (t) => {
    const gw = await gateway(t);
    withEnv(t, { ...settings(gw), AGENT_MODEL: MODEL }, NAMES);
    const { api } = await serve(t, { faux: undefined });
    const { models, harnesses } = (await api("GET", "/capabilities")).body;
    assert.deepEqual([models.default, models.ready, models.needs], [MODEL, false, "key"], JSON.stringify(models));
    assert.equal(harnesses.find((h) => h.id === "claude-agent").available, false, JSON.stringify(harnesses));
    assert.deepEqual(gw.requests, [], "nothing reached the gateway");
  });
}
