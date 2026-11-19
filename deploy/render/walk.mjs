// The Render button's walk, on Render itself: render.yaml's service made through Render's API in the workspace named by
// --owner, as the button's Blueprint makes it (the image, the plan, the disk, the health check, and its variables, with
// AGENTRUN_TOKEN and AGENTRUN_SEAL_KEY generated as Render's generateValue does). Then the first visit's setup with the
// token as the code, the OpenRouter key saved in Settings with the owner's session, and the Railway walk's first run
// (deploy/railway/publish-and-walk.mjs FIRST_RUN: a no-tool Release notes agent on pi, capped at $1). The service is
// deleted at the end, whatever happened, and a walk's service an earlier run left is deleted first. It goes through the
// API, not the Blueprint screen, so it doesn't test Render's reading of the file.
//   RENDER_API_KEY=<api key> OPENROUTER_API_KEY=<key> node deploy/render/walk.mjs --owner "<workspace name>"
// REPORT=<file> puts the report in that file too. Exits 0 on PASS. RENDER_API_KEY, OPENROUTER_API_KEY, AGENTRUN_TOKEN,
// AGENTRUN_SEAL_KEY and the session cookie are never printed. Render bills by the second: a walk costs about $0.001.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { FIRST_RUN, onStop } from "../railway/publish-and-walk.mjs";
import { isMain } from "../../scripts/is-main.mjs";

