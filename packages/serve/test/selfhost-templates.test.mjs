// The Coolify and Dokploy templates (deploy/coolify/agentrun.yaml, deploy/dokploy/agentrun/), with neither platform: each
// runs the image the release pins, the way the image runs itself, with no Docker socket and its data on a volume at
// /data; and each platform's own generators, written here from its source, make a token and a seal key this server
// takes. deploy/selfhost/walk.sh deploys them on the platforms themselves.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { tokenProblem } from "../dist/api-token.js";
import { sealKeyOf } from "../dist/tool-keys.js";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const coolify = parseYaml(await read("deploy/coolify/agentrun.yaml"));
const dokploy = parseYaml(await read("deploy/dokploy/agentrun/docker-compose.yml"));
const dokployToml = parseToml(await read("deploy/dokploy/agentrun/template.toml"));
const templates = { coolify, dokploy };
const only = (compose) => {
  const names = Object.keys(compose.services);
  assert.deepEqual(names, ["agentrun"], "one service: the server with its runner beside it");
  return compose.services.agentrun;
};
const envOf = (service) =>
  Array.isArray(service.environment) ? Object.fromEntries(service.environment.map((e) => [e.split("=")[0], e.slice(e.indexOf("=") + 1)])) : { ...service.environment };

// Coolify v4.7.5, bootstrap/helpers/shared.php generateEnvValue: only the commands that make real random bytes. BASE64_*
// there is Str::random (letters and digits, not base64), and PASSWORD has no fixed shape: neither is here, so a
// template that used them fails below.
const COOLIFY = {
  HEX_32: () => randomBytes(16).toString("hex"),
  HEX_64: () => randomBytes(32).toString("hex"),
  HEX_128: () => randomBytes(64).toString("hex"),
  REALBASE64: () => randomBytes(32).toString("base64"),
  REALBASE64_32: () => randomBytes(32).toString("base64"),
  REALBASE64_64: () => randomBytes(64).toString("base64"),
};
// Coolify: SERVICE_<COMMAND>_<NAME>, with SERVICE_URL_<NAME> the service's domain as a URL (http://<name>-<uuid>.<ip>.sslip.io
// when Coolify makes one) and SERVICE_URL_<NAME>_<PORT> naming the port the domain reaches.
function renderCoolify(service, domain) {
  const env = envOf(service);
  const made = new Map();
  const value = (ref) => {
    const m = /^\$\{?SERVICE_([A-Z0-9_]+)\}?$/.exec(ref);
    if (!m) return ref;
    if (made.has(m[1])) return made.get(m[1]);
    const url = /^URL_([A-Z0-9]+)$/.exec(m[1]);
    const command = Object.keys(COOLIFY).sort((a, b) => b.length - a.length).find((c) => m[1].startsWith(`${c}_`));
    assert.ok(url || command, `Coolify's ${ref} is one of the random-bytes generators or the service's URL`);
    const v = url ? `http://${domain}` : COOLIFY[command]();
    made.set(m[1], v);
    return v;
  };
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("SERVICE_")).map(([k, v]) => [k, value(v)]));
}

// Dokploy v0.31.4 (packages/server/src/templates/index.ts and processors.ts): ${domain} is <app>-<hash>-<ip>.sslip.io when
// Dokploy makes one; ${hash:N} is randomBytes hex; ${base64:N} is randomBytes(N) in base64. ${password:N} is
// Math.random letters and digits: not here, so a template that used it fails below.
const DOKPLOY = {
  hash: (n) => randomBytes(Math.ceil(n / 2)).toString("hex").substring(0, n),
  base64: (n) => randomBytes(n).toString("base64"),
};
function renderDokploy(toml, service, domain) {
  const vars = {};
  const helper = (text) =>
    text.replace(/\$\{([^}]+)\}/g, (_, ref) => {
      if (ref === "domain") return domain;
      if (ref in vars) return vars[ref];
      const [name, n] = ref.split(":");
      assert.ok(name in DOKPLOY && Number(n) > 0, `Dokploy's \${${ref}} is one of the random-bytes generators, with a length`);
      return DOKPLOY[name](Number(n));
    });
  for (const [k, v] of Object.entries(toml.variables)) vars[k] = helper(v);
  const dotenv = Object.fromEntries(Object.entries(toml.config.env).map(([k, v]) => [k, helper(v)]));
  return Object.fromEntries(
    Object.entries(envOf(service)).map(([k, v]) => [k, String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      assert.ok(name in dotenv, `${k}'s \${${name}} is set by template.toml's [config.env]`);
      return dotenv[name];
    })]),
  );
}

