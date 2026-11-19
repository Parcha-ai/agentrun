// Publishes deploy/railway/template.json as AgentRun's Railway template and walks it: one deploy of the template into a
// throwaway project, its health, its first visit asking for the setup code, the token made for it working as that code,
// with --first-run an agent's first run finished on a model key saved in the console, then the project deleted.
// Run through publish-and-walk.sh, which says how; this file is its body.
//
// Railway's public API makes a template only from a project (templateGenerate) and changes none of a template's services
// once made, so the template is generated from a source project in the workspace, agentrun-template-source, kept in step
// with template.json and never deployed (each change is committed with skipDeploys). A template whose deploy would differ
// from template.json in anything (image, start command, health check, variables, domain port, volume) stops the run
// before any deploy, saying where. A template made by hand in Railway's template editor is walked and published with
// --template CODE.
//
// Every request goes through curl with its headers and body in the config curl reads on stdin, so the Railway token, the
// deploy's AGENTRUN_TOKEN and a model key are never in a process's arguments, in a file, or in the output.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../../scripts/is-main.mjs";
import { differences, loadTemplate, onlyService, renderVariables } from "./template.mjs";

export const API = "https://backboard.railway.com/graphql/v2";
// The template takes its name, and its published code, from this project.
export const SOURCE_PROJECT = "AgentRun";
// The mark of the source project this script made: a project by that name without it is never touched.
export const SOURCE_DESCRIPTION = "The source of AgentRun's Railway template (deploy/railway/template.json). Never deployed.";
export const WALK_PROJECT = "agentrun-template-walk";
const README = new URL("../README.md", import.meta.url);
const OVERVIEW = new URL("./overview.md", import.meta.url);
// Railway takes a description of at most 75 characters.
export const PUBLISH = { category: "AI/ML", description: "AgentRun, an open-source platform for running agents, on Railway" };

/** The first run --first-run makes: a no-tool agent on pi, the model key saved as a person saves it in the console's
 *  Settings, and a cap well under the walk's budget. */
export const FIRST_RUN = {
  keyId: "openrouter",
  keyName: "OPENROUTER_API_KEY",
  model: "openrouter/anthropic/claude-haiku-5.5",
  maxCostUsd: 1,
  agent: { name: "Release notes", instructions: "Write short release notes for the changes you are given: a heading, then one bullet per change in plain words." },
  input: "Write release notes: added CSV export to the runs page; fixed the date filter resetting after refresh; renamed workspace settings to Settings.",
};

// Railway's list prices (railway.com/pricing), per minute: what the walk's usage is costed at.
export const PRICE_PER_MINUTE = { CPU_USAGE: 0.00000772 * 60, MEMORY_USAGE_GB: 0.00000386 * 60, DISK_USAGE_GB: 0.00000006 * 60 };

