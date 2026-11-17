// Publishes deploy/railway/template.json as AgentRun's Railway template and walks it: one deploy of the template into a
// throwaway project, its health, its first visit asking for the setup code, the token made for it working as that code,
// then the project deleted. Run through publish-and-walk.sh, which says how; this file is its body.
//
// Railway's public API makes a template only from a project (templateGenerate) and changes none of a template's services
// once made, so the template is generated from a source project in the workspace, agentrun-template-source, kept in step
// with template.json and never deployed (each change is committed with skipDeploys). A template whose deploy would differ
// from template.json in anything (image, start command, health check, variables, domain port, volume) stops the run
// before any deploy, saying where. A template made by hand in Railway's template editor is walked and published with
// --template CODE.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { differences, loadTemplate, onlyService, renderVariables } from "./template.mjs";

export const API = "https://backboard.railway.com/graphql/v2";
export const SOURCE_PROJECT = "agentrun-template-source";
export const WALK_PROJECT = "agentrun-template-walk";
const README = new URL("../README.md", import.meta.url);
const OVERVIEW = new URL("./overview.md", import.meta.url);
const PUBLISH = { category: "AI/ML", description: "Deploy and host AgentRun, an open-source platform for running agents, on Railway" };

// Every operation this script sends, each checked against Railway's live schema by --check-api.
export const OPS = {
  Workspace: `query Workspace($id: String!) { workspace(workspaceId: $id) { id name } }`,
  Projects: `query Projects($workspaceId: String!) { projects(workspaceId: $workspaceId, first: 100) { edges { node { id name createdAt environments { edges { node { id name } } } services { edges { node { id name } } } } } } }`,
  ProjectCreate: `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }`,
  ServiceCreate: `mutation ServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
  VolumeCreate: `mutation VolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
  ServiceDomainCreate: `mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain targetPort } }`,
  EnvironmentConfig: `query EnvironmentConfig($id: String!) { environment(id: $id) { id config } }`,
  EnvironmentPatchCommit: `mutation EnvironmentPatchCommit($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: true) }`,
  TemplateSource: `query TemplateSource($projectId: String!) { templateSourceForProject(projectId: $projectId) { id code status serializedConfig } }`,
  TemplateGenerate: `mutation TemplateGenerate($projectId: String!, $environmentId: String) { templateGenerate(input: { projectId: $projectId, environmentId: $environmentId }) { id code status serializedConfig } }`,
  Template: `query Template($code: String!) { template(code: $code) { id code status serializedConfig } }`,
  TemplateDeploy: `mutation TemplateDeploy($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }`,
  ProjectRename: `mutation ProjectRename($id: String!, $name: String!) { projectUpdate(id: $id, input: { name: $name }) { id name } }`,
  WorkflowStatus: `query WorkflowStatus($id: String!) { workflowStatus(workflowId: $id) { status error } }`,
  Project: `query Project($id: String!) { project(id: $id) { id name deletedAt environments { edges { node { id name } } } services { edges { node { id name } } } } }`,
  Deployments: `query Deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt } } } }`,
  Domains: `query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain targetPort } } }`,
  Variables: `query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
  DeploymentLogs: `query DeploymentLogs($id: String!, $filter: String) { deploymentLogs(deploymentId: $id, filter: $filter, limit: 200) { message timestamp } }`,
  TemplatePublish: `mutation TemplatePublish($id: String!, $input: TemplatePublishInput!) { templatePublish(id: $id, input: $input) { id code status } }`,
  ProjectDelete: `mutation ProjectDelete($id: String!) { projectDelete(id: $id) }`,
};

/** The README's Railway button: the one line after the mark. Until the template is published it is the placeholder, the
 *  button commented out, so no one clicks a link to a template that does not exist. */
export const BUTTON_MARK = "<!-- railway-button: publish-and-walk.sh prints this line's replacement once the template is published -->";
export const buttonLine = (code) => `[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/${code}?utm_medium=integration&utm_source=button&utm_campaign=agentrun)`;
export const BUTTON_PLACEHOLDER = `<!-- ${buttonLine("TEMPLATE_CODE")} -->`;

/** A GraphQL call's errors, as one Error naming the operation. */
class Refused extends Error {
  constructor(op, errors) {
    super(`${op}: ${errors.map((e) => `${e.message}${e.extensions?.code ? ` (${e.extensions.code})` : ""}`).join("; ")}`);
    this.errors = errors;
  }
}

/** Railway's API, for real: each operation by name, with the token (never printed) unless `anonymous`. */
export function liveClient({ token, api = API }) {
  return {
    async call(op, variables, { anonymous = false } = {}) {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json", ...(anonymous ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ query: OPS[op], variables, operationName: op }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}, not JSON` }] }));
      if (body.errors?.length) throw new Refused(op, body.errors);
      return body.data;
    },
    http: (url, init = {}) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init }),
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
    TemplateSource: { projectId: id }, TemplateGenerate: { projectId: id, environmentId: id },
    Template: { code: "agentrun-check-api" },
    TemplateDeploy: { input: { templateId: id, serializedConfig: config, workspaceId: id } },
    ProjectRename: { id, name: WALK_PROJECT }, WorkflowStatus: { id }, Project: { id },
    Deployments: { input: { projectId: id, environmentId: id, serviceId: id } },
    Domains: { projectId: id, environmentId: id, serviceId: id }, Variables: { projectId: id, environmentId: id, serviceId: id },
    DeploymentLogs: { id, filter: "Set up this server" },
    TemplatePublish: { id, input: { ...PUBLISH, readme: "check", workspaceId: id } },
    ProjectDelete: { id },
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

