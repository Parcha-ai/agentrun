// render.yaml's service, made through Render's API in the workspace named by --owner, on Render itself: render.yaml's
// image, plan, disk and health check, and its variables, with AGENTRUN_TOKEN and AGENTRUN_SEAL_KEY generated as Render's
// generateValue does. Then the Railway walk's steps (deploy/railway/publish-and-walk.mjs): the first visit, setup with
// the token as the code, the OpenRouter key saved in Settings with the owner's session, and FIRST_RUN, a no-tool agent
// on pi capped at $1. The service is deleted at the end, whatever happened, and a walk's service an earlier run left is
// deleted first. It goes through the API, not the Blueprint screen, so it doesn't test Render's reading of the file.
//   RENDER_API_KEY=<api key> OPENROUTER_API_KEY=<key> node deploy/render/walk.mjs --owner "<workspace name>"
// REPORT=<file> puts the report in that file too. Exits 0 on PASS. RENDER_API_KEY, OPENROUTER_API_KEY, AGENTRUN_TOKEN,
// AGENTRUN_SEAL_KEY and the session cookie are never printed. The report's "render cost" row is what the walk cost.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { FIRST_RUN, firstRunOf, firstVisit, onStop, report, rows, setUp, until } from "../railway/publish-and-walk.mjs";
import { isMain } from "../../scripts/is-main.mjs";

export const PREFIX = "agentrun-render-walk-";

/** Whether an anonymous pull finds the image `ghcr.io/<repo>:<tag>`, as Render's pull of a public image does: true when
 *  GHCR has the tag, false when it answers that it has none (404), undefined when it can't tell (another registry, a
 *  digest, any other answer, or the network). A release moves render.yaml's pin before its image is published, and a
 *  service made from a tag that isn't there bills while its deploy fails at the pull. */
export async function imagePublished(ref, http = fetch) {
  const m = /^ghcr\.io\/([a-z0-9._/-]+):([\w][\w.-]{0,127})$/.exec(ref);
  if (!m) return undefined;
  const [, repo, tag] = m;
  try {
    const grant = await http(`https://ghcr.io/token?scope=repository:${repo}:pull`, { signal: AbortSignal.timeout(15_000) });
    if (!grant.ok) return undefined;
    const { token } = await grant.json();
    const accept = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
    const r = await http(`https://ghcr.io/v2/${repo}/manifests/${tag}`, { method: "HEAD", headers: { authorization: `Bearer ${token}`, accept: accept.join(", ") }, signal: AbortSignal.timeout(15_000) });
    return r.status === 200 ? true : r.status === 404 ? false : undefined;
  } catch {
    return undefined;
  }
}

/** render.yaml's first service as the request that makes it, with the generated values in place of generateValue's, and
 *  the walk's usage counts off (docs/telemetry.md). */
export function serviceRequest(blueprint, { ownerId, name, generated }) {
  const svc = blueprint.services[0];
  const envVars = svc.envVars
    .filter((e) => e.value !== undefined || e.generateValue)
    .map((e) => ({ key: e.key, value: e.generateValue ? generated[e.key] : e.value }));
  envVars.push({ key: "AGENTRUN_TELEMETRY", value: "0" });
  return {
    type: "web_service",
    name,
    ownerId,
    image: { ownerId, imagePath: svc.image.url },
    envVars,
    serviceDetails: { runtime: "image", plan: svc.plan, numInstances: svc.numInstances, healthCheckPath: svc.healthCheckPath, disk: { name: svc.disk.name, mountPath: svc.disk.mountPath, sizeGB: svc.disk.sizeGB } },
  };
}

/** A request to the service through Render's edge, which answers 502, 503 or 504 itself, not in JSON, while a new deploy
 *  takes its traffic (a 502 came 3 s after the health check passed). Those are tried again every waitMs until forMs is
 *  up; any other answer, the server's JSON 503 included, is returned as it is, so a refusal is never sent twice. A POST
 *  goes under one Idempotency-Key for all its sends: a create the server made before the edge failed is replayed, not
 *  made again (setup takes no key; a second setup is refused, and the walk fails on it). Every send, and the wait for
 *  its answer, ends by the deadline. `retried.n` counts the edge's answers. */
