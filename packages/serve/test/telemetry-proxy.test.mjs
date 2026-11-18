// telemetry.agentrun.ai (deploy/telemetry/worker.js), the Worker between the server's usage counts and PostHog: an event
// the server sends goes on whole and alone, with none of the request's headers, so PostHog never gets the sender's
// address; anything that is not one of ours is refused and nothing is sent on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, MAX_BYTES, PATH, UPSTREAM } from "../../../deploy/telemetry/worker.js";
import { startTelemetry, TELEMETRY_KEY, TELEMETRY_URL } from "../dist/telemetry.js";

const config = JSON.parse(readFileSync(new URL("../../../deploy/telemetry/wrangler.json", import.meta.url), "utf8"));
const env = { TELEMETRY_KEY };
const scratch = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-telemetry-proxy-"));

/** PostHog in place of the network: every request the Worker sent on, with its headers and parsed body. */
const upstream = (answer = () => new Response("{}")) => {
  const got = [];
  return { got, send: async (url, init) => (got.push({ url, headers: init.headers, body: JSON.parse(init.body) }), answer()) };
};
/** What the server sends, as the Worker gets it from Cloudflare: with the sender's address in every header that names one. */
const arriving = (body, more = {}) =>
  new Request(more.url ?? TELEMETRY_URL, {
    method: more.method ?? "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7", "true-client-ip": "203.0.113.7", cookie: "a=b", "user-agent": "node", ...more.headers },
    ...(more.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** One real event from the server's own code: a data directory's second start sends server_started. */
async function serverEvent() {
  const data = await scratch();
  const sent = [];
  const options = { data, env: {}, key: TELEMETRY_KEY, fetch: async (_url, init) => (sent.push(JSON.parse(init.body)), new Response("{}")), say: () => {} };
  await startTelemetry(options).close();
  await startTelemetry(options).close();
  assert.equal(sent.length, 1);
  return sent[0];
}

test("the Worker serves the server's route, under the server's key, with nothing logged", () => {
  assert.match(TELEMETRY_KEY, /^phc_[A-Za-z0-9]+$/);
  assert.equal(config.vars.TELEMETRY_KEY, TELEMETRY_KEY);
  const url = new URL(TELEMETRY_URL);
  assert.equal(url.pathname, PATH);
  assert.deepEqual(config.routes, [{ pattern: url.hostname, custom_domain: true }]);
  assert.equal(config.observability.enabled, false);
  assert.equal(config.workers_dev, false);
  assert.equal(config.vars.UPSTREAM, undefined);
  assert.equal(UPSTREAM, "https://us.i.posthog.com/i/v0/e/");
});

test("the server's event goes on to PostHog whole, with content-type its only header", async () => {
  const event = await serverEvent();
  const p = upstream();
  const answer = await handle(arriving(event), env, p.send);
  assert.equal(answer.status, 200);
  assert.equal(p.got.length, 1);
  assert.equal(p.got[0].url, UPSTREAM);
  assert.deepEqual(p.got[0].headers, { "content-type": "application/json" });
  assert.deepEqual(p.got[0].body, event);
  assert.doesNotMatch(JSON.stringify(p.got[0]), /203\.0\.113\.7/);
});

test("a field the docs do not list never reaches PostHog", async () => {
  const event = await serverEvent();
  const p = upstream();
  const more = { ...event, $ip: "203.0.113.7", host: "laptop", properties: { ...event.properties, $ip: "203.0.113.7", path: "/home/me", $geoip_disable: false, $process_person_profile: true } };
  assert.equal((await handle(arriving(more), env, p.send)).status, 200);
  assert.deepEqual(p.got[0].body, event);
});

test("anything not one of ours is refused, and nothing is sent on", async () => {
  const event = await serverEvent();
  const p = upstream();
  const refused = [
    [arriving(event, { url: "https://telemetry.agentrun.ai/batch/" }), 404],
    [arriving(event, { url: "https://telemetry.agentrun.ai/" }), 404],
    [arriving(event, { method: "GET" }), 405],
    [arriving(event, { method: "PUT" }), 405],
    [arriving({ ...event, padding: "x".repeat(MAX_BYTES) }), 413],
    [arriving(event, { headers: { "content-length": String(MAX_BYTES + 1) } }), 413],
    [arriving("{not json"), 400],
    [arriving([event]), 400],
    [arriving({ ...event, api_key: "phc_someoneelse" }), 400],
    [arriving({ ...event, api_key: undefined }), 400],
    [arriving({ ...event, event: "$pageview" }), 400],
    [arriving({ ...event, distinct_id: "laptop.local" }), 400],
    [arriving({ ...event, timestamp: "yesterday" }), 400],
    [arriving({ ...event, properties: { ...event.properties, version: "<script>" } }), 400],
    [arriving({ ...event, properties: { ...event.properties, runs: "7" } }), 400],
    [arriving({ ...event, properties: { ...event.properties, node: "24" } }), 400],
    [arriving({ ...event, properties: undefined }), 400],
  ];
  for (const [request, status] of refused) assert.equal((await handle(request, env, p.send)).status, status, `${request.method} ${request.url}`);
  assert.deepEqual(p.got, []);
  // A Worker with no key set takes nothing.
  assert.equal((await handle(arriving(event), {}, p.send)).status, 400);
  assert.deepEqual(p.got, []);
});

test("PostHog refusing or out of reach is a 502", async () => {
  const event = await serverEvent();
  assert.equal((await handle(arriving(event), env, upstream(() => new Response("no", { status: 401 })).send)).status, 502);
  assert.equal((await handle(arriving(event), env, async () => { throw new TypeError("fetch failed"); })).status, 502);
});
