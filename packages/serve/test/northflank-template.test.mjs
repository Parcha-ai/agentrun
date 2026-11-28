// The Northflank template (deploy/northflank/template.json), with no Northflank account: it runs the image the release
// pins, the way the image runs itself, as one instance on a volume at /data; and Northflank's randomSecret, written here
// from its documentation, makes a token and a seal key this server takes. Read from Northflank's public docs pages
// "Write a template" (apiVersion v1.2), "Template nodes" (node kinds, update modes), "Make a template dynamic" (refs,
// ports.N.dns, fn.*) and "Add a volume" (one instance, old container first); the PR that added this file links them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { tokenProblem } from "../dist/api-token.js";
import { sealKeyOf } from "../dist/tool-keys.js";
import { RUNNER_DRAIN_TIMEOUT } from "../dist/runner/main.js";
import { runnerCloseBoundMs } from "../dist/runner/runner.js";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const template = JSON.parse(await read("deploy/northflank/template.json"));

/** Every node, in the order a run reaches it: a sequential workflow's steps one after another, nested workflows inline. */
function nodes(node = template.spec) {
  if (node.kind !== "Workflow") return [node];
  return node.spec.steps.flatMap((step) => nodes(step));
}
const all = nodes();
const ofKind = (kind) => all.filter((n) => n.kind === kind);
const one = (kind) => {
  const found = ofKind(kind);
  assert.equal(found.length, 1, `one ${kind} node`);
  return found[0];
};
const service = one("DeploymentService");
const volume = one("Volume");
const groups = ofKind("SecretGroup");
const variables = Object.assign({}, ...groups.map((g) => g.spec.secrets.variables));
const groupOf = (name) => groups.find((g) => name in g.spec.secrets.variables);
const at = (node) => all.indexOf(node);
const serviceRef = (field) => `\${refs.${service.ref}.${field}}`;

// Northflank's randomSecret(length, encoding): "a random secret of the specified length in either base64 (default) or
// hex", stored in the resource it is made for and kept on later runs. Its length is the value's length in characters,
// as Northflank's own guides read it (a randomSecret(32) is "a randomly generated 32-character secret").
const FN = {
  randomSecret: (length, encoding = "base64") => {
    assert.ok(Number.isInteger(length) && length > 0, "randomSecret takes a length");
    assert.ok(encoding === "base64" || encoding === "hex", `randomSecret's encoding is 'base64' or 'hex', not ${encoding}`);
    return randomBytes(length).toString(encoding).slice(0, length);
  },
};
/** A value as a template run writes it: each ${fn.name(args)} call made, and every ${refs...} given by `refs`. */
function render(value, refs) {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    if (expr in refs) return refs[expr];
    const call = /^fn\.(\w+)\((.*)\)$/.exec(expr);
    assert.ok(call && call[1] in FN, `\${${expr}} is a reference this test knows or one of Northflank's generator functions`);
    const args = call[2].split(",").map((a) => a.trim()).map((a) => (/^'.*'$/.test(a) ? a.slice(1, -1) : Number(a)));
    return FN[call[1]](...args);
  });
}

test("a Northflank template of spec v1.2 that makes its own project and puts the rest in it", () => {
  assert.equal(template.apiVersion, "v1.2");
  assert.ok(template.name && template.description);
  const [project, rest] = template.spec.spec.steps;
  assert.equal(template.spec.spec.type, "sequential");
  assert.equal(project.kind, "Project");
  assert.equal(rest.kind, "Workflow");
  assert.equal(rest.spec.type, "sequential", "each step waits for the one before it");
  assert.deepEqual(rest.spec.context, { projectId: `\${refs.${project.ref}.id}` });
});

