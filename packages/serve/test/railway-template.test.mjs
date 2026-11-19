// The Railway template (deploy/railway/template.json) and its publish-and-walk script, with no Railway account: the
// template runs the image the release publishes the way the image runs itself, its generated token and seal key are
// ones this server takes, and the script's whole run, against a stand-in for Railway, deploys the template it checked,
// deletes its throwaway project whatever happens, and publishes only after a walk that passed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { tokenProblem } from "../dist/api-token.js";
import { sealKeyOf } from "../dist/tool-keys.js";

const ROOT = new URL("../../../", import.meta.url);
const { differences, loadTemplate, onlyService, renderValue, renderVariables, startArgv } = await import(new URL("deploy/railway/template.mjs", ROOT));
const { BUTTON_MARK, BUTTON_PLACEHOLDER, FIRST_RUN, PRICE_PER_MINUTE, PUBLISH, WALK_MAX_MS, buttonLine, curlArgs, curlConfig, formValues, planClient, run, sourcePatch, usageOf } = await import(new URL("deploy/railway/publish-and-walk.mjs", ROOT));
const { dockerRunArgs } = await import(new URL("deploy/railway/local-walk.mjs", ROOT));
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const { service } = onlyService(loadTemplate());
const quiet = () => {};

test("the template runs the image the release tags beta, from the repository render.yaml pins a release of", async () => {
  const [repo, tag] = service.source.image.split(/:(?=[^:]+$)/);
  const render = /^\s+url: (\S+):(v\S+)$/m.exec(await read("render.yaml"));
  assert.equal(repo, render[1]);
  assert.equal(tag, "beta");
  // release.yml's image-release job moves :beta to each release it tags; Railway can't change a published template's
  // image, so the template follows the release by its moving tag rather than a pinned one.
  assert.match(await read(".github/workflows/release.yml"), /imagetools create --tag "\$IMAGE:\$RELEASE_TAG" --tag "\$IMAGE:beta"/);
});

test("render.yaml and the Helm chart pin this release's image (the tag a release bumps)", async () => {
  const { version } = JSON.parse(await read("packages/serve/package.json"));
  assert.match(await read("render.yaml"), new RegExp(`^ {6}url: ghcr\\.io/parcha-ai/agentrun-server:v${version.replace(/\./g, "\\.")}$`, "m"));
  // The chart's image is v<appVersion> (deploy/helm/agentrun/templates/_helpers.tpl), and its version moves with it.
  const chart = await read("deploy/helm/agentrun/Chart.yaml");
  assert.equal(/^version: (\S+)$/m.exec(chart)?.[1], version);
  assert.equal(/^appVersion: "(\S+)"$/m.exec(chart)?.[1], version);
  assert.match(await read("deploy/helm/agentrun/values.yaml"), /^  repository: ghcr\.io\/parcha-ai\/agentrun-server\n  # .*\n  tag: ""$/m);
});

test("the start command is the image's own entrypoint and command, as the image's user, once the volume is that user's", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const entrypoint = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(dockerfile)[1]);
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)[1]);
  assert.match(dockerfile, /useradd --uid 1000 --gid node .* node$/m);
  assert.match(dockerfile, /^USER node$/m);
  const [sh, c, script, ...rest] = startArgv(service.deploy.startCommand);
  assert.deepEqual([sh, c, rest], ["/bin/sh", "-c", []]);
  const mount = Object.values(service.volumeMounts)[0].mountPath;
  // Railway's volume is a disk with a lost+found (root's, mode 700): it is given to the server's user too, so an image
  // whose server can't look into it (released before the store's scan let it be) starts. `-h`: the server's user owns
  // the volume and could make lost+found a link to /etc, which root must not then follow. 711, as the image's /data: a
  // run's process, a uid of its own, crosses it to its own folders without listing it.
  assert.equal(script, `chown 1000:1000 ${mount} && chmod 711 ${mount} &&{ [ ! -d ${mount}/lost+found ] || chown -h 1000:1000 ${mount}/lost+found; } && exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/node ${[...entrypoint, ...cmd].join(" ")}`);
  // Railway mounts a volume as root: the container starts as root (RAILWAY_RUN_UID=0) only for the chown above.
  assert.equal(renderValue(service.variables.RAILWAY_RUN_UID.defaultValue, { domain: "x" }), "0");
  assert.ok(cmd.includes(mount) && cmd[cmd.indexOf("--data") + 1] === mount, "the server's data directory is the volume");
});