export const PREFIX = "agentrun-render-walk-";

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

  const rows = [];
  const row = (step, result, evidence) => {
    rows.push({ step, result, evidence });
    console.log(`${result} ${step}: ${evidence}`);
  };
  const t = { clicked: 0 };
  const since = (at) => `${((at - t.clicked) / 1000).toFixed(1)} s`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(what, ms, every, probe) {
    const end = Date.now() + ms;
    for (;;) {
      const got = await probe().catch((e) => { if (e.final) throw e; return undefined; });
      if (got !== undefined) return got;
      if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
      await sleep(every);
    }
  }
  async function render(method, path, body) {
    const r = await fetch(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const gone = (id) => until(`service ${id} gone`, 3 * 60_000, 5_000, async () => {
    const r = await fetch(`https://api.render.com/v1/services/${id}`, { headers: { authorization: `Bearer ${key}` } });
    return r.status === 404 ? true : undefined;
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
      row("earlier walk's service deleted", "PASS", `${s.name} (${s.id})`);
    }

    const name = `${PREFIX}${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`;
    const token = randomBytes(32).toString("hex");
    const body = serviceRequest(blueprint, { ownerId: owner.id, name, generated: { AGENTRUN_TOKEN: token, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } });
    t.clicked = Date.now();
    const made = await render("POST", "/services", body);
    const service = made.service ?? made;
    serviceId = service.id;
    stopped = onStop(() => render("DELETE", `/services/${serviceId}`));
    const base = service.serviceDetails?.url ?? (await render("GET", `/services/${serviceId}`)).serviceDetails?.url;
    if (!base) throw new Error(`service ${serviceId} has no URL`);
    row("service made", "PASS", `${name} (${serviceId}) in "${owner.name}": ${svc.image.url}, plan ${svc.plan}, ${svc.disk.sizeGB} GB disk at ${svc.disk.mountPath}, ${body.envVars.map((e) => e.key).join(", ")} (generated values not shown)`);

    const deploy = await until("the first deploy live", 15 * 60_000, 10_000, async () => {
      const [d] = (await render("GET", `/services/${serviceId}/deploys?limit=1`)).map((x) => x.deploy);
      if (d && /failed|canceled/.test(d.status)) throw Object.assign(new Error(`deploy ${d.id} ${d.status}`), { final: true });
      return d?.status === "live" ? d : undefined;
    });
    t.live = Date.now();
    row("deploy live", "PASS", `deploy ${deploy.id} live ${since(t.live)} after the create`);

    const health = await until(`${base}/v2/health 200`, 5 * 60_000, 3_000, async () => {
      const r = await fetch(`${base}/v2/health`);
      return r.status === 200 ? r.json() : undefined;
    });
    t.healthy = Date.now();
    row("healthy", "PASS", `GET ${base}/v2/health: 200 ${JSON.stringify(health)}, ${since(t.healthy)}`);

    const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    if (page.status !== 200 || !/text\/html/.test(page.headers.get("content-type") ?? "")) throw new Error(`GET ${base}/ answered ${page.status} ${page.headers.get("content-type")}, not the console`);
    const session = await (await fetch(`${base}/v2/auth/session`)).json();
    if (session.password_set !== false || session.setup_code !== true) throw new Error(`the first visit does not ask for the setup code: ${JSON.stringify(session)}`);
    row("first visit asks for the setup code", "PASS", `GET / is the console; GET /v2/auth/session: ${JSON.stringify(session)}`);
    const setup = await fetch(`${base}/v2/setup`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ code: token, password: randomBytes(18).toString("base64url") }) });
    const signedIn = await setup.json().catch(() => ({}));
    if (setup.status !== 201 || signedIn.signed_in !== true) throw new Error(`POST /v2/setup with AGENTRUN_TOKEN as the code answered ${setup.status} ${JSON.stringify(signedIn)}`);
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
    t.setUp = Date.now();
    row("token works as the setup code", "PASS", `POST /v2/setup: 201, signed in (session cookie not shown), ${since(t.setUp)}`);

    const saved = await fetch(`${base}/v2/settings/tool-keys/openrouter`, { method: "PUT", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ values: { OPENROUTER_API_KEY: orKey } }) });
    if (saved.status !== 204) throw new Error(`PUT /v2/settings/tool-keys/openrouter answered ${saved.status}: ${(await saved.text()).slice(0, 300)}`);
    row("model key saved", "PASS", "OPENROUTER_API_KEY saved in Settings with the owner's session: 204 (value not shown)");

    const api = async (method, path, payload) => {
      const r = await fetch(`${base}/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const got = await r.json().catch(() => ({}));
      if (r.status >= 300) throw new Error(`${method} /v2${path} answered ${r.status}: ${got.error?.message ?? JSON.stringify(got).slice(0, 300)}`);
      return got;
    };
    const agent = await api("POST", "/agents", { definition: { ...FIRST_RUN.agent, harness: "pi", model: FIRST_RUN.model, tools: [], place: { mode: "runner" }, max_cost_usd: FIRST_RUN.maxCostUsd } });
    row("agent made", "PASS", `"${FIRST_RUN.agent.name}" (${agent.agent_id}): pi on ${FIRST_RUN.model}, no tools, capped at $${FIRST_RUN.maxCostUsd}`);
    const started = await api("POST", `/agents/${agent.agent_id}/runs`, { input: { content: FIRST_RUN.input } });
    const run = await until(`run ${started.run_id} ended`, 10 * 60_000, 3_000, async () => {
      const r = await api("GET", `/runs/${started.run_id}`);
      return ["completed", "failed", "cancelled", "input_required"].includes(r.status) ? r : undefined;
    });
    t.finished = Date.now();
    t.modelUsd = run.cost?.usd ?? null;
    if (run.status !== "completed") throw new Error(`run ${started.run_id} ended ${run.status}: ${JSON.stringify(run.error ?? run.pending ?? null)}`);
    row("first run finished", "PASS", `run ${started.run_id}: completed, model $${t.modelUsd}, ${since(t.finished)} after the create`);
  } catch (error) {
    row("walk", "FAIL", error.message);
  } finally {
    stopped();
    if (serviceId) {
      try {
        await render("DELETE", `/services/${serviceId}`);
        await gone(serviceId);
        t.deleted = Date.now();
        row("service deleted", "PASS", `${serviceId} (and its disk), ${since(t.deleted)} after the create`);
      } catch (error) {
        row("service deleted", "FAIL", `${serviceId}: ${error.message}; the next walk deletes it, or delete it in Render's dashboard`);
      }
      const minutes = ((t.deleted ?? Date.now()) - t.clicked) / 60_000;
      row("render cost", "PASS", `${minutes.toFixed(1)} min at $${usdPerMonth}/month (${svc.plan} + ${svc.disk.sizeGB} GB disk, list prices, by the second): about $${((usdPerMonth / (30 * 24 * 60)) * minutes).toFixed(3)}`);
    }
  }
  const verdict = rows.some((r) => r.result === "FAIL") ? "FAIL" : "PASS";
  const times = { click_to_healthy_s: t.healthy && (t.healthy - t.clicked) / 1000, click_to_first_run_s: t.finished && (t.finished - t.clicked) / 1000, model_usd: t.modelUsd };
  const report = `Verdict: ${verdict}\n\nTimes: ${JSON.stringify(times)}\n\n| step | result | evidence |\n| --- | --- | --- |\n${rows.map((r) => `| ${r.step} | ${r.result} | ${r.evidence.replace(/\|/g, "\\|")} |`).join("\n")}\n`;
  if (process.env.REPORT) writeFileSync(process.env.REPORT, report);
  console.log(`Verdict: ${verdict} ${JSON.stringify(times)}`);
  return verdict === "PASS" ? 0 : 1;
}

if (isMain(import.meta)) process.exitCode = await main();