test("the service runs the image the release pins (the tag a release bumps, as render.yaml's and the other templates')", async () => {
  const { version } = JSON.parse(await read("packages/serve/package.json"));
  assert.equal(service.spec.deployment.external.imagePath, `ghcr.io/parcha-ai/agentrun-server:v${version}`);
  assert.equal(service.spec.deployment.external.credentials, undefined, "a public image: no saved credentials");
  // The image's own entrypoint and command: the server and one runner, two processes, on /data.
  assert.deepEqual(service.spec.deployment.docker, { configType: "default" });
});

test("one instance, never scaled, on a single read/write volume at /data, so the old container stops before the new one starts", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)[1]);
  assert.equal(cmd[cmd.indexOf("--data") + 1], "/data");
  assert.equal(service.spec.deployment.instances, 1);
  assert.equal(service.spec.autoscaling, undefined, "no autoscaling: the store is SQLite on /data");
  assert.deepEqual(volume.spec.mounts, [{ containerMountPath: "/data", volumeMountPath: "" }]);
  assert.deepEqual(volume.spec.attachedObjects, [{ id: serviceRef("id"), type: "service" }]);
  // add-a-volume: with a Single Read/Write volume the service has 1 instance, and on a restart the running container
  // "will always be terminated before the new one starts". So no rollout strategy here, which could only surge.
  assert.equal(volume.spec.spec.accessMode, "ReadWriteOnce");
  assert.equal(service.spec.deployment.strategy, undefined);
  // The stop grace covers the runner's whole close (its drain, then the stop of a stuck run), so a restart never cuts a
  // run's end and the release of its claim short: 45 s, as deploy/README.md asks of every host.
  assert.equal(RUNNER_DRAIN_TIMEOUT, "6s");
  assert.ok(service.spec.deployment.gracePeriodSeconds * 1000 > runnerCloseBoundMs(6_000), "the grace outlasts the runner's close");
  assert.equal(service.spec.deployment.gracePeriodSeconds, 45);
  // 10 GB, as render.yaml's disk: Claude Code and Codex install themselves onto it on first use.
  assert.equal(volume.spec.spec.storageSize, 10240);
  // A run of the template again never replaces the data's volume.
  assert.equal(volume.updateMode, "create");
});

test("one public HTTP port, the image's, which the health check reaches at render.yaml's path", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const port = Number(/^EXPOSE (\d+)$/m.exec(dockerfile)[1]);
  assert.equal(port, 7340);
  assert.equal(service.spec.ports.length, 1);
  const [p] = service.spec.ports;
  assert.deepEqual([p.internalPort, p.public, p.protocol], [port, true, "HTTP"]);
  assert.match(p.name, /^[a-z][a-z0-9]{0,7}$/, "a port name Northflank takes (1 to 8 characters)");
  const health = /healthCheckPath: (\S+)/.exec(await read("render.yaml"))[1];
  assert.equal(health, "/v2/health");
  assert.ok(service.spec.healthChecks.length > 0);
  for (const check of service.spec.healthChecks) {
    assert.deepEqual([check.protocol, check.path, check.port], ["HTTP", health, port], check.type);
  }
  assert.ok(service.spec.healthChecks.some((c) => c.type === "readinessProbe"), "traffic waits for the server");
});

test("2 GB of memory, as render.yaml's plan, which the runner budgets runs by", () => {
  // Northflank's compute plans (its pricing page): nf-compute-100-2 is 1 vCPU and 2 GB.
  assert.equal(service.spec.billing.deploymentPlan, "nf-compute-100-2");
});