test("the volume, the health check, and one port for the domain, the health check and the server", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const port = Number(/^EXPOSE (\d+)$/m.exec(dockerfile)[1]);
  const argv = startArgv(service.deploy.startCommand)[2].split(" ");
  assert.deepEqual(Object.values(service.volumeMounts).map((m) => m.mountPath), ["/data"]);
  assert.equal(service.deploy.healthcheckPath, /healthCheckPath: (\S+)/.exec(await read("render.yaml"))[1]);
  assert.deepEqual([Number(renderValue(service.variables.PORT.defaultValue, { domain: "x" })), Number(argv[argv.indexOf("--port") + 1]), ...Object.values(service.networking.serviceDomains).map((d) => d.port)], [port, port, port]);
});

test("the template holds only what Railway's templateGenerate keeps: no deploy setting it drops, and every fixed value made by an expression", () => {
  // Seen in a template generated from the source project: startCommand, healthcheckPath and the restart policy are kept;
  // healthcheckTimeout, drainingSeconds and requiredMountPath are dropped; a variable's plain value comes out empty and
  // isOptional false, while a value with a ${{...}} expression in it is kept whole.
  assert.deepEqual(Object.keys(service.deploy).sort(), ["healthcheckPath", "restartPolicyMaxRetries", "restartPolicyType", "startCommand"]);
  for (const [name, v] of Object.entries(service.variables)) {
    assert.match(v.defaultValue, /\$\{\{.+\}\}/, `${name} is made by an expression`);
    assert.equal(v.isOptional, undefined, name);
  }
  // A one-character secret over a one-character alphabet is a constant.
  for (let i = 0; i < 20; i++) assert.deepEqual([renderValue(service.variables.PORT.defaultValue, { domain: "x" }), renderValue(service.variables.RAILWAY_RUN_UID.defaultValue, { domain: "x" })], ["7340", "0"]);
});

test("each deploy generates a token and a seal key this server takes, with 256 bits or more each, and the public URL at its domain", () => {
  for (let i = 0; i < 500; i++) {
    const env = renderVariables(service, { domain: "agentrun-production-ab12.up.railway.app" });
    assert.equal(tokenProblem(env.AGENTRUN_TOKEN), undefined);
    assert.equal(sealKeyOf(env.AGENTRUN_SEAL_KEY)?.length, 32, env.AGENTRUN_SEAL_KEY.length);
    assert.equal(env.AGENTRUN_PUBLIC_URL, "https://agentrun-production-ab12.up.railway.app");
    assert.deepEqual([env.PORT, env.RAILWAY_RUN_UID, env.AGENTRUN_RUN_USER], ["7340", "0", "same"]);
  }
  const bits = (v) => {
    const [, n, alphabet] = /secret\((\d+), "([^"]+)"\)/.exec(v.defaultValue);
    return Number(n) * Math.log2(alphabet.length);
  };
  assert.ok(bits(service.variables.AGENTRUN_TOKEN) >= 256 && bits(service.variables.AGENTRUN_SEAL_KEY) >= 256);
  assert.throws(() => renderValue("${{Postgres.DATABASE_URL}}", { domain: "x" }), /does not know/);
});

test("every variable says what it is for, and the deploy form asks nothing: no model key, so no blank field to fill", () => {
  for (const [name, v] of Object.entries(service.variables)) assert.ok(v.description?.length > 20, `${name} has a description`);
  assert.deepEqual(Object.keys(service.variables).filter((n) => /_API_KEY$/.test(n)), []);
});

