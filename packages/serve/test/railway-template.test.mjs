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
const { BUTTON_MARK, BUTTON_PLACEHOLDER, buttonLine, planClient, run, sourcePatch } = await import(new URL("deploy/railway/publish-and-walk.mjs", ROOT));
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

test("render.yaml pins this release's image (the tag a release bumps)", async () => {
  const { version } = JSON.parse(await read("packages/serve/package.json"));
  assert.match(await read("render.yaml"), new RegExp(`^ {6}url: ghcr\\.io/parcha-ai/agentrun-server:v${version.replace(/\./g, "\\.")}$`, "m"));
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
  assert.equal(script, `chown 1000:1000 ${mount} && chmod 700 ${mount} && exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/node ${[...entrypoint, ...cmd].join(" ")}`);
  // Railway mounts a volume as root: the container starts as root (RAILWAY_RUN_UID=0) only for the chown above.
  assert.equal(service.variables.RAILWAY_RUN_UID.defaultValue, "0");
  assert.ok(cmd.includes(mount) && cmd[cmd.indexOf("--data") + 1] === mount, "the server's data directory is the volume");
});

test("the volume, the health check, and one port for the domain, the health check and the server", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const port = Number(/^EXPOSE (\d+)$/m.exec(dockerfile)[1]);
  const argv = startArgv(service.deploy.startCommand)[2].split(" ");
  assert.deepEqual([Object.values(service.volumeMounts).map((m) => m.mountPath), service.deploy.requiredMountPath], [["/data"], "/data"]);
  assert.equal(service.deploy.healthcheckPath, /healthCheckPath: (\S+)/.exec(await read("render.yaml"))[1]);
  assert.deepEqual([Number(service.variables.PORT.defaultValue), Number(argv[argv.indexOf("--port") + 1]), ...Object.values(service.networking.serviceDomains).map((d) => d.port)], [port, port, port]);
  // At least the runner's 31 s stop (deploy/README.md) before Railway's SIGKILL.
  assert.ok(service.deploy.drainingSeconds >= 35);
});

test("each deploy generates a token and a seal key this server takes, with 256 bits or more each, and the public URL at its domain", () => {
  for (let i = 0; i < 500; i++) {
    const env = renderVariables(service, { domain: "agentrun-production-ab12.up.railway.app" });
    assert.equal(tokenProblem(env.AGENTRUN_TOKEN), undefined);
    assert.equal(sealKeyOf(env.AGENTRUN_SEAL_KEY)?.length, 32, env.AGENTRUN_SEAL_KEY.length);
    assert.equal(env.AGENTRUN_PUBLIC_URL, "https://agentrun-production-ab12.up.railway.app");
    assert.equal(env.OPENROUTER_API_KEY, undefined, "an optional key left blank is not set");
  }
  const bits = (v) => {
    const [, n, alphabet] = /secret\((\d+), "([^"]+)"\)/.exec(v.defaultValue);
    return Number(n) * Math.log2(alphabet.length);
  };
  assert.ok(bits(service.variables.AGENTRUN_TOKEN) >= 256 && bits(service.variables.AGENTRUN_SEAL_KEY) >= 256);
  assert.throws(() => renderValue("${{Postgres.DATABASE_URL}}", { domain: "x" }), /does not know/);
});

test("every variable says what it is for, and only model keys are optional", () => {
  for (const [name, v] of Object.entries(service.variables)) {
    assert.ok(v.description?.length > 20, `${name} has a description`);
    assert.equal(Boolean(v.isOptional), /_API_KEY$/.test(name), name);
  }
});

test("the deploy settings are railway.json's (railway.com/railway.schema.json, deploy): the same names and types", () => {
  const schema = { startCommand: "string", healthcheckPath: "string", healthcheckTimeout: "number", drainingSeconds: "number", overlapSeconds: "number", requiredMountPath: "string", restartPolicyType: "string", numReplicas: "number" };
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

test("the source project's patch is the template's service, and removes a variable the template no longer has", () => {
  const patch = sourcePatch(service, "svc", { variables: { OLD: { value: "x" }, PORT: { value: "1" } } });
  const s = patch.services.svc;
  assert.equal(s.variables.OLD, null);
  assert.deepEqual(s.variables.PORT, { value: "7340", description: service.variables.PORT.description });
  assert.equal(s.variables.OPENAI_API_KEY.isOptional, true);
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
  assert.deepEqual(differences(loadTemplate(), generated.serializedConfig), []);
  const env = (await client.call("Variables", {})).variables;
  for (const secret of [env.AGENTRUN_TOKEN, env.AGENTRUN_SEAL_KEY]) assert.ok(!lines.some((l) => l.includes(secret)), "a generated secret was printed");
  assert.ok(lines.some((l) => l.includes(buttonLine("<code>"))), "the README's button line is printed");
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