/** Waits for `check` to return a value (not undefined), asking every `everyMs`, for at most `forMs`; else throws `what`. */
async function until(client, what, forMs, everyMs, check) {
  const end = Date.now() + forMs;
  for (;;) {
    const got = await check();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`${what}: not within ${Math.round(forMs / 1000)} s`);
    await client.sleep(everyMs);
  }
}

/** The walk's report rows, `step | PASS or FAIL | evidence`, as deploy/walk's are. */
function rows(log) {
  const all = [];
  return {
    all,
    pass: (step, evidence) => (all.push([step, "PASS", evidence]), log(`${step} | PASS | ${evidence}`)),
    fail: (step, evidence) => (all.push([step, "FAIL", evidence]), log(`${step} | FAIL | ${evidence}`)),
  };
}

/** The template brought in step with template.json: the source project made or updated, the template generated from it
 *  when the one it has differs (or there is none), and that template checked against template.json. */
async function ensureTemplate(client, { workspaceId, config, step }) {
  const { service } = onlyService(config);
  const projects = edges((await client.call("Projects", { workspaceId })).projects);
  let source = projects.find((p) => p.name === SOURCE_PROJECT);
  let environmentId, serviceId;
  if (!source) {
    const made = (await client.call("ProjectCreate", { input: { name: SOURCE_PROJECT, workspaceId, description: "The source of AgentRun's Railway template (deploy/railway/template.json). Never deployed." } })).projectCreate;
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

  const had = (await client.call("TemplateSource", { projectId: source.id })).templateSourceForProject;
  if (had && differences(config, had.serializedConfig).length === 0) {
    step.pass("template", `${had.code} (${had.id}) already deploys what template.json says`);
    return had;
  }
  const made = (await client.call("TemplateGenerate", { projectId: source.id, environmentId })).templateGenerate;
  const moved = had && had.id !== made.id ? `; it replaces ${had.code}, whose button must move to the new code` : "";
  step.pass("template generated", `${made.code} (${made.id}) from ${SOURCE_PROJECT}${moved}`);
  return made;
}

/** One deploy of the template into a throwaway project, checked as a person who clicks the button meets it, then deleted. */
async function walk(client, { workspaceId, template, step }) {
  const { service } = onlyService(template.serializedConfig);
  let projectId;
  try {
    const deployed = (await client.call("TemplateDeploy", { input: { templateId: template.id, serializedConfig: template.serializedConfig, workspaceId } })).templateDeployV2;
    projectId = deployed.projectId;
    await client.call("ProjectRename", { id: projectId, name: `${WALK_PROJECT}-${Date.now()}` });
    step.pass("template deployed", `into a new project ${projectId}`);
    if (deployed.workflowId) {
      await until(client, "the template's deploy workflow completed", 10 * 60_000, 5_000, async () => {
        const s = (await client.call("WorkflowStatus", { id: deployed.workflowId })).workflowStatus;
        if (s.status === "Error") throw new Error(`the template's deploy workflow failed: ${s.error}`);
        return s.status === "Complete" ? s : undefined;
      });
    }
    const project = (await client.call("Project", { id: projectId })).project;
    const environmentId = edges(project.environments)[0]?.id;
    const serviceId = edges(project.services).find((s) => s.name === service.name)?.id;
    if (!environmentId || !serviceId) throw new Error(`the walk's project has no service named ${service.name}`);
    const deployment = await until(client, "the service's deploy succeeded", 20 * 60_000, 10_000, async () => {
      const d = edges((await client.call("Deployments", { input: { projectId, environmentId, serviceId } })).deployments)[0];
      if (d && ["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(d.status)) throw new Error(`the service's deploy ended ${d.status} (deployment ${d.id})`);
      return d?.status === "SUCCESS" ? d : undefined;
    });
    step.pass("deploy succeeded", `deployment ${deployment.id}: SUCCESS, after Railway's health check on ${service.deploy.healthcheckPath}`);

    const domain = (await client.call("Domains", { projectId, environmentId, serviceId })).domains.serviceDomains[0];
    if (!domain) throw new Error("the service has no Railway domain");
    const base = `https://${domain.domain}`;
    step.pass("public domain", `${base}, to port ${domain.targetPort}`);

    // Read, never printed: whether the template made the token and the seal key, and in what shape.
    const vars = (await client.call("Variables", { projectId, environmentId, serviceId })).variables;
    const made = [/^[0-9a-f]{64}$/.test(vars.AGENTRUN_TOKEN ?? ""), /^[A-Za-z0-9+/]{43}=$/.test(vars.AGENTRUN_SEAL_KEY ?? ""), vars.AGENTRUN_PUBLIC_URL === base];
    if (made.includes(false)) throw new Error(`the deploy's variables are not as made by the template: AGENTRUN_TOKEN 64 hex ${made[0]}, AGENTRUN_SEAL_KEY 32 bytes in base64 ${made[1]}, AGENTRUN_PUBLIC_URL ${base} ${made[2]}`);
    step.pass("token and seal key made", "AGENTRUN_TOKEN: 64 hex characters; AGENTRUN_SEAL_KEY: 32 bytes in base64; AGENTRUN_PUBLIC_URL: the domain (values not shown)");

    const health = await until(client, `${base}/v2/health answered 200`, 5 * 60_000, 5_000, async () => {
      const r = await client.http(`${base}/v2/health`).catch(() => undefined);
      return r?.status === 200 ? r.json() : undefined;
    });
    step.pass("healthy", `GET ${base}/v2/health: 200 ${JSON.stringify(health)}`);

    const page = await client.http(`${base}/`, { headers: { accept: "text/html" } });
    if (page.status !== 200 || !/text\/html/.test(page.headers.get("content-type") ?? "")) throw new Error(`GET ${base}/ answered ${page.status} ${page.headers.get("content-type")}, not the console`);
    const session = await (await client.http(`${base}/v2/auth/session`)).json();
    if (!(session.accounts === true && session.password_set === false && session.setup_code === true)) throw new Error(`the first visit's session read is ${JSON.stringify(session)}, not one that asks for the setup code`);
    step.pass("first visit asks for the setup code", `GET / is the console; GET /v2/auth/session: ${JSON.stringify(session)}`);

    const line = await until(client, "the setup line in the deploy's log", 3 * 60_000, 10_000, async () => {
      const logs = (await client.call("DeploymentLogs", { id: deployment.id, filter: "Set up this server" })).deploymentLogs;
      return logs.map((l) => l.message).find((m) => m.startsWith(`Set up this server: ${base}/setup#code=`));
    });
    step.pass("setup link at the domain", `the log's line starts "Set up this server: ${base}/setup#code=" (the code not shown) and is ${line.length} characters`);

    const setup = await client.http(`${base}/v2/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ code: vars.AGENTRUN_TOKEN, password: randomBytes(18).toString("base64url") }),
    });
    const answer = await setup.json().catch(() => ({}));
    if (setup.status !== 201 || answer.signed_in !== true) throw new Error(`POST /v2/setup with AGENTRUN_TOKEN as the code answered ${setup.status} ${JSON.stringify(answer)}`);
    step.pass("token works as the setup code", `POST ${base}/v2/setup with AGENTRUN_TOKEN as the code: 201, signed in`);
  } finally {
    if (projectId) {
      try {
        await client.call("ProjectDelete", { id: projectId });
        const gone = await client.call("Project", { id: projectId }).then((d) => Boolean(d.project.deletedAt), () => true);
        if (gone) step.pass("throwaway project deleted", projectId);
        else step.fail("throwaway project deleted", `${projectId} still reads as live: delete it in the dashboard`);
      } catch (error) {
        step.fail("throwaway project deleted", `${projectId}: ${error.message}; delete it in the dashboard`);
      }
    }
  }
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
 *  the editor, walked and published). Returns the report's rows. */
export async function run(client, { workspaceId, mode = "publish", code, log = console.error }) {
  const step = rows(log);
  const config = loadTemplate();
  try {
    const ws = (await client.call("Workspace", { id: workspaceId })).workspace;
    step.pass("workspace", `${ws.name} (${ws.id})`);
    await sweep(client, { workspaceId, step });
    let template;
    if (mode === "publish") template = await ensureTemplate(client, { workspaceId, config, step });
    else {
      template = (await client.call("Template", { code })).template;
      step.pass("template found", `${template.code} (${template.id}), ${template.status}`);
    }
    const off = differences(config, template.serializedConfig);
    if (off.length) throw new Error(`template ${template.code} would deploy something other than deploy/railway/template.json:\n  ${off.join("\n  ")}\nRailway's API can't change a template's services: make them match in the template editor (railway.com/workspace/templates), then run again with --template ${template.code}`);
    step.pass("template is template.json", `${template.code}: image, start command, health check, variables, domain port and volume as the repository has them`);
    await walk(client, { workspaceId, template, step });
    if (mode !== "walk" && !step.all.some((r) => r[1] === "FAIL")) {
      const readme = readFileSync(OVERVIEW, "utf8");
      const published = (await client.call("TemplatePublish", { id: template.id, input: { ...PUBLISH, readme, workspaceId } })).templatePublish;
      step.pass("published", `${published.code}: ${published.status}, https://railway.com/deploy/${published.code}`);
      const doc = readFileSync(README, "utf8");
      if (!doc.includes(buttonLine(published.code))) log(`\ndeploy/README.md: replace the line after\n  ${BUTTON_MARK}\nwith\n  ${buttonLine(published.code)}\n`);
    }
  } catch (error) {
    step.fail("stopped", error.message);
  }
  return step.all;
}

/** A stand-in for Railway, for --dry-run and the test: each call logged (its variables cut to a line), answered as a first
 *  run in an empty workspace would be, and a deploy whose server answers as a fresh AgentRun server does. No network. */
export function planClient({ log, workspaceId }) {
  const calls = [];
  const config = loadTemplate();
  const { key } = onlyService(config);
  const domain = "agentrun-production-0000.up.railway.app";
  const env = renderVariables(onlyService(config).service, { domain });
  const generated = { ...config, services: { "<template service id>": { ...config.services[key], volumeMounts: { "<template service id>": Object.values(config.services[key].volumeMounts)[0] } } } };
  const node = (id, name) => ({ edges: [{ node: { id, name } }] });
  const answers = {
    Workspace: () => ({ workspace: { id: workspaceId, name: "<workspace>" } }),
    Projects: () => ({ projects: { edges: [] } }),
    ProjectCreate: () => ({ projectCreate: { id: "<source project>", name: SOURCE_PROJECT, environments: node("<source environment>", "production") } }),
    ServiceCreate: () => ({ serviceCreate: { id: "<source service>", name: "AgentRun" } }),
    VolumeCreate: () => ({ volumeCreate: { id: "<source volume>", name: "agentrun-volume" } }),
    ServiceDomainCreate: () => ({ serviceDomainCreate: { id: "<source domain>", domain: "agentrun-template-source.up.railway.app", targetPort: 7340 } }),
    EnvironmentConfig: () => ({ environment: { id: "<source environment>", config: { services: {} } } }),
    EnvironmentPatchCommit: () => ({ environmentPatchCommit: "<patch>" }),
    TemplateSource: () => ({ templateSourceForProject: null }),
    TemplateGenerate: () => ({ templateGenerate: { id: "<template>", code: "<code>", status: "UNPUBLISHED", serializedConfig: generated } }),
    Template: (v) => ({ template: { id: "<template>", code: v.code, status: "PUBLISHED", serializedConfig: generated } }),
    TemplateDeploy: () => ({ templateDeployV2: { projectId: "<walk project>", workflowId: "<workflow>" } }),
    ProjectRename: (v) => ({ projectUpdate: { id: v.id, name: v.name } }),
    WorkflowStatus: () => ({ workflowStatus: { status: "Complete", error: null } }),
    Project: () => (calls.some((c) => c.op === "ProjectDelete") ? Promise.reject(new Error("Project not found")) : { project: { id: "<walk project>", name: WALK_PROJECT, deletedAt: null, environments: node("<walk environment>", "production"), services: node("<walk service>", "AgentRun") } }),
    Deployments: () => ({ deployments: { edges: [{ node: { id: "<deployment>", status: "SUCCESS", createdAt: "<time>" } }] } }),
    Domains: () => ({ domains: { serviceDomains: [{ domain, targetPort: 7340 }] } }),
    Variables: () => ({ variables: env }),
    DeploymentLogs: () => ({ deploymentLogs: [{ message: `Set up this server: https://${domain}/setup#code=${"x".repeat(22)} (or paste AGENTRUN_TOKEN)`, timestamp: "<time>" }] }),
    TemplatePublish: () => ({ templatePublish: { id: "<template>", code: "<code>", status: "PUBLISHED" } }),
    ProjectDelete: () => ({ projectDelete: true }),
  };
  const json = (status, body, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
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
      calls.push({ op: `${init.method ?? "GET"} ${path}` });
      log(`  → ${init.method ?? "GET"} ${url}`);
      if (path === "/v2/health") return json(200, { status: "ok", checks: { store: "ok", disk: "ok" } });
      if (path === "/") return json(200, "<!doctype html>", "text/html; charset=utf-8");
      if (path === "/v2/auth/session") return json(200, { accounts: true, password_set: false, signed_in: false, setup_code: true });
      if (path === "/v2/setup") return json(201, { signed_in: true });
      return json(404, { error: "not_found" });
    },
    sleep: async () => {},
  };
}

/** The report, as deploy/walk's: a Verdict line, then the rows as a table. */
export function report(all) {
  const verdict = all.length && all.every((r) => r[1] === "PASS") ? "PASS" : "FAIL";
  return [`Verdict: ${verdict}`, "", "| step | result | evidence |", "| --- | --- | --- |", ...all.map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)].join("\n");
}

async function main(argv) {
  const usage = "usage: publish-and-walk.sh WORKSPACE_ID [--walk CODE | --template CODE] | --dry-run [WORKSPACE_ID] | --check-api";
  const log = (line) => console.error(line);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv.splice(i, 2)[1] ?? "";
  };
  if (argv[0] === "--check-api") {
    log(`Every operation against ${API}, with no token:`);
    return (await checkApi(liveClient({}), log)) ? 1 : 0;
  }
  if (argv[0] === "--dry-run") {
    const client = planClient({ log, workspaceId: argv[1] ?? "<workspace id>" });
    log("The plan: a first run in a workspace with no template yet, every call in order, against a stand-in for Railway (no network, no token).");
    const all = await run(client, { workspaceId: argv[1] ?? "<workspace id>", log });
    console.log(report(all));
    return 0;
  }
  const walkCode = flag("--walk");
  const templateCode = flag("--template");
  const [workspaceId, ...rest] = argv;
  if (!workspaceId || workspaceId.startsWith("-") || rest.length || walkCode === "" || templateCode === "" || (walkCode && templateCode)) {
    log(usage);
    return 2;
  }
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    log("RAILWAY_API_TOKEN is not set: an account or workspace token of the workspace (railway.com/account/tokens), from the environment, never an argument.");
    return 2;
  }
  log(`Every operation against ${API}, with no token:`);
  if (await checkApi(liveClient({}), log)) {
    log("Railway's API refuses an operation above: fix OPS before a run.");
    return 1;
  }
  const mode = walkCode ? "walk" : templateCode ? "template" : "publish";
  const all = await run(liveClient({ token }), { workspaceId, mode, code: walkCode ?? templateCode, log });
  const text = report(all);
  console.log(text);
  if (process.env.REPORT) (await import("node:fs")).writeFileSync(process.env.REPORT, `${text}\n`);
  return all.every((r) => r[1] === "PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