export async function throughEdge(url, init, { fetch: send = fetch, waitMs = 3_000, forMs = 60_000, retried = { n: 0 } } = {}) {
  const end = Date.now() + forMs;
  const headers = new Headers(init?.headers);
  if (init?.method === "POST" && !headers.has("idempotency-key")) headers.set("idempotency-key", randomUUID());
  for (;;) {
    const response = await send(url, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, end - Date.now())) });
    const fromEdge = [502, 503, 504].includes(response.status) && !/json/i.test(response.headers.get("content-type") ?? "");
    if (!fromEdge || Date.now() + waitMs >= end) return response;
    await response.body?.cancel().catch(() => {});
    retried.n++;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function main() {
  const { values: args } = parseArgs({ options: { owner: { type: "string" } } });
  const { RENDER_API_KEY: key, OPENROUTER_API_KEY: orKey } = process.env;
  if (!key || !orKey || !args.owner) {
    console.error('usage: RENDER_API_KEY=... OPENROUTER_API_KEY=... node deploy/render/walk.mjs --owner "<workspace name>"');
    return 2;
  }
  const blueprint = parse(readFileSync(new URL("../../render.yaml", import.meta.url), "utf8"));
  const svc = blueprint.services[0];
  // Render's list prices when this was written: 1 CPU / 2 GB at $25 a month, a disk at $0.25 per GB-month, by the second.
  const usdPerMonth = 25 + 0.25 * svc.disk.sizeGB;

  const step = rows((line) => console.log(line));
  const times = { clicked: 0 };
  const since = (at) => `${((at - times.clicked) / 1000).toFixed(1)} s`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The shared steps' clients: Render's API as it is, and the service through Render's edge (throughEdge).
  const renderApi = { http: fetch, sleep };
  const edge = { n: 0 };
  const service = { http: (url, init) => throughEdge(url, init, { retried: edge }), sleep };
  async function render(method, path, body) {
    const r = await fetch(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const gone = (id) => until(renderApi, `service ${id} gone`, 3 * 60_000, 5_000, async () => {
    const r = await fetch(`https://api.render.com/v1/services/${id}`, { headers: { authorization: `Bearer ${key}` } }).catch(() => undefined);
    return r?.status === 404 ? true : undefined;
  });

  let serviceId;
  let stopped = () => {};
  try {
    const owner = (await render("GET", "/owners?limit=20")).map((o) => o.owner).find((o) => o.name === args.owner);
    if (!owner) throw new Error(`the key has no workspace named "${args.owner}": nothing made`);
    // A walk's service an earlier run could not delete: it bills until it goes.
    const left = (await render("GET", `/services?ownerId=${owner.id}&type=web_service&limit=100`)).map((s) => s.service).filter((s) => s.name.startsWith(PREFIX));
    for (const s of left) {
      await render("DELETE", `/services/${s.id}`);
      await gone(s.id);
      step.pass("earlier walk's service deleted", `${s.name} (${s.id})`);
    }

    // The button's service pulls this tag too: one that isn't published fails both, so the walk says so and makes nothing.
    const published = await imagePublished(svc.image.url);
    if (published === false) throw new Error(`render.yaml's image ${svc.image.url} is not published (GHCR has no such tag for an anonymous pull): nothing made. A release moves this pin before its image is published, and the Deploy to Render button fails the same way until it is`);
    if (published) step.pass("image published", `${svc.image.url}: GHCR has it for an anonymous pull, as Render pulls it`);

    const name = `${PREFIX}${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`;
    const token = randomBytes(32).toString("hex");
    const body = serviceRequest(blueprint, { ownerId: owner.id, name, generated: { AGENTRUN_TOKEN: token, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } });
    times.clicked = Date.now();
    const made = await render("POST", "/services", body);
    serviceId = (made.service ?? made).id;
    stopped = onStop(() => render("DELETE", `/services/${serviceId}`));
    const base = (made.service ?? made).serviceDetails?.url ?? (await render("GET", `/services/${serviceId}`)).serviceDetails?.url;
    if (!base) throw new Error(`service ${serviceId} has no URL`);
    step.pass("service made", `${name} (${serviceId}) in "${owner.name}": ${svc.image.url}, plan ${svc.plan}, ${svc.disk.sizeGB} GB disk at ${svc.disk.mountPath}, ${body.envVars.map((e) => e.key).join(", ")} (generated values not shown)`);

    // A failed or canceled deploy ends the wait; a read of Render's API that failed is asked again.
    let ended;
    const deploy = await until(renderApi, "the first deploy live", 15 * 60_000, 10_000, async () => {
      const [d] = (await render("GET", `/services/${serviceId}/deploys?limit=1`).catch(() => [])).map((x) => x.deploy);
      if (d && /failed|canceled/.test(d.status)) ended = d;
      return d?.status === "live" || ended ? d : undefined;
    });
    if (ended) throw new Error(`deploy ${ended.id} ${ended.status}`);
    times.live = Date.now();
    step.pass("deploy live", `deploy ${deploy.id} live ${since(times.live)} after the create`);

    const health = await until(renderApi, `${base}/v2/health answered 200`, 5 * 60_000, 3_000, async () => {
      const r = await fetch(`${base}/v2/health`).catch(() => undefined);
      return r?.status === 200 ? r.json() : undefined;
    });
    times.healthy = Date.now();
    step.pass("healthy", `GET ${base}/v2/health: 200 ${JSON.stringify(health)}, ${since(times.healthy)} after the create`);

    await firstVisit(service, { base, step });
    const cookie = await setUp(service, { base, token, step, times });
    await firstRunOf(service, { base, token, cookie, key: orKey, model: FIRST_RUN.model, step, times });
  } catch (error) {
    step.fail("walk", error.message);
  } finally {
    stopped();
    if (edge.n) step.pass("render edge", `answered 502, 503 or 504 ${edge.n} time(s) before the server did; each request tried again (throughEdge)`);
    if (serviceId) {
      try {
        await render("DELETE", `/services/${serviceId}`);
        await gone(serviceId);
        times.deleted = Date.now();
        step.pass("service deleted", `${serviceId} (and its disk), ${since(times.deleted)} after the create`);
      } catch (error) {
        step.fail("service deleted", `${serviceId}: ${error.message}; the next walk deletes it, or delete it in Render's dashboard`);
      }
      const minutes = ((times.deleted ?? Date.now()) - times.clicked) / 60_000;
      step.pass("render cost", `${minutes.toFixed(1)} min at $${usdPerMonth}/month (${svc.plan} + ${svc.disk.sizeGB} GB disk, list prices, by the second): about $${((usdPerMonth / (30 * 24 * 60)) * minutes).toFixed(3)}`);
    }
  }
  const timings = { click_to_healthy_s: times.healthy && (times.healthy - times.clicked) / 1000, click_to_first_run_s: times.finished && (times.finished - times.clicked) / 1000, model_usd: times.modelUsd ?? null };
  const text = `${report(step.all)}\n\nTimes: ${JSON.stringify(timings)}\n`;
  if (process.env.REPORT) writeFileSync(process.env.REPORT, text);
  console.log(text);
  return step.all.length && step.all.every((r) => r[1] === "PASS") ? 0 : 1;
}

if (isMain(import.meta)) process.exitCode = await main();