test("the deploy settings are railway.json's (railway.com/railway.schema.json, deploy): the same names and types", () => {
  const schema = { startCommand: "string", healthcheckPath: "string", restartPolicyType: "string", restartPolicyMaxRetries: "number" };
  for (const [k, v] of Object.entries(service.deploy)) assert.equal(typeof v, schema[k], k);
});

test("two configs differ only in what a deploy does, never in Railway's ids, and a made secret is never shown", () => {
  const config = loadTemplate();
  const railways = { services: { "a5b0b1f4-0000-4000-8000-000000000000": { ...service, icon: "x", volumeMounts: { "a5b0b1f4-0000-4000-8000-000000000000": { mountPath: "/data" } }, networking: { serviceDomains: { "<hasDomain>:7340": { port: 7340 } } } } } };
  assert.deepEqual(differences(config, railways), []);
  const moved = structuredClone(railways);
  const s = Object.values(moved.services)[0];
  s.source = { image: "ghcr.io/parcha-ai/agentrun-server:v0.1.0-beta.1" };
  s.variables = { ...s.variables, AGENTRUN_TOKEN: { defaultValue: "f".repeat(64) } };
  const lines = differences(config, moved);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines.join("\n"), /AgentRun\.image: .*:beta.*v0\.1\.0-beta\.1/);
  assert.match(lines.join("\n"), /AgentRun\.variables\.AGENTRUN_TOKEN\.value: the repository's "\$\{\{secret\(64.*Railway's \(a value of 64 characters\)/);
  assert.doesNotMatch(lines.join("\n"), /f{64}/);
});

test("a variable only Railway's template has is shown by its length if its name is a secret's, and a TCP proxy is a difference", () => {
  const config = loadTemplate();
  const extra = structuredClone(config);
  const s = Object.values(extra.services)[0];
  s.variables.PRIVATE_API_KEY = { defaultValue: "sk-" + "a".repeat(40) };
  s.networking.tcpProxies = { 7340: {} };
  const lines = differences(config, extra).join("\n");
  assert.match(lines, /AgentRun\.variables\.PRIVATE_API_KEY\.value: the repository's nothing, Railway's \(a value of 43 characters\)/);
  assert.match(lines, /AgentRun\.tcpProxies: the repository's \[\], Railway's \["7340"\]/);
  assert.doesNotMatch(lines, /a{40}/);
  assert.match(differences(extra, config).join("\n"), /PRIVATE_API_KEY\.value: the repository's \(a value of 43 characters\), Railway's nothing/);
});

test("the source project's patch is the template's service, and removes a variable the template no longer has", () => {
  const patch = sourcePatch(service, "svc", { variables: { OLD: { value: "x" }, PORT: { value: "1" } } });
  const s = patch.services.svc;
  assert.equal(s.variables.OLD, null);
  assert.deepEqual(s.variables.PORT, { value: service.variables.PORT.defaultValue, description: service.variables.PORT.description });
  assert.deepEqual([s.source, s.deploy], [service.source, service.deploy]);
  // The fields of Railway's environment config (the Railway CLI's EnvironmentConfig, src/controllers/config/environment.rs).
  const known = { service: ["source", "networking", "variables", "deploy", "build", "volumeMounts"], variable: ["value", "defaultValue", "description", "isOptional", "isSealed", "generator"] };
  for (const k of Object.keys(s)) assert.ok(known.service.includes(k), k);
  for (const v of Object.values(s.variables).filter(Boolean)) for (const k of Object.keys(v)) assert.ok(known.variable.includes(k), k);
});