// Every operation this script sends, each checked against Railway's live schema by --check-api.
export const OPS = {
  Workspace: `query Workspace($id: String!) { workspace(workspaceId: $id) { id name } }`,
  Projects: `query Projects($workspaceId: String!) { projects(workspaceId: $workspaceId, first: 100) { edges { node { id name description createdAt environments { edges { node { id name } } } services { edges { node { id name } } } } } } }`,
  ProjectCreate: `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name workspace { id name } environments { edges { node { id name } } } } }`,
  ServiceCreate: `mutation ServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
  VolumeCreate: `mutation VolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
  ServiceDomainCreate: `mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain targetPort } }`,
  EnvironmentConfig: `query EnvironmentConfig($id: String!) { environment(id: $id) { id config } }`,
  EnvironmentPatchCommit: `mutation EnvironmentPatchCommit($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: true) }`,
  WorkspaceTemplates: `query WorkspaceTemplates($workspaceId: String!) { workspaceTemplates(workspaceId: $workspaceId, first: 100) { edges { node { id name code status createdAt serializedConfig } } } }`,
  TemplateGenerate: `mutation TemplateGenerate($projectId: String!, $environmentId: String) { templateGenerate(input: { projectId: $projectId, environmentId: $environmentId }) { id code status serializedConfig } }`,
  Template: `query Template($code: String!) { template(code: $code) { id code status serializedConfig } }`,
  TemplateDeploy: `mutation TemplateDeploy($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }`,
  ProjectRename: `mutation ProjectRename($id: String!, $name: String!) { projectUpdate(id: $id, input: { name: $name }) { id name } }`,
  WorkflowStatus: `query WorkflowStatus($id: String!) { workflowStatus(workflowId: $id) { status error } }`,
  Project: `query Project($id: String!) { project(id: $id) { id name deletedAt workspace { id name } environments { edges { node { id name } } } services { edges { node { id name } } } } }`,
  Deployments: `query Deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt } } } }`,
  Domains: `query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain targetPort } } }`,
  Variables: `query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
  DeploymentLogs: `query DeploymentLogs($id: String!, $filter: String) { deploymentLogs(deploymentId: $id, filter: $filter, limit: 200) { message timestamp } }`,
  BuildLogs: `query BuildLogs($id: String!) { buildLogs(deploymentId: $id, limit: 200) { message timestamp } }`,
  Metrics: `query Metrics($projectId: String!, $environmentId: String!, $serviceId: String!, $startDate: DateTime!) { metrics(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, includeDeleted: true, measurements: [CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB]) { measurement values { ts value } } }`,
  Usage: `query Usage($projectId: String!, $startDate: DateTime) { usage(projectId: $projectId, startDate: $startDate, includeDeleted: true, measurements: [CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB, NETWORK_TX_GB]) { measurement value } }`,
  TemplatePublish: `mutation TemplatePublish($id: String!, $input: TemplatePublishInput!) { templatePublish(id: $id, input: $input) { id code status } }`,
  ProjectDelete: `mutation ProjectDelete($id: String!) { projectDelete(id: $id) }`,
  TemplateDelete: `mutation TemplateDelete($id: String!, $input: TemplateDeleteInput!) { templateDelete(id: $id, input: $input) }`,
};

/** The README's Railway button: the one line after the mark. Until the template is published it is the placeholder, the
 *  button commented out, so no one clicks a link to a template that does not exist. */
export const BUTTON_MARK = "<!-- railway-button: publish-and-walk.sh prints this line's replacement once the template is published -->";
export const buttonLine = (code) => `[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/${code}?utm_medium=integration&utm_source=button&utm_campaign=agentrun)`;
export const BUTTON_PLACEHOLDER = `<!-- ${buttonLine("TEMPLATE_CODE")} -->`;
/** The template code of the README's button (the line after the mark), or undefined while it is the placeholder. */
export function buttonCode(readme) {
  const lines = readme.split("\n");
  const line = lines[lines.indexOf(BUTTON_MARK) + 1] ?? "";
  return line.startsWith("<!--") ? undefined : /railway\.com\/new\/template\/([A-Za-z0-9-]+)/.exec(line)?.[1];
}

/** A GraphQL call's errors, as one Error naming the operation. */
class Refused extends Error {
  constructor(op, errors) {
    super(`${op}: ${errors.map((e) => `${e.message}${e.extensions?.code ? ` (${e.extensions.code})` : ""}`).join("; ")}`);
    this.errors = errors;
  }
}

/** curl's arguments for one request, its headers and body read from the config on stdin (-K -), the answer's status line
 *  after its body and its headers as JSON on stderr. Nothing secret is here. */
export function curlArgs(url, { method = "GET", timeoutS = 60 } = {}) {
  return ["-sS", "--max-time", String(timeoutS), "-X", method, "-K", "-", "-w", "\n%{http_code}%{stderr}%{header_json}", url];
}

const quoted = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

/** The config curl reads on stdin: one `header` line per header and the body as `data-binary`, each a quoted string. */
export const curlConfig = (headers = {}, body) =>
  [...Object.entries(headers).map(([k, v]) => `header = ${quoted(`${k}: ${v}`)}`), ...(body === undefined ? [] : [`data-binary = ${quoted(body)}`])].join("\n") + "\n";

/** An answer as the walk reads it, a Response's few parts: status, headers.get (a header's first value), json(), text(). */
export const answer = (status, headers, text) => ({ status, headers: { get: (n) => headers[n.toLowerCase()]?.[0] ?? null }, text: async () => text, json: async () => JSON.parse(text) });

/** One HTTP request through curl, its headers and body in the config on curl's stdin. */
export function curl(url, { method = "GET", headers = {}, body, timeoutS = 60 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", curlArgs(url, { method, timeoutS }), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      // Only curl's own lines: the rest of stderr is the answer's headers, which may set a session cookie.
      if (code !== 0) return reject(new Error(`${method} ${url}: curl exit ${code} ${err.split("\n").filter((l) => l.startsWith("curl:")).join(" ")}`));
      const cut = out.lastIndexOf("\n");
      let headers = {};
      try {
        headers = Object.fromEntries(Object.entries(JSON.parse(err.slice(err.indexOf("{")))).map(([k, v]) => [k.toLowerCase(), v]));
      } catch {}
      resolve(answer(Number(out.slice(cut + 1)), headers, out.slice(0, cut)));
    });
    child.stdin.on("error", () => {}); // curl may exit before it reads its config
    child.stdin.end(curlConfig(headers, body));
  });
}

/** Railway's API, for real: each operation by name, with the token (never printed) unless `anonymous`. */
export function liveClient({ token, api = API }) {
  return {
    async call(op, variables, { anonymous = false } = {}) {
      const res = await curl(api, {
        method: "POST",
        headers: { "content-type": "application/json", ...(anonymous ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ query: OPS[op], variables, operationName: op }),
      });
      const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}, not JSON` }] }));
      if (body.errors?.length) throw new Refused(op, body.errors);
      return body.data;
    },
    http: (url, init = {}) => curl(url, { ...init, timeoutS: 30 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Sends every operation in OPS, with no token, to Railway's API, whose validation runs before its authorization: an
 *  operation that names a field, argument or type its schema lacks is refused as GRAPHQL_VALIDATION_FAILED, and a
 *  variable of the wrong shape as BAD_USER_INPUT; a valid one gets as far as "Not Authorized". */
export async function checkApi(client, log) {
  const id = "00000000-0000-0000-0000-000000000000";
  const config = loadTemplate();
  const samples = {
    Workspace: { id }, Projects: { workspaceId: id },
    ProjectCreate: { input: { name: SOURCE_PROJECT, workspaceId: id, description: "check" } },
    ServiceCreate: { input: { projectId: id, environmentId: id, name: "AgentRun" } },
    VolumeCreate: { input: { projectId: id, environmentId: id, serviceId: id, mountPath: "/data" } },
    ServiceDomainCreate: { input: { environmentId: id, serviceId: id, targetPort: 7340 } },
    EnvironmentConfig: { id }, EnvironmentPatchCommit: { environmentId: id, patch: {}, commitMessage: "check" },
    WorkspaceTemplates: { workspaceId: id }, TemplateGenerate: { projectId: id, environmentId: id },
    Template: { code: "agentrun-check-api" },
    TemplateDeploy: { input: { templateId: id, serializedConfig: walkValues(config), workspaceId: id } },
    ProjectRename: { id, name: WALK_PROJECT }, WorkflowStatus: { id }, Project: { id },
    Deployments: { input: { projectId: id, environmentId: id, serviceId: id } },
    Domains: { projectId: id, environmentId: id, serviceId: id }, Variables: { projectId: id, environmentId: id, serviceId: id },
    DeploymentLogs: { id, filter: "Set up this server" }, BuildLogs: { id },
    Usage: { projectId: id, startDate: new Date(0).toISOString() },
    Metrics: { projectId: id, environmentId: id, serviceId: id, startDate: new Date(0).toISOString() },
    TemplatePublish: { id, input: { ...PUBLISH, readme: "check", workspaceId: id } },
    ProjectDelete: { id }, TemplateDelete: { id, input: { workspaceId: id } },
  };
  let bad = 0;
  for (const op of Object.keys(OPS)) {
    let verdict;
    try {
      await client.call(op, samples[op], { anonymous: true });
      verdict = "valid (answered)";
    } catch (error) {
      const codes = (error.errors ?? []).map((e) => e.extensions?.code);
      if (!error.errors || codes.some((c) => c === "GRAPHQL_VALIDATION_FAILED" || c === "GRAPHQL_PARSE_FAILED" || c === "BAD_USER_INPUT")) {
        bad++;
        verdict = `INVALID: ${error.message}`;
      } else verdict = `valid (${error.errors[0].message})`;
    }
    log(`  ${op}: ${verdict}`);
  }
  return bad;
}

const edges = (connection) => (connection?.edges ?? []).map((e) => e.node);

/** The source project's patch: the service's image, deploy settings and variables as template.json has them (a variable
 *  it no longer has is removed). Its volume and domain are made by their own calls. */
export function sourcePatch(service, serviceId, current = {}) {
  const variables = {};
  for (const name of Object.keys(current.variables ?? {})) variables[name] = null;
  for (const [name, v] of Object.entries(service.variables ?? {})) {
    variables[name] = { value: v.defaultValue ?? "", ...(v.description ? { description: v.description } : {}), ...(v.isOptional ? { isOptional: true } : {}) };
  }
  return { services: { [serviceId]: { source: { image: service.source.image }, deploy: service.deploy, variables } } };
}

/** A template's config as its deploy form sends it untouched, as the Railway CLI's `deploy --template` does: each
 *  variable's `value` is its default; one with no default is left out. */
export function formValues(config) {
  const out = structuredClone(config);
  for (const service of Object.values(out.services ?? {})) {
    for (const v of Object.values(service.variables ?? {})) if (v?.defaultValue) v.value = v.defaultValue;
  }
  return out;
}

/** The walk's deploy: the form as the template fills it, plus AGENTRUN_TELEMETRY=0, since the walk's server is ours and
 *  sends no usage counts (docs/telemetry.md). The template itself leaves them on. */
export function walkValues(config) {
  const out = formValues(config);
  for (const service of Object.values(out.services ?? {})) service.variables = { ...service.variables, AGENTRUN_TELEMETRY: { value: "0" } };
  return out;
}

/** Waits for `check` to return a value (not undefined), asking every `everyMs`, for at most `forMs`; else throws `what`.
 *  The walks' shared steps (until, rows, firstVisit, setUp, firstRunOf, report) take a client of `http` (fetch's shape)
 *  and `sleep`: Railway's, or deploy/render/walk.mjs's through Render's edge. */
export async function until(client, what, forMs, everyMs, check) {
  const end = Date.now() + forMs;
  for (;;) {
    const got = await check();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`${what}: not within ${Math.round(forMs / 1000)} s`);
    await client.sleep(everyMs);
  }
}

/** The walk's report rows, `step | PASS or FAIL | evidence`, as deploy/walk's are. */
export function rows(log) {
  const all = [];
  return {
    all,
    pass: (step, evidence) => (all.push([step, "PASS", evidence]), log(`${step} | PASS | ${evidence}`)),
    fail: (step, evidence) => (all.push([step, "FAIL", evidence]), log(`${step} | FAIL | ${evidence}`)),
  };
}

/** A project this run made, checked to be in the workspace it was given: one elsewhere is deleted and the run stops. */
async function inWorkspace(client, project, workspaceId) {
  const at = project.workspace ?? (await client.call("Project", { id: project.id })).project.workspace;
  if (at?.id === workspaceId) return;
  await client.call("ProjectDelete", { id: project.id }).catch(() => {});
  throw new Error(`project ${project.id} was made in workspace ${at?.name ?? "?"} (${at?.id ?? "?"}), not ${workspaceId}: deleted it, and stopped`);
}

/** The template brought in step with template.json: the source project made or updated, the template generated from it
 *  when the one it has differs (or there is none), and that template checked against template.json. */
async function ensureTemplate(client, { workspaceId, config, step }) {
  const { service } = onlyService(config);
  const projects = edges((await client.call("Projects", { workspaceId })).projects);
  const named = projects.filter((p) => p.name === SOURCE_PROJECT);
  let source = named.find((p) => p.description === SOURCE_DESCRIPTION);
  if (!source && named.length > 0) throw new Error(`the workspace has a project named ${SOURCE_PROJECT} (${named[0].id}) that this script did not make: it changed nothing. Rename that project, or publish from another workspace`);
  let environmentId, serviceId;
  if (!source) {
    const made = (await client.call("ProjectCreate", { input: { name: SOURCE_PROJECT, workspaceId, description: SOURCE_DESCRIPTION } })).projectCreate;
    await inWorkspace(client, made, workspaceId);
    source = made;
    environmentId = edges(made.environments)[0].id;
    serviceId = (await client.call("ServiceCreate", { input: { projectId: made.id, environmentId, name: service.name } })).serviceCreate.id;
    step.pass("source project made", `${SOURCE_PROJECT} (${made.id}), service ${service.name} with no source yet, so nothing deploys`);
  } else {
    environmentId = edges(source.environments)[0]?.id;
    serviceId = edges(source.services).find((s) => s.name === service.name)?.id;
    if (!environmentId || !serviceId) throw new Error(`${SOURCE_PROJECT} (${source.id}) has no environment or no service named ${service.name}: delete the project and run again`);
    step.pass("source project found", `${SOURCE_PROJECT} (${source.id})`);
  }
  const current = (await client.call("EnvironmentConfig", { id: environmentId })).environment.config?.services?.[serviceId] ?? {};
  for (const [, mount] of Object.entries(service.volumeMounts ?? {})) {
    if (Object.values(current.volumeMounts ?? {}).some((m) => m.mountPath === mount.mountPath)) continue;
    await client.call("VolumeCreate", { input: { projectId: source.id, environmentId, serviceId, mountPath: mount.mountPath } });
    step.pass("source volume", `made at ${mount.mountPath}`);
  }
  for (const [, domain] of Object.entries(service.networking?.serviceDomains ?? {})) {
    if (Object.keys(current.networking?.serviceDomains ?? {}).length > 0) continue;
    await client.call("ServiceDomainCreate", { input: { environmentId, serviceId, targetPort: domain.port } });
    step.pass("source domain", `made, to port ${domain.port}`);
  }
  await client.call("EnvironmentPatchCommit", { environmentId, patch: sourcePatch(service, serviceId, current), commitMessage: "deploy/railway/template.json" });
  step.pass("source in step", `image ${service.source.image}, ${Object.keys(service.variables).length} variables, deploy settings; committed with skipDeploys`);

  // A workspace token may not read a project's template (templateSourceForProject), so the workspace's templates are
  // read instead: one that already deploys template.json is used again, a published one first.
  const ours = edges((await client.call("WorkspaceTemplates", { workspaceId })).workspaceTemplates).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const same = ours.filter((t) => t.name === SOURCE_PROJECT && differences(config, t.serializedConfig).length === 0);
  const had = same.find((t) => t.status === "PUBLISHED") ?? same[0];
  if (had) {
    step.pass("template", `${had.code} (${had.id}, ${had.status}) already deploys what template.json says`);
    return had;
  }
  // An earlier run's template (generated from the source project, so named after it, and deploying only AgentRun's
  // image) that was never published, so no button points at it, and deploys something else is deleted.
  const image = service.source.image.replace(/:[^:/]+$/, ":");
  const generated = (t) => t.name === SOURCE_PROJECT && Object.values(t.serializedConfig?.services ?? {}).every((s) => s.source?.image?.startsWith(image));
  for (const t of ours.filter((t) => t.status !== "PUBLISHED" && generated(t))) {
    await client.call("TemplateDelete", { id: t.id, input: { workspaceId } });
    step.pass("stale template deleted", `${t.code} (${t.id}): never published, and it deploys something other than template.json`);
  }
  const made = (await client.call("TemplateGenerate", { projectId: source.id, environmentId })).templateGenerate;
  const before = ours.find((t) => t.status === "PUBLISHED");
  const moved = before ? `; it replaces ${before.code}, whose button must move to the new code` : "";
  step.pass("template generated", `${made.code} (${made.id}) from ${SOURCE_PROJECT}${moved}`);
  return made;
}

const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;

/** A failed deployment's last build and deploy log lines, read before its project is deleted. A line with the setup
 *  code in it is left out. */
async function lastLines(client, id) {
  const read = async (op, field) => (await client.call(op, { id }).then((d) => d[field], (e) => [{ message: `(${op}: ${e.message})` }])).slice(-25);
  const lines = [...(await read("BuildLogs", "buildLogs")), ...(await read("DeploymentLogs", "deploymentLogs"))];
  return lines.map((l) => `    ${/#code=|setup code|AGENTRUN_TOKEN=/i.test(l.message) ? "(a line with the setup code, not shown)" : l.message}`).join("\n");
}

/** What the service used, from Railway's live metrics (CPU in vCPU and memory and disk in GB, sampled), each sample held
 *  until the next, the last until `now`, and costed at the list prices; and Railway's own usage figures for the project,
 *  which lag, beside it. */
export async function usageOf(client, { projectId, environmentId, serviceId, since, now = Date.now() }) {
  const out = { usd: null, by: {}, usage: null };
  try {
    const series = (await client.call("Metrics", { projectId, environmentId, serviceId, startDate: new Date(since).toISOString() })).metrics;
    const seconds = (ts) => (typeof ts === "number" ? ts : Date.parse(ts) / 1000);
    for (const { measurement, values } of series) {
      const points = [...values].sort((a, b) => seconds(a.ts) - seconds(b.ts));
      const end = (i) => (i + 1 < points.length ? seconds(points[i + 1].ts) : Math.max(now / 1000, seconds(points[i].ts)));
      out.by[measurement] = points.reduce((sum, p, i) => sum + p.value * (end(i) - seconds(p.ts)), 0) / 60;
    }
    out.usd = Object.entries(PRICE_PER_MINUTE).reduce((sum, [m, p]) => sum + (out.by[m] ?? 0) * p, 0);
  } catch (error) {
    out.why = error.message;
  }
  try {
    out.usage = Object.fromEntries((await client.call("Usage", { projectId, startDate: new Date(since).toISOString() })).usage.map((u) => [u.measurement, u.value]));
  } catch {}
  return out;
}

/** One deploy of the template into a throwaway project, checked as a person who clicks the button meets it, then deleted.
 *  With `firstRun` ({key, model}), the walk ends with that person's first run: the key saved in the console's Settings
 *  with the session setup signed in, then an agent made and run to completion with the deploy's own AGENTRUN_TOKEN. */
async function walk(client, { workspaceId, template, step, firstRun, times }) {
  const { service } = onlyService(template.serializedConfig);
  let projectId, environmentId, serviceId;
  let stopped = () => {};
  try {
    times.clicked = Date.now();
    const deployed = (await client.call("TemplateDeploy", { input: { templateId: template.id, serializedConfig: walkValues(template.serializedConfig), workspaceId } })).templateDeployV2;
    projectId = deployed.projectId;
    stopped = onStop(() => client.call("ProjectDelete", { id: projectId }));
    await client.call("ProjectRename", { id: projectId, name: `${WALK_PROJECT}-${Date.now()}` });
    step.pass("template deployed", `into a new project ${projectId}, with the form as the template fills it (and AGENTRUN_TELEMETRY=0)`);
    if (deployed.workflowId) {
      await until(client, "the template's deploy workflow completed", 10 * 60_000, 5_000, async () => {
        const s = (await client.call("WorkflowStatus", { id: deployed.workflowId })).workflowStatus;
        if (s.status === "Error") throw new Error(`the template's deploy workflow failed: ${s.error}`);
        return s.status === "Complete" ? s : undefined;
      });
    }
    const project = (await client.call("Project", { id: projectId })).project;
    await inWorkspace(client, project, workspaceId);
    environmentId = edges(project.environments)[0]?.id;
    serviceId = edges(project.services).find((s) => s.name === service.name)?.id;
    if (!environmentId || !serviceId) throw new Error(`the walk's project has no service named ${service.name}`);
    const deployment = await until(client, "the service's deploy succeeded", 20 * 60_000, 10_000, async () => {
      const d = edges((await client.call("Deployments", { input: { projectId, environmentId, serviceId } })).deployments)[0];
      if (d && ["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(d.status)) throw new Error(`the service's deploy ended ${d.status} (deployment ${d.id}); its last log lines:\n${await lastLines(client, d.id)}`);
      return d?.status === "SUCCESS" ? d : undefined;
    });
    times.deployed = Date.now();
    step.pass("deploy succeeded", `deployment ${deployment.id}: SUCCESS, after Railway's health check on ${service.deploy.healthcheckPath}, ${minutes(times.deployed - times.clicked)} after the deploy started`);

    const domain = (await client.call("Domains", { projectId, environmentId, serviceId })).domains.serviceDomains[0];
    if (!domain) throw new Error("the service has no Railway domain");
    const base = `https://${domain.domain}`;
    step.pass("public domain", `${base}, to port ${domain.targetPort}`);

    // Read, never printed: whether the template made the token and the seal key, and in what shape.
    const vars = (await client.call("Variables", { projectId, environmentId, serviceId })).variables;
    const made = [/^[0-9a-f]{64}$/.test(vars.AGENTRUN_TOKEN ?? ""), /^[A-Za-z0-9+/]{43}=$/.test(vars.AGENTRUN_SEAL_KEY ?? ""), vars.AGENTRUN_PUBLIC_URL === base];
    if (made.includes(false)) throw new Error(`the deploy's variables are not as made by the template: AGENTRUN_TOKEN 64 hex ${made[0]}, AGENTRUN_SEAL_KEY 32 bytes in base64 ${made[1]}, AGENTRUN_PUBLIC_URL ${base} ${made[2]}`);
    if (vars.PORT !== "7340" || vars.RAILWAY_RUN_UID !== "0") throw new Error(`PORT is ${JSON.stringify(vars.PORT)} and RAILWAY_RUN_UID ${JSON.stringify(vars.RAILWAY_RUN_UID)}, not "7340" and "0"`);
    step.pass("variables made", `AGENTRUN_TOKEN: 64 hex characters; AGENTRUN_SEAL_KEY: 32 bytes in base64 (values not shown); AGENTRUN_PUBLIC_URL: the domain; PORT 7340; RAILWAY_RUN_UID 0`);

    const health = await until(client, `${base}/v2/health answered 200`, 5 * 60_000, 5_000, async () => {
      const r = await client.http(`${base}/v2/health`).catch(() => undefined);
      return r?.status === 200 ? r.json() : undefined;
    });
    times.healthy = Date.now();
    step.pass("healthy", `GET ${base}/v2/health: 200 ${JSON.stringify(health)}, ${minutes(times.healthy - times.clicked)} after the deploy started`);

    await firstVisit(client, { base, step });

    const line = await until(client, "the setup line in the deploy's log", 3 * 60_000, 10_000, async () => {
      const logs = (await client.call("DeploymentLogs", { id: deployment.id, filter: "Set up this server" })).deploymentLogs;
      return logs.map((l) => l.message).find((m) => m.startsWith(`Set up this server: ${base}/setup#code=`));
    });
    step.pass("setup link at the domain", `the log's line starts "Set up this server: ${base}/setup#code=" (the code not shown) and is ${line.length} characters`);

    const cookie = await setUp(client, { base, token: vars.AGENTRUN_TOKEN, step, times });

    if (firstRun) await firstRunOf(client, { base, token: vars.AGENTRUN_TOKEN, cookie, key: firstRun.key, model: firstRun.model, step, times });
  } finally {
    stopped();
    if (projectId) {
      if (serviceId) {
        const usage = await usageOf(client, { projectId, environmentId, serviceId, since: times.clicked });
        times.usage = usage;
        const round = (by) => JSON.stringify(by, (k, v) => (typeof v === "number" ? Number(v.toPrecision(3)) : v));
        step.pass("railway usage", `${usage.usd === null ? `metrics not read: ${usage.why}` : `$${usage.usd.toFixed(5)} at list prices, from the service's metrics ${round(usage.by)} (vCPU-minutes and GB-minutes)`}; Railway's usage query: ${usage.usage ? round(usage.usage) : "not read"}`);
      }
      try {
        await client.call("ProjectDelete", { id: projectId });
        // Railway deletes in the background: the project reads as live for a while, then as not found.
        const gone = await until(client, "the throwaway project deleted", 3 * 60_000, 5_000, () =>
          client.call("Project", { id: projectId }).then((d) => (d.project.deletedAt ? true : undefined), (e) => (/not found/i.test(e.message) ? true : undefined)),
        ).catch(() => false);
        times.deleted = Date.now();
        if (gone) step.pass("throwaway project deleted", `${projectId}, ${minutes(times.deleted - times.clicked)} after the deploy started`);
        else step.fail("throwaway project deleted", `${projectId} still reads as live 3 minutes after the delete: delete it in the dashboard`);
      } catch (error) {
        step.fail("throwaway project deleted", `${projectId}: ${error.message}; delete it in the dashboard`);
      }
    }
  }
}

/** A person's first visit at `base`: GET / is the console, and the session read asks for the setup code. */
export async function firstVisit(client, { base, step }) {
  const page = await client.http(`${base}/`, { headers: { accept: "text/html" } });
  if (page.status !== 200 || !/text\/html/.test(page.headers.get("content-type") ?? "")) throw new Error(`GET ${base}/ answered ${page.status} ${page.headers.get("content-type")}, not the console`);
  const session = await (await client.http(`${base}/v2/auth/session`)).json();
  if (!(session.accounts === true && session.password_set === false && session.setup_code === true)) throw new Error(`the first visit's session read is ${JSON.stringify(session)}, not one that asks for the setup code`);
  step.pass("first visit asks for the setup code", `GET / is the console; GET /v2/auth/session: ${JSON.stringify(session)}`);
}

/** Setup with the server's token as the code and a password of the walk's: signed in. Returns the session cookie. */
export async function setUp(client, { base, token, step, times }) {
  const setup = await client.http(`${base}/v2/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code: token, password: randomBytes(18).toString("base64url") }),
  });
  const signedIn = await setup.json().catch(() => ({}));
  if (setup.status !== 201 || signedIn.signed_in !== true) throw new Error(`POST /v2/setup with AGENTRUN_TOKEN as the code answered ${setup.status} ${JSON.stringify(signedIn)}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  times.setUp = Date.now();
  step.pass("token works as the setup code", `POST ${base}/v2/setup with AGENTRUN_TOKEN as the code: 201, signed in${cookie ? " (a session cookie, not shown)" : ""}`);
  return cookie;
}

/** The person's first run: the model key saved in the console's Settings (a secret takes the owner's signed-in session,
 *  never the API token), then over the API with the deploy's AGENTRUN_TOKEN a no-tool agent on pi on the given model, one
 *  run of it to completion, and what its model cost. */
export async function firstRunOf(client, { base, token, cookie, key, model, step, times }) {
  if (!cookie) throw new Error("POST /v2/setup set no session cookie, so the model key can't be saved as the console saves it");
  const saved = await client.http(`${base}/v2/settings/tool-keys/${FIRST_RUN.keyId}`, {
    method: "PUT",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ values: { [FIRST_RUN.keyName]: key } }),
  });
  if (saved.status !== 204) throw new Error(`PUT /v2/settings/tool-keys/${FIRST_RUN.keyId} answered ${saved.status}: ${(await saved.text()).slice(0, 300)}`);
  step.pass("model key saved", `${FIRST_RUN.keyName} saved in the console's Settings with the owner's session: 204 (value not shown)`);
  const api = async (method, path, body) => {
    const r = await client.http(`${base}/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const got = await r.json().catch(() => ({}));
    if (r.status >= 300) throw new Error(`${method} /v2${path} answered ${r.status}: ${got.error?.message ?? JSON.stringify(got).slice(0, 300)}`);
    return got;
  };
  const definition = { ...FIRST_RUN.agent, harness: "pi", model, tools: [], place: { mode: "runner" }, max_cost_usd: FIRST_RUN.maxCostUsd };
  const agent = await api("POST", "/agents", { definition });
  step.pass("agent made", `"${FIRST_RUN.agent.name}" (${agent.agent_id}): pi on ${model}, no tools, on the runner, capped at $${FIRST_RUN.maxCostUsd}`);
  const started = await api("POST", `/agents/${agent.agent_id}/runs`, { input: { content: FIRST_RUN.input } });
  const run = await until(client, `run ${started.run_id} ended`, 10 * 60_000, 3_000, async () => {
    const r = await api("GET", `/runs/${started.run_id}`);
    // A run waiting for input never completes by itself: it ends the wait too, and the walk fails on it.
    return ["completed", "failed", "cancelled", "input_required"].includes(r.status) ? r : undefined;
  });
  times.finished = Date.now();
  times.runId = started.run_id;
  times.modelUsd = run.cost?.usd ?? null;
  if (run.status !== "completed") throw new Error(`run ${started.run_id} ended ${run.status}: ${JSON.stringify(run.error ?? run.pending ?? null)}`);
  const result = typeof run.result === "string" ? run.result : run.result?.content ?? JSON.stringify(run.result ?? null);
  times.result = result;
  step.pass("first run finished", `run ${started.run_id}: completed, model cost $${times.modelUsd}, ${minutes(times.finished - times.clicked)} after the deploy started; it wrote ${result.length} characters: ${JSON.stringify(result.slice(0, 160))}`);
}

/** What a walk made, deleted when the walk is stopped midway: Actions cancels a job (a person, or its time limit) with
 *  SIGINT, then SIGTERM seconds later, and a walk killed in a wait would never reach its own delete. `remove` runs once,
 *  then the process exits 130 or 143. Returns the call that takes the handlers off, once the walk deletes it itself. */
export function onStop(remove) {
  // A cancel is SIGINT, then SIGTERM about 7.5 s later: both stay caught while the delete runs, so the second one,
  // ignored, cannot kill a delete still in flight.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return console.error(`${signal}: still deleting what the walk made`);
    stopping = true;
    console.error(`${signal}: deleting what the walk made before exiting`);
    Promise.resolve().then(remove).catch((e) => console.error(`the delete on ${signal} failed: ${e.message}`)).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const off = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return off;
}

/** A walk's longest run (its waits added up, with room to spare): a walk project younger than this may be another run's,
 *  still walking, and is left alone. */
export const WALK_MAX_MS = 2 * 60 * 60_000;

/** Deletes walk projects an earlier run left (killed before its own delete), so none keeps running and billing. One
 *  younger than WALK_MAX_MS may be a live walk of another run in the workspace: it is named, never deleted. */
async function sweep(client, { workspaceId, step, now = Date.now() }) {
  const walks = edges((await client.call("Projects", { workspaceId })).projects).filter((p) => p.name.startsWith(`${WALK_PROJECT}-`));
  const live = (p) => !(now - Date.parse(p.createdAt) >= WALK_MAX_MS); // an unreadable createdAt counts as live
  const left = walks.filter((p) => !live(p));
  for (const p of left) await client.call("ProjectDelete", { id: p.id });
  if (left.length) step.pass("earlier walks swept", left.map((p) => `${p.name} (${p.id})`).join(", "));
  const running = walks.filter(live);
  if (running.length) step.pass("recent walks left alone", `${running.map((p) => `${p.name} (${p.id})`).join(", ")}: younger than ${WALK_MAX_MS / 3_600_000} h, maybe another run's`);
}

/** The whole run. `mode`: "publish" (the default), "walk" (an existing template, walked only) or "template" (one made in
 *  the editor, walked and published). `expectWorkspace`: the workspace's name, checked before anything is made.
 *  `firstRun`: {key, model} for the person's first run. Returns the report's rows; `times` gets the walk's timings. */
export async function run(client, { workspaceId, mode = "publish", code, expectWorkspace, firstRun, times = {}, log = console.error }) {
  const step = rows(log);
  const config = loadTemplate();
  try {
    const ws = (await client.call("Workspace", { id: workspaceId })).workspace;
    if (!ws) throw new Error(`workspace ${workspaceId} not found`);
    if (expectWorkspace !== undefined && ws.name !== expectWorkspace) throw new Error(`workspace ${workspaceId} is named ${JSON.stringify(ws.name)}, not ${JSON.stringify(expectWorkspace)}: nothing was made`);
    step.pass("workspace", `${ws.name} (${ws.id})${expectWorkspace !== undefined ? ", the one expected" : ""}`);
    times.workspace = ws.name;
    await sweep(client, { workspaceId, step });
    let template;
    if (mode === "publish") template = await ensureTemplate(client, { workspaceId, config, step });
    else {
      template = (await client.call("Template", { code })).template;
      step.pass("template found", `${template.code} (${template.id}), ${template.status}`);
    }
    const off = differences(config, template.serializedConfig);
    if (off.length) throw new Error(`template ${template.code} would deploy something other than deploy/railway/template.json:\n  ${off.join("\n  ")}\n${mode === "publish" ? "Railway can copy the source project before a change to it lands, so run again first: that run deletes this draft and copies the project again. If it still differs, make" : "Make"} them match in the template editor (railway.com/workspace/templates), since Railway's API can't change a template's services, then run again with --template ${template.code}`);
    step.pass("template is template.json", `${template.code}: image, start command, health check, variables, domain port and volume as the repository has them`);
    times.template = { id: template.id, code: template.code };
    await walk(client, { workspaceId, template, step, firstRun, times });
    if (mode !== "walk" && !step.all.some((r) => r[1] === "FAIL")) {
      const readme = readFileSync(OVERVIEW, "utf8");
      const published = (await client.call("TemplatePublish", { id: template.id, input: { ...PUBLISH, readme, workspaceId } })).templatePublish;
      times.template = { id: published.id, code: published.code, url: `https://railway.com/deploy/${published.code}` };
      step.pass("published", `${published.code}: ${published.status}, ${times.template.url}`);
      const doc = readFileSync(README, "utf8");
      if (!doc.includes(buttonLine(published.code))) log(`\ndeploy/README.md: replace the line after\n  ${BUTTON_MARK}\nwith\n  ${buttonLine(published.code)}\n`);
    }
  } catch (error) {
    step.fail("stopped", error.message);
  }
  return step.all;
}

/** A stand-in for Railway, for --dry-run and the test: each call logged (its variables cut to a line, the deploy's config
 *  never), answered as a first run in an empty workspace would be, and a deploy whose server answers as a fresh AgentRun
 *  server does. No network. */
export function planClient({ log, workspaceId, workspaceName = "<workspace>" }) {
  const calls = [];
  const config = loadTemplate();
  const { key } = onlyService(config);
  const domain = "agentrun-production-0000.up.railway.app";
  const env = renderVariables(onlyService(config).service, { domain });
  const generated = { ...config, services: { "<template service id>": { ...config.services[key], volumeMounts: { "<template service id>": Object.values(config.services[key].volumeMounts)[0] } } } };
  const node = (id, name) => ({ edges: [{ node: { id, name } }] });
  const workspace = { id: workspaceId, name: workspaceName };
  const answers = {
    Workspace: () => ({ workspace }),
    Projects: () => ({ projects: { edges: [] } }),
    ProjectCreate: () => ({ projectCreate: { id: "<source project>", name: SOURCE_PROJECT, workspace, environments: node("<source environment>", "production") } }),
    ServiceCreate: () => ({ serviceCreate: { id: "<source service>", name: "AgentRun" } }),
    VolumeCreate: () => ({ volumeCreate: { id: "<source volume>", name: "agentrun-volume" } }),
    ServiceDomainCreate: () => ({ serviceDomainCreate: { id: "<source domain>", domain: "agentrun-template-source.up.railway.app", targetPort: 7340 } }),
    EnvironmentConfig: () => ({ environment: { id: "<source environment>", config: { services: {} } } }),
    EnvironmentPatchCommit: () => ({ environmentPatchCommit: "<patch>" }),
    WorkspaceTemplates: () => ({ workspaceTemplates: { edges: [] } }),
    TemplateGenerate: () => ({ templateGenerate: { id: "<template>", name: SOURCE_PROJECT, code: "<code>", status: "UNPUBLISHED", serializedConfig: generated } }),
    Template: (v) => ({ template: { id: "<template>", code: v.code, status: "PUBLISHED", serializedConfig: generated } }),
    TemplateDeploy: () => ({ templateDeployV2: { projectId: "<walk project>", workflowId: "<workflow>" } }),
    ProjectRename: (v) => ({ projectUpdate: { id: v.id, name: v.name } }),
    WorkflowStatus: () => ({ workflowStatus: { status: "Complete", error: null } }),
    Project: () => (calls.some((c) => c.op === "ProjectDelete") ? Promise.reject(new Error("Project not found")) : { project: { id: "<walk project>", name: WALK_PROJECT, deletedAt: null, workspace, environments: node("<walk environment>", "production"), services: node("<walk service>", "AgentRun") } }),
    Deployments: () => ({ deployments: { edges: [{ node: { id: "<deployment>", status: "SUCCESS", createdAt: "<time>" } }] } }),
    Domains: () => ({ domains: { serviceDomains: [{ domain, targetPort: 7340 }] } }),
    Variables: () => ({ variables: env }),
    BuildLogs: () => ({ buildLogs: [{ message: "Healthcheck failed!", timestamp: "<time>" }] }),
    DeploymentLogs: () => ({ deploymentLogs: [{ message: `Set up this server: https://${domain}/setup#code=${"x".repeat(22)} (or paste AGENTRUN_TOKEN)`, timestamp: "<time>" }] }),
    Metrics: ({ startDate }, t = Date.parse(startDate) / 1000) => ({ metrics: [{ measurement: "CPU_USAGE", values: [{ ts: t, value: 0.1 }, { ts: t + 60, value: 0.05 }] }, { measurement: "MEMORY_USAGE_GB", values: [{ ts: t, value: 0.2 }, { ts: t + 60, value: 0.3 }] }] }),
    Usage: () => ({ usage: [{ measurement: "CPU_USAGE", value: 0.5 }, { measurement: "MEMORY_USAGE_GB", value: 3 }, { measurement: "DISK_USAGE_GB", value: 2 }, { measurement: "NETWORK_TX_GB", value: 0.001 }] }),
    TemplatePublish: () => ({ templatePublish: { id: "<template>", code: "<code>", status: "PUBLISHED" } }),
    ProjectDelete: () => ({ projectDelete: true }),
    TemplateDelete: () => ({ templateDelete: true }),
  };
  const json = (status, body, headers = {}) => answer(status, { "content-type": ["application/json"], ...headers }, typeof body === "string" ? body : JSON.stringify(body));
  return {
    calls,
    async call(op, variables) {
      calls.push({ op, variables });
      const shown = JSON.stringify(variables, (k, v) => (k === "serializedConfig" ? "<the template's config>" : v));
      log(`  → ${op} ${shown.length > 240 ? `${shown.slice(0, 237)}...` : shown}`);
      return answers[op](variables);
    },
    async http(url, init = {}) {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      calls.push({ op: `${method} ${path}`, headers: init.headers, body: init.body });
      log(`  → ${method} ${url}`);
      if (path === "/v2/health") return json(200, { status: "ok", checks: { store: "ok", disk: "ok" } });
      if (path === "/") return answer(200, { "content-type": ["text/html; charset=utf-8"] }, "<!doctype html>");
      if (path === "/v2/auth/session") return json(200, { accounts: true, password_set: false, signed_in: false, setup_code: true });
      if (path === "/v2/setup") return json(201, { signed_in: true }, { "set-cookie": ["agentrun_session=<session>; Path=/; HttpOnly; Secure; SameSite=Strict"] });
      if (path === "/v2/settings/tool-keys/openrouter" && method === "PUT") return answer(init.headers?.cookie === "agentrun_session=<session>" ? 204 : 401, {}, "");
      if (path === "/v2/agents" && method === "POST") return json(201, { agent_id: "<agent>" });
      if (/^\/v2\/agents\/[^/]+\/runs$/.test(path) && method === "POST") return json(201, { run_id: "<run>" });
      if (path.startsWith("/v2/runs/")) return json(200, { run_id: "<run>", status: "completed", cost: { usd: 0.0004 }, result: { content: "# Release notes\n- Runs page: export runs as CSV." } });
      return json(404, { error: { code: "not_found" } });
    },
    sleep: async () => {},
  };
}

/** The report, as deploy/walk's: a Verdict line, then the rows as a table. */
export function report(all) {
  const verdict = all.length && all.every((r) => r[1] === "PASS") ? "PASS" : "FAIL";
  return [`Verdict: ${verdict}`, "", "| step | result | evidence |", "| --- | --- | --- |", ...all.map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)].join("\n");
}

/** NAME=VALUE lines (stdin's, with --secrets-stdin), as an object. */
export const secretLines = (text) => Object.fromEntries(text.split("\n").map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.replace(/\r$/, ""))).filter(Boolean).map((m) => [m[1], m[2]]));

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const usage = "usage: publish-and-walk.sh WORKSPACE_ID [--expect-workspace NAME] [--walk [CODE] | --template CODE] [--first-run [--model ID]] [--secrets-stdin] | --dry-run [WORKSPACE_ID] | --check-api";
  const log = (line) => console.error(line);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv.splice(i, 2)[1] ?? "";
  };
  const has = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv.splice(i, 1).length === 1;
  };
  if (argv[0] === "--check-api") {
    log(`Every operation against ${API}, with no token:`);
    return (await checkApi(liveClient({}), log)) ? 1 : 0;
  }
  // --walk CODE, or --walk alone: the template the README's button deploys.
  const walkAt = argv.indexOf("--walk");
  const walkGiven = walkAt >= 0 && argv[walkAt + 1] !== undefined && !argv[walkAt + 1].startsWith("-");
  const walkCode = walkAt < 0 ? undefined : walkGiven ? argv.splice(walkAt, 2)[1] : (argv.splice(walkAt, 1), buttonCode(readFileSync(README, "utf8")) ?? "");
  const templateCode = flag("--template");
  const expectWorkspace = flag("--expect-workspace");
  const model = flag("--model");
  const firstRun = has("--first-run");
  const fromStdin = has("--secrets-stdin");
  if (argv[0] === "--dry-run") {
    const workspaceId = argv[1] ?? "<workspace id>";
    const client = planClient({ log, workspaceId, workspaceName: expectWorkspace ?? "<workspace>" });
    log("The plan: a first run in a workspace with no template yet, every call in order, against a stand-in for Railway (no network, no token).");
    const all = await run(client, { workspaceId, expectWorkspace, firstRun: { key: "<the model key>", model: model ?? FIRST_RUN.model }, log });
    console.log(report(all));
    return 0;
  }
  const [workspaceId, ...rest] = argv;
  if (!workspaceId || workspaceId.startsWith("-") || rest.length || [walkCode, templateCode, expectWorkspace, model].includes("") || (walkCode && templateCode)) {
    log(usage);
    return 2;
  }
  const secrets = fromStdin ? secretLines(await readStdin()) : {};
  const token = secrets.RAILWAY_API_TOKEN ?? process.env.RAILWAY_API_TOKEN;
  if (!token) {
    log("RAILWAY_API_TOKEN is not set: a token of the workspace (railway.com/account/tokens), from the environment or, with --secrets-stdin, a RAILWAY_API_TOKEN=... line on stdin; never an argument.");
    return 2;
  }
  const key = secrets[FIRST_RUN.keyName] ?? process.env[FIRST_RUN.keyName];
  if (firstRun && !key) {
    log(`--first-run needs ${FIRST_RUN.keyName}, from the environment or a ${FIRST_RUN.keyName}=... line on stdin with --secrets-stdin.`);
    return 2;
  }
  log(`Every operation against ${API}, with no token:`);
  if (await checkApi(liveClient({}), log)) {
    log("Railway's API refuses an operation above: fix OPS before a run.");
    return 1;
  }
  const mode = walkCode ? "walk" : templateCode ? "template" : "publish";
  const times = {};
  const all = await run(liveClient({ token }), { workspaceId, mode, code: walkCode ?? templateCode, expectWorkspace, firstRun: firstRun ? { key, model: model ?? FIRST_RUN.model } : undefined, times, log });
  const text = report(all);
  console.log(text);
  if (process.env.REPORT) writeFileSync(process.env.REPORT, `${text}\n`);
  const { result, ...facts } = times;
  if (process.env.TIMES) writeFileSync(process.env.TIMES, `${JSON.stringify({ ...facts, result }, null, 2)}\n`);
  return all.every((r) => r[1] === "PASS") ? 0 : 1;
}

if (isMain(import.meta)) process.exitCode = await main(process.argv.slice(2));