test("both templates pin this release's image (the tag a release bumps, as render.yaml's and the chart's)", async () => {
  const { version } = JSON.parse(await read("packages/serve/package.json"));
  for (const [name, compose] of Object.entries(templates)) assert.equal(only(compose).image, `ghcr.io/parcha-ai/agentrun-server:v${version}`, name);
});

test("the image's own command, its data on a volume at /data, its health check, and nothing of the host's", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)[1]);
  const port = Number(/^EXPOSE (\d+)$/m.exec(dockerfile)[1]);
  assert.match(dockerfile, /^VOLUME \["\/data"\]$/m);
  const health = /healthCheckPath: (\S+)/.exec(await read("render.yaml"))[1];
  for (const [name, compose] of Object.entries(templates)) {
    const service = only(compose);
    assert.equal(service.command, undefined, `${name}: the image's command (${cmd.join(" ")})`);
    assert.equal(service.entrypoint, undefined, name);
    assert.equal(cmd[cmd.indexOf("--data") + 1], "/data");
    assert.deepEqual(service.volumes, ["agentrun-data:/data"], `${name}: one named volume at /data, no bind mount`);
    assert.ok(compose.volumes && "agentrun-data" in compose.volumes, `${name} declares its volume`);
    // No Docker socket, no host: agents get file tools and web_fetch, no shell.
    assert.doesNotMatch(JSON.stringify(compose), /docker\.sock|privileged|"network_mode"|"pid"|cap_add|"user"/, name);
    assert.equal(service.ports, undefined, `${name}: the platform's proxy reaches it; nothing published on the host`);
    const check = service.healthcheck.test;
    assert.equal(check[0], "CMD");
    assert.ok(check.slice(0, 3).join(" ") === "CMD env -i", `${name}: the check runs with an empty environment, so the secrets stay out of it`);
    assert.ok(check.at(-1).includes(`http://127.0.0.1:${port}${health}`), `${name}: the check is GET ${health} on ${port}`);
  }
  assert.ok(only(coolify).environment.includes(`SERVICE_URL_AGENTRUN_${port}`), "Coolify's domain reaches the image's port");
  assert.deepEqual(dokployToml.config.domains.map((d) => [d.serviceName, d.port]), [["agentrun", port]], "Dokploy's domain reaches the image's port");
  assert.deepEqual(dokployToml.config.mounts, []);
});

test("each deploy makes a token and a seal key this server takes, from the platform's own random bytes, and the public URL at its domain", () => {
  for (let i = 0; i < 500; i++) {
    const domain = `agentrun-${randomUUID().slice(0, 8)}.203.0.113.7.sslip.io`;
    const runs = {
      coolify: [renderCoolify(only(coolify), domain), `http://${domain}`],
      dokploy: [renderDokploy(dokployToml, only(dokploy), domain), `http://${domain}`],
    };
    for (const [name, [env, url]] of Object.entries(runs)) {
      assert.deepEqual(Object.keys(env).sort(), ["AGENTRUN_PUBLIC_URL", "AGENTRUN_SEAL_KEY", "AGENTRUN_TOKEN"], `${name}: no model key, nothing to type`);
      assert.equal(tokenProblem(env.AGENTRUN_TOKEN), undefined, name);
      assert.ok(env.AGENTRUN_TOKEN.length >= 64, `${name}: 256 bits or more`);
      assert.equal(sealKeyOf(env.AGENTRUN_SEAL_KEY)?.length, 32, `${name}: the seal key is 32 bytes in base64 (it has ${env.AGENTRUN_SEAL_KEY.length} characters)`);
      assert.equal(env.AGENTRUN_PUBLIC_URL, url, name);
    }
  }
});