test("a first run: the source project made, the template generated and checked, walked, its project deleted, then published", async () => {
  const lines = [];
  const client = planClient({ log: (l) => lines.push(l), workspaceId: "ws" });
  const rows = await run(client, { workspaceId: "ws", log: (l) => lines.push(l) });
  assert.deepEqual(rows.filter((r) => r[1] !== "PASS"), []);
  const ops = client.calls.map((c) => c.op);
  const at = (op) => ops.indexOf(op);
  assert.ok(at("EnvironmentPatchCommit") < at("TemplateGenerate") && at("TemplateGenerate") < at("TemplateDeploy"));
  assert.ok(at("TemplateDeploy") < at("ProjectDelete") && at("ProjectDelete") < at("TemplatePublish"), ops.join(" "));
  assert.ok(at("POST /v2/setup") > at("GET /v2/auth/session"));
  const generated = client.calls.find((c) => c.op === "TemplateDeploy").variables.input;
  assert.equal(generated.templateId, "<template>");
  // The walk deploys the template as its form fills it, plus AGENTRUN_TELEMETRY=0: the walk's server is ours.
  const deployed = structuredClone(generated.serializedConfig);
  const walkVars = Object.values(deployed.services)[0].variables;
  assert.deepEqual(walkVars.AGENTRUN_TELEMETRY, { value: "0" });
  delete walkVars.AGENTRUN_TELEMETRY;
  assert.deepEqual(differences(loadTemplate(), deployed), []);
  assert.equal(Object.values(loadTemplate().services)[0].variables.AGENTRUN_TELEMETRY, undefined, "the template leaves the counts on");
  const env = (await client.call("Variables", {})).variables;
  for (const secret of [env.AGENTRUN_TOKEN, env.AGENTRUN_SEAL_KEY]) assert.ok(!lines.some((l) => l.includes(secret)), "a generated secret was printed");
  assert.ok(lines.some((l) => l.includes(buttonLine("<code>"))), "the README's button line is printed");
});

test("the first run: the model key saved in the console with the setup's session, never in the output or on Railway, and the run finishes before the project is deleted", async () => {
  const lines = [];
  const key = `sk-or-v1-${"k".repeat(40)}`;
  const client = planClient({ log: (l) => lines.push(l), workspaceId: "ws", workspaceName: "Parcha" });
  const times = {};
  const rows = await run(client, { workspaceId: "ws", expectWorkspace: "Parcha", firstRun: { key, model: FIRST_RUN.model }, times, log: (l) => lines.push(l) });
  assert.deepEqual(rows.filter((r) => r[1] !== "PASS"), []);
  assert.ok(!client.calls.some((c) => !c.op.includes("/") && JSON.stringify(c.variables).includes(key)), "the model key went to Railway");
  const saved = client.calls.find((c) => c.op === `PUT /v2/settings/tool-keys/${FIRST_RUN.keyId}`);
  assert.deepEqual([saved.headers.cookie, saved.headers.authorization, JSON.parse(saved.body).values[FIRST_RUN.keyName]], ["agentrun_session=<session>", undefined, key]);
  assert.ok(!lines.some((l) => l.includes(key) || l.includes("<session>")) && !rows.some((r) => r[2].includes(key)), "the model key or the session was printed");
  const agent = JSON.parse(client.calls.find((c) => c.op === "POST /v2/agents").body).definition;
  assert.deepEqual([agent.name, agent.harness, agent.model, agent.tools, agent.place], ["Release notes", "pi", FIRST_RUN.model, [], { mode: "runner" }]);
  assert.equal(JSON.parse(client.calls.find((c) => /^POST \/v2\/agents\/.+\/runs$/.test(c.op)).body).input.content, FIRST_RUN.input);
  const ops = client.calls.map((c) => c.op);
  assert.ok(ops.findIndex((o) => o.startsWith("GET /v2/runs/")) < ops.indexOf("Usage") && ops.indexOf("Usage") < ops.indexOf("ProjectDelete"), ops.join(" "));
  assert.deepEqual([times.workspace, times.runId, times.modelUsd], ["Parcha", "<run>", 0.0004]);
  assert.ok(times.clicked <= times.healthy && times.healthy <= times.finished && times.finished <= times.deleted);
});