test("the token and the seal key come from Northflank's generator, made once, before the service's first start, never a literal", () => {
  const keys = groupOf("AGENTRUN_TOKEN");
  assert.equal(keys, groupOf("AGENTRUN_SEAL_KEY"), "one secret group holds both");
  assert.ok(at(keys) < at(service), "the service's first start has them");
  assert.equal(keys.updateMode, "create", "a run of the template again keeps them");
  assert.equal(keys.spec.secretType, "environment");
  for (const name of ["AGENTRUN_TOKEN", "AGENTRUN_SEAL_KEY"]) {
    assert.match(variables[name], /^\$\{fn\.randomSecret\(\d+, '(hex|base64)'\)\}$/, `${name} is made by randomSecret alone`);
    assert.equal(service.spec.runtimeEnvironment[name], undefined, `${name} is not in the service's own environment`);
  }
  // The seal key is 43 base64 characters, the one length sealKeyOf takes (32 bytes; an optional "=" after), if
  // randomSecret's length counts characters. Counted in bytes, randomSecret(43) would be 60 characters, which the
  // server refuses at its start: the proof run on Northflank looks at this first.
  assert.equal(variables.AGENTRUN_SEAL_KEY, "${fn.randomSecret(43, 'base64')}");
  assert.equal(variables.AGENTRUN_TOKEN, "${fn.randomSecret(64, 'hex')}");
  assert.equal(sealKeyOf(randomBytes(43).toString("base64").slice(0, 43))?.length, 32, "43 base64 characters are a seal key");
  assert.equal(sealKeyOf(randomBytes(43).toString("base64").slice(0, 60)), undefined, "60 base64 characters are no seal key");
  // No other value anywhere in the file looks like one: a literal token or key would be the same on every deploy.
  const text = JSON.stringify(template);
  assert.doesNotMatch(text, /[0-9a-f]{32}|[A-Za-z0-9+/]{40}/);
  // The values a run makes are ones this server takes. Their shape is fixed, so a few renders prove no more.
  for (let i = 0; i < 5; i++) {
    const token = render(variables.AGENTRUN_TOKEN, {});
    assert.match(token, /^[0-9a-f]{64}$/, "64 hex characters: 256 bits");
    assert.equal(tokenProblem(token), undefined);
    const seal = render(variables.AGENTRUN_SEAL_KEY, {});
    assert.equal(sealKeyOf(seal)?.length, 32, `the seal key is 32 bytes in base64 (it has ${seal.length} characters)`);
  }
});

test("AGENTRUN_PUBLIC_URL is the service's own Northflank domain, set once it has one, and the service restarts onto it", () => {
  const address = groupOf("AGENTRUN_PUBLIC_URL");
  const port = service.spec.ports.findIndex((p) => p.public && p.internalPort === 7340);
  assert.equal(variables.AGENTRUN_PUBLIC_URL, `https://${serviceRef(`ports.${port}.dns`)}`);
  const domain = "http--agentrun--abcd1234.example";
  assert.equal(render(variables.AGENTRUN_PUBLIC_URL, { [`refs.${service.ref}.ports.${port}.dns`]: domain }), `https://${domain}`);
  // The domain exists once the service does: the group comes after it, then a wait until it runs, then a restart that
  // starts it with the address (Northflank's own Payload template does the same).
  assert.ok(at(service) < at(address));
  const condition = one("Condition");
  const action = one("Action");
  assert.ok(at(address) < at(condition) && at(condition) < at(action));
  assert.deepEqual(condition.spec, { kind: "Service", spec: { data: { serviceId: serviceRef("id") }, type: "running" } });
  assert.deepEqual(action.spec, { kind: "Service", spec: { data: { serviceId: serviceRef("id") }, type: "restart" } });
});

test("the server's variables and nothing else: no model key, nothing to type, runs as the server's own user", () => {
  const env = { ...variables, ...service.spec.runtimeEnvironment };
  assert.deepEqual(Object.keys(env).sort(), ["AGENTRUN_PUBLIC_URL", "AGENTRUN_RUN_USER", "AGENTRUN_SEAL_KEY", "AGENTRUN_TOKEN"]);
  // Northflank hasn't been shown to keep the image helper's file capabilities, as Render and Railway haven't.
  assert.equal(env.AGENTRUN_RUN_USER, "same");
  assert.equal(template.arguments, undefined, "no argument to fill in");
});