test("a workspace template that already deploys template.json is used again, a published one first, and none is generated", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  const generated = (await call("TemplateGenerate", {})).templateGenerate.serializedConfig;
  const other = structuredClone(generated);
  Object.values(other.services)[0].deploy.healthcheckPath = "/";
  const ours = [
    { id: "t-new", name: "AgentRun", code: "new", status: "UNPUBLISHED", createdAt: "2026-11-17T12:00:00Z", serializedConfig: generated },
    { id: "t-pub", name: "AgentRun", code: "pub", status: "PUBLISHED", createdAt: "2026-11-16T12:00:00Z", serializedConfig: generated },
    { id: "t-off", name: "AgentRun", code: "off", status: "PUBLISHED", createdAt: "2026-11-18T12:00:00Z", serializedConfig: other },
  ];
  client.call = async (op, v) => (op === "WorkspaceTemplates" ? (await call(op, v), { workspaceTemplates: { edges: ours.map((node) => ({ node })) } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  assert.deepEqual(rows.filter((r) => r[1] !== "PASS"), []);
  assert.ok(!client.calls.some((c) => c.op === "TemplateGenerate" && c.variables.projectId));
  assert.equal(client.calls.find((c) => c.op === "TemplateDeploy").variables.input.templateId, "t-pub");
});

test("before generating, an earlier unpublished AgentRun template that deploys something else is deleted; a published, foreign or teammate's one is kept", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  const off = structuredClone((await call("TemplateGenerate", {})).templateGenerate.serializedConfig);
  Object.values(off.services)[0].deploy.healthcheckPath = "/";
  const foreign = { services: { x: { name: "Other", source: { image: "postgres:17" } } } };
  const withDb = { services: { ...structuredClone(off.services), ...foreign.services } };
  const ours = [
    { id: "t-stale", name: "AgentRun", code: "stale", status: "UNPUBLISHED", createdAt: "2026-11-17T12:00:00Z", serializedConfig: off },
    { id: "t-live", name: "AgentRun", code: "live", status: "PUBLISHED", createdAt: "2026-11-16T12:00:00Z", serializedConfig: off },
    { id: "t-other", name: "Postgres", code: "other", status: "UNPUBLISHED", createdAt: "2026-11-15T12:00:00Z", serializedConfig: foreign },
    { id: "t-mine", name: "My AgentRun", code: "mine", status: "UNPUBLISHED", createdAt: "2026-11-15T12:00:00Z", serializedConfig: off },
    { id: "t-db", name: "AgentRun", code: "db", status: "UNPUBLISHED", createdAt: "2026-11-15T12:00:00Z", serializedConfig: withDb },
  ];
  client.call = async (op, v) => (op === "WorkspaceTemplates" ? (await call(op, v), { workspaceTemplates: { edges: ours.map((node) => ({ node })) } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  assert.deepEqual(client.calls.filter((c) => c.op === "TemplateDelete").map((c) => c.variables.id), ["t-stale"]);
  assert.match(rows.find((r) => r[0] === "template generated")[2], /replaces live/);
});

test("a project named AgentRun that the script did not make is never patched: the run stops before changing anything", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  const theirs = { id: "p-theirs", name: "AgentRun", description: null, environments: { edges: [{ node: { id: "e", name: "production" } }] }, services: { edges: [{ node: { id: "s", name: "AgentRun" } }] } };
  client.call = async (op, v) => (op === "Projects" ? (await call(op, v), { projects: { edges: [{ node: theirs }] } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  assert.match(rows.find((r) => r[0] === "stopped")[2], /project named AgentRun \(p-theirs\) that this script did not make/);
  assert.deepEqual(client.calls.map((c) => c.op).filter((op) => !["Workspace", "Projects"].includes(op)), []);
});

test("a failed deploy is reported with its last log lines, the setup code's line left out, and its project still deleted", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  client.call = async (op, v) => (op === "Deployments" ? (await call(op, v), { deployments: { edges: [{ node: { id: "<deployment>", status: "FAILED" } }] } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  const stopped = rows.find((r) => r[0] === "stopped")[2];
  assert.match(stopped, /deploy ended FAILED[\s\S]*Healthcheck failed![\s\S]*\(a line with the setup code, not shown\)/);
  assert.doesNotMatch(stopped, /#code=/);
  assert.ok(client.calls.some((c) => c.op === "ProjectDelete") && !client.calls.some((c) => c.op === "TemplatePublish"));
});

test("the walk's Railway cost: each metric sample held until the next, the last until the reading, at the list prices", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const got = await usageOf(client, { projectId: "p", environmentId: "e", serviceId: "s", since: 0, now: 120_000 });
  // Samples at 0 s and 60 s, read at 120 s. CPU 0.1 vCPU for 60 s then 0.05 for 60 s; memory 0.2 GB then 0.3.
  assert.ok(Math.abs(got.by.CPU_USAGE - 9 / 60) < 1e-9 && Math.abs(got.by.MEMORY_USAGE_GB - 30 / 60) < 1e-9, JSON.stringify(got.by));
  assert.ok(Math.abs(got.usd - ((9 / 60) * PRICE_PER_MINUTE.CPU_USAGE + (30 / 60) * PRICE_PER_MINUTE.MEMORY_USAGE_GB)) < 1e-12);
  assert.equal(got.usage.CPU_USAGE, 0.5);

  // Railway's default rate can give one sample per series: it counts from its time to the reading.
  client.call = async (op) => (op === "Metrics" ? { metrics: [{ measurement: "DISK_USAGE_GB", values: [{ ts: "1970-01-01T00:16:40Z", value: 0.6 }] }] } : { usage: [] });
  const one = await usageOf(client, { projectId: "p", environmentId: "e", serviceId: "s", since: 0, now: 1030_000 });
  assert.ok(Math.abs(one.by.DISK_USAGE_GB - 0.3) < 1e-9, JSON.stringify(one.by));
});

test("the walk waits for Railway's background delete of the throwaway project", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call;
  let reads = 0;
  client.call = async (op, v) => (op === "Project" && client.calls.some((c) => c.op === "ProjectDelete") && ++reads < 3 ? { project: { id: v.id, deletedAt: null } } : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  assert.equal(rows.find((r) => r[0] === "throwaway project deleted")[1], "PASS");
  assert.equal(reads, 3);
});

test("the published template's description fits Railway's 75 characters", () => {
  assert.ok(PUBLISH.description.length <= 75, PUBLISH.description.length);
});

test("a workspace not named as expected stops the run before anything is made", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws", workspaceName: "Someone else" });
  const rows = await run(client, { workspaceId: "ws", expectWorkspace: "Parcha", log: quiet });
  assert.match(rows.at(-1)[2], /named "Someone else", not "Parcha": nothing was made/);
  assert.deepEqual(client.calls.map((c) => c.op), ["Workspace"]);
});

test("the deploy form sends each variable's default as its value, and one with no default not at all", () => {
  const config = loadTemplate();
  Object.values(config.services)[0].variables.BLANK = { defaultValue: "" };
  const vars = Object.values(formValues(config).services)[0].variables;
  assert.equal(vars.AGENTRUN_TOKEN.value, service.variables.AGENTRUN_TOKEN.defaultValue);
  assert.equal(vars.BLANK.value, undefined);
  assert.equal(Object.values(config.services)[0].variables.AGENTRUN_TOKEN.value, undefined, "the template's config is left as it was");
});

test("curl gets the request's headers and body on stdin, quoted, and nothing of them in its arguments", () => {
  const body = JSON.stringify({ code: "s3cr\"t\\x", note: "a\nb" });
  const config = curlConfig({ authorization: "Bearer tok-123" }, body);
  assert.equal(config, `header = "authorization: Bearer tok-123"\ndata-binary = "${body.replace(/[\\"]/g, (c) => `\\${c}`)}"\n`);
  const args = curlArgs("https://example.test/x", { method: "POST" });
  assert.ok(!args.some((a) => a.includes("tok-123") || a.includes("s3cr")), args.join(" "));
  assert.deepEqual(args.slice(args.indexOf("-K"), args.indexOf("-K") + 2), ["-K", "-"]);
});

test("a walk that fails deletes its project and publishes nothing", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  client.call = async (op, v) => (op === "Variables" ? (await call(op, v), { variables: { AGENTRUN_TOKEN: "${{secret(64)}}" } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", log: quiet });
  const ops = client.calls.map((c) => c.op);
  assert.equal(rows.find((r) => r[1] === "FAIL")[0], "stopped");
  assert.ok(ops.includes("ProjectDelete") && !ops.includes("TemplatePublish"), ops.join(" "));
});

test("the sweep deletes a walk project older than any walk runs, and leaves a younger one (maybe another run's) alone", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const walks = [{ id: "old", name: "agentrun-template-walk-1", createdAt: ago(WALK_MAX_MS + 60_000) }, { id: "young", name: "agentrun-template-walk-2", createdAt: ago(60_000) }, { id: "odd", name: "agentrun-template-walk-3", createdAt: "?" }];
  client.call = async (op, v) => (op === "Projects" ? (await call(op, v), { projects: { edges: walks.map((node) => ({ node })) } }) : call(op, v));
  const rows = await run(client, { workspaceId: "ws", mode: "walk", code: "abc", log: quiet });
  const deleted = client.calls.filter((c) => c.op === "ProjectDelete").map((c) => c.variables.id);
  assert.deepEqual(deleted, ["old", "<walk project>"]);
  assert.match(rows.find((r) => r[0] === "recent walks left alone")[2], /young.*odd/);
});

test("a template that would deploy something else is never walked or published", async () => {
  const client = planClient({ log: quiet, workspaceId: "ws" });
  const call = client.call.bind(client);
  client.call = async (op, v) => {
    const got = await call(op, v);
    if (op === "Template") Object.values(got.template.serializedConfig.services)[0].deploy = { ...service.deploy, healthcheckPath: "/" };
    return got;
  };
  const rows = await run(client, { workspaceId: "ws", mode: "template", code: "abc", log: quiet });
  assert.match(rows.at(-1)[2], /deploy\.healthcheckPath: the repository's "\/v2\/health", Railway's "\/"/);
  assert.ok(!client.calls.some((c) => c.op === "TemplateDeploy" || c.op === "TemplatePublish"));
});

test("the local walk runs the image as Railway does: as RAILWAY_RUN_UID, the start command in place of the entrypoint, a volume with nothing copied in", () => {
  const args = dockerRunArgs(service, { name: "w", volume: "v", envFile: "/tmp/env", image: "img" });
  const [entrypoint, ...rest] = startArgv(service.deploy.startCommand);
  assert.deepEqual(args, ["run", "-d", "--name", "w", "--user", "0", "--env-file", "/tmp/env", "-p", "127.0.0.1::7340", "-v", "v:/data:nocopy", "--entrypoint", entrypoint, "img", ...rest]);
});

test("deploy/README.md has the Railway button on its one marked line: the placeholder, or a published template's button", async () => {
  const lines = (await read("deploy/README.md")).split("\n");
  assert.equal(lines.filter((l) => l === BUTTON_MARK).length, 1);
  const button = lines[lines.indexOf(BUTTON_MARK) + 1];
  const code = /new\/template\/([^?]+)\?/.exec(button ?? "")?.[1];
  assert.ok(button === BUTTON_PLACEHOLDER || (code && code !== "TEMPLATE_CODE" && button === buttonLine(code)), button);
  assert.equal(lines.filter((l) => l.includes("railway.com/new/template/")).length, 1, "the button is on the marked line alone");
});
