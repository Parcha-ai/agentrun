// A server's boxes (boxes.ts): AGENTRUN_BOXES lists the ones to set up, each listed box is probed once at start, and every
// box is available or not with a short reason. Docker answers through a fake `docker` first on PATH, Daytona through a
// fake endpoint on loopback, and the VM provider's SDK is absent (or a fake one, in a process of its own): no real
// Docker command and no provider call runs here. The boxes' keys are the server's alone: none is in an offer, a reason
// or a log line, and none reaches a run's process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BOX_IDS, BOX_KEYS, boxesLog, boxRegistry, VM_PROVIDER } from "../dist/boxes.js";
import { SERVER_LOCK } from "../dist/server-lock.js";
import { startServe } from "../dist/index.js";
import { FAUX, scratch, withEnv } from "./support.mjs";

const VM = VM_PROVIDER.id;
const DAYTONA_KEY = "DAYTONA_API_KEY";
const NOT_ENABLED = "not enabled on this server";
const NOT_YET = "the bwrap box is not in this release yet";
const CANARY = `not-a-key-${process.pid}`;
const keys = () => Object.fromEntries(BOX_KEYS.map((name) => [name, `${CANARY}-${name}`]));

/** A fake `docker` in a directory of its own, first on the PATH it returns: it writes each call's arguments to `calls`,
 *  then does `body`. */
async function fakeDocker(t, body) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  const calls = join(bin, "calls");
  await writeFile(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${body}\n`);
  await chmod(join(bin, "docker"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []) };
}
const ANSWERS = 'case "$1" in version) echo 27.3.1; exit 0 ;; esac\nexit 1';
const FAILS = "echo 'RAW-DOCKER-STDERR permission denied on the daemon socket' >&2\nexit 1";

/** A fake Daytona API on loopback: each request is kept in `seen`, and `answer` writes the response (or none). */
async function fakeDaytona(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    answer(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return { url: `http://127.0.0.1:${server.address().port}/api`, seen };
}
/** Daytona as it answers a box that does not exist: 404 to the key it takes, 401 to any other, with a body that echoes
 *  what it was sent. */
const takes = (key) => (req, res) => {
  const known = req.headers.authorization === `Bearer ${key}`;
  res.writeHead(known ? 404 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ statusCode: known ? 404 : 401, message: `RAW-DAYTONA-BODY ${req.headers.authorization}` }));
};

const offerOf = (registry, id) => registry.offers().find((offer) => offer.id === id);

test("with nothing listed, nothing is probed and every box is unavailable: bwrap is not in this release, the rest are not enabled", async (t) => {
  const docker = await fakeDocker(t, ANSWERS);
  const daytona = await fakeDaytona(t, takes(`${CANARY}-${DAYTONA_KEY}`));
  for (const listed of [undefined, "", " , "]) {
    const registry = await boxRegistry({ PATH: docker.PATH, ...keys(), DAYTONA_API_URL: daytona.url, ...(listed === undefined ? {} : { AGENTRUN_BOXES: listed }) });
    assert.deepEqual(registry.offers(), BOX_IDS.map((id) => ({ id, available: false, reason: id === "bwrap" ? NOT_YET : NOT_ENABLED })));
    for (const id of BOX_IDS) assert.equal(registry.provider(id), undefined, `no provider for ${id}`);
  }
  assert.deepEqual(docker.calls(), [], "docker was never run");
  assert.deepEqual(daytona.seen, [], "Daytona was never asked");
});

test("a name in AGENTRUN_BOXES that is no box refuses the start, naming it, before the server takes its data directory", async (t) => {
  const docker = await fakeDocker(t, ANSWERS);
  await assert.rejects(boxRegistry({ PATH: docker.PATH, AGENTRUN_BOXES: "docker,lxc" }), /AGENTRUN_BOXES names lxc, which is not a box: list any of bwrap, docker, .*daytona/);
  await assert.rejects(boxRegistry({ AGENTRUN_BOXES: "Docker, firecracker" }), /AGENTRUN_BOXES names Docker, firecracker, which are not boxes/);
  withEnv(t, { PATH: docker.PATH, AGENTRUN_BOXES: "docker, lxc" });
  const data = join(await scratch(t), "agents");
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), /AGENTRUN_BOXES names lxc, which is not a box/);
  assert.equal(existsSync(join(data, SERVER_LOCK)), false, "refused before the server lock");
  assert.deepEqual(docker.calls(), [], "nothing was probed");
});

test("docker listed: a docker that answers `docker version` is available, with its provider; bwrap stays out", async (t) => {
  const docker = await fakeDocker(t, ANSWERS);
  const registry = await boxRegistry({ PATH: docker.PATH, AGENTRUN_BOXES: "docker,bwrap" });
  assert.deepEqual(offerOf(registry, "docker"), { id: "docker", available: true });
  assert.equal(registry.provider("docker")?.name, "docker");
  assert.deepEqual(docker.calls(), ["version --format {{.Server.Version}}"], "one call, the probe: building the provider runs nothing");
  assert.deepEqual(offerOf(registry, "bwrap"), { id: "bwrap", available: false, reason: NOT_YET });
  assert.deepEqual(offerOf(registry, "daytona"), { id: "daytona", available: false, reason: NOT_ENABLED });
  // The log line says why each listed box is not there, bwrap included; a box not listed needs no reason.
  assert.deepEqual(boxesLog(registry.offers(), new Set(["docker", "bwrap"])), { available: "docker", unavailable: BOX_IDS.filter((id) => id !== "docker").join(","), bwrap: NOT_YET });
});

test("docker listed: a docker that fails, or none on PATH, leaves it unavailable with a short reason, no stack and none of its output", async (t) => {
  const docker = await fakeDocker(t, FAILS);
  const failed = await boxRegistry({ PATH: docker.PATH, AGENTRUN_BOXES: "docker" });
  const offer = offerOf(failed, "docker");
  assert.equal(offer.available, false);
  assert.match(offer.reason, /^docker version failed \(exit 1\): is the Docker daemon running/);
  assert.ok(!offer.reason.includes("\n") && !/\bat .*:\d+/.test(offer.reason) && !offer.reason.includes("RAW-DOCKER-STDERR"), offer.reason);
  assert.equal(failed.provider("docker"), undefined);
  assert.equal(docker.calls().length, 1);

  const empty = join(await scratch(t), "empty");
  await mkdir(empty);
  const none = await boxRegistry({ PATH: empty, AGENTRUN_BOXES: "docker" });
  assert.deepEqual(offerOf(none, "docker"), { id: "docker", available: false, reason: "no docker command on this server's PATH" });
});

test("each probe is bounded and they run at once: a docker and a Daytona that never answer leave both unavailable within one timeout", async (t) => {
  const docker = await fakeDocker(t, "exec sleep 30");
  const daytona = await fakeDaytona(t, () => {});
  const started = Date.now();
  const registry = await boxRegistry({ PATH: docker.PATH, AGENTRUN_BOXES: "docker,daytona", [DAYTONA_KEY]: `${CANARY}-${DAYTONA_KEY}`, DAYTONA_API_URL: daytona.url }, { timeoutMs: 1_000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_900, `both probes ended in ${elapsed} ms: at once, not one after the other`);
  for (const id of ["docker", "daytona"]) assert.deepEqual(offerOf(registry, id), { id, available: false, reason: "its probe did not finish within 1000 ms" });
  assert.ok(daytona.seen.length >= 1, "Daytona was asked; the provider may try a failed connection again within the timeout");
});

test("daytona listed: without its key it is unavailable and Daytona is never asked; with a key Daytona takes, it is available after one authenticated read", async (t) => {
  const key = `${CANARY}-${DAYTONA_KEY}`;
  const daytona = await fakeDaytona(t, takes(key));
  const keyless = await boxRegistry({ AGENTRUN_BOXES: "daytona", DAYTONA_API_URL: daytona.url });
  assert.deepEqual(offerOf(keyless, "daytona"), { id: "daytona", available: false, reason: "needs DAYTONA_API_KEY" });
  assert.deepEqual(daytona.seen, []);

  const registry = await boxRegistry({ AGENTRUN_BOXES: "daytona", [DAYTONA_KEY]: key, DAYTONA_API_URL: daytona.url, DAYTONA_TARGET: "eu" });
  assert.deepEqual(offerOf(registry, "daytona"), { id: "daytona", available: true });
  assert.equal(registry.provider("daytona")?.name, "daytona");
  assert.equal(daytona.seen.length, 1, "one request");
  assert.equal(daytona.seen[0].method, "GET");
  assert.match(daytona.seen[0].url, /^\/api\/sandbox\/agentrun-probe-[0-9a-f-]{36}$/, "a read of a box no one has");
  assert.equal(daytona.seen[0].authorization, `Bearer ${key}`);

  const bad = await boxRegistry({ AGENTRUN_BOXES: "daytona", DAYTONA_API_URL: "not a url", [DAYTONA_KEY]: key });
  assert.deepEqual(offerOf(bad, "daytona"), { id: "daytona", available: false, reason: "DAYTONA_API_URL is not a URL" });
});

test("daytona listed: a key Daytona refuses leaves it unavailable, and the reason holds neither the key nor Daytona's answer", async (t) => {
  const daytona = await fakeDaytona(t, takes("the-key-daytona-takes"));
  const key = `${CANARY}-${DAYTONA_KEY}`;
  const registry = await boxRegistry({ AGENTRUN_BOXES: "daytona", [DAYTONA_KEY]: key, DAYTONA_API_URL: daytona.url });
  assert.deepEqual(offerOf(registry, "daytona"), { id: "daytona", available: false, reason: "Daytona refused DAYTONA_API_KEY" });
  assert.equal(registry.provider("daytona"), undefined);
  assert.equal(daytona.seen.length, 1, "a refused key is not tried again");
});

test("the VM provider listed: without its token it needs it, and without its SDK it says to install it", async (t) => {
  let installed = true;
  try {
    import.meta.resolve(VM);
  } catch {
    installed = false;
  }
  if (installed) return t.skip(`the ${VM} SDK is installed here`);
  const tokenless = await boxRegistry({ AGENTRUN_BOXES: VM, [VM_PROVIDER.keys[0]]: "x" });
  assert.deepEqual(offerOf(tokenless, VM), { id: VM, available: false, reason: `needs ${VM_PROVIDER.keys[1]}` });
  const none = await boxRegistry({ AGENTRUN_BOXES: VM });
  assert.deepEqual(offerOf(none, VM), { id: VM, available: false, reason: `needs ${VM_PROVIDER.keys.join(" and ")}` });
  const registry = await boxRegistry({ AGENTRUN_BOXES: VM, ...keys() });
  assert.deepEqual(offerOf(registry, VM), { id: VM, available: false, reason: `install ${VM} to use this box` });
  assert.equal(registry.provider(VM), undefined);
});

test("the VM provider with its SDK: the client gets the token as arguments, not from the environment, and nothing is asked of it at start", async (t) => {
  // A process of its own, where a resolve hook makes the SDK's name a fake: the workspace's own modules stay as they are.
  const dir = await scratch(t);
  const values = keys();
  await writeFile(join(dir, "sdk.mjs"), `export const ${VM_PROVIDER.client} = class {
  constructor(params) { (globalThis.clients ??= []).push({ params, inEnv: ${JSON.stringify(VM_PROVIDER.keys)}.filter((name) => name in process.env) }); }
  get apps() { throw new Error("asked at start"); }
  get sandboxes() { throw new Error("asked at start"); }
};\n`);
  await writeFile(join(dir, "hooks.mjs"), `export async function resolve(specifier, context, next) {
  return specifier === ${JSON.stringify(VM)} ? { url: ${JSON.stringify(pathToFileURL(join(dir, "sdk.mjs")).href)}, shortCircuit: true } : next(specifier, context);
}\n`);
  await writeFile(join(dir, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(join(dir, "hooks.mjs")).href)});\n`);
  const script = `const { boxRegistry } = await import(${JSON.stringify(new URL("../dist/boxes.js", import.meta.url).href)});
const registry = await boxRegistry({ AGENTRUN_BOXES: ${JSON.stringify(VM)}, AGENTRUN_BOX_APP: "boxes-test", ...${JSON.stringify(values)} });
process.stdout.write(JSON.stringify({ offers: registry.offers(), provider: registry.provider(${JSON.stringify(VM)})?.name, clients: globalThis.clients }));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !BOX_KEYS.includes(name)));
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ["--import", join(dir, "register.mjs"), "--input-type=module", "-e", script], { env }, (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))));
  const seen = JSON.parse(out);
  assert.deepEqual(seen.offers.find((offer) => offer.id === VM), { id: VM, available: true, reason: "configured; not probed at start" });
  assert.equal(seen.provider, VM);
  const [tokenId, tokenSecret] = VM_PROVIDER.keys.map((name) => values[name]);
  assert.deepEqual(seen.clients, [{ params: { tokenId, tokenSecret }, inEnv: [] }], "one client, given the token");
});

test("no key's value is in an offer, a reason or the start's log line, which says which boxes the server has and why the listed ones are not there", async (t) => {
  const values = keys();
  const docker = await fakeDocker(t, FAILS);
  const daytona = await fakeDaytona(t, takes("the-key-daytona-takes"));
  withEnv(t, { PATH: docker.PATH, AGENTRUN_BOXES: `docker,daytona,${VM}`, DAYTONA_API_URL: daytona.url, ...values });
  const lines = [];
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, log: (line) => lines.push(line) });
  t.after(() => server.close());
  const registry = await boxRegistry({ ...process.env });
  const boxes = lines.filter((line) => / event=boxes /.test(line));
  assert.equal(boxes.length, 1, lines.join("\n"));
  assert.match(boxes[0], new RegExp(` available=none unavailable=${BOX_IDS.join(",")} docker="docker version failed \\(exit 1\\): [^"]+" ${VM}="(needs|install) [^"]+" daytona="Daytona refused DAYTONA_API_KEY"$`));
  const said = JSON.stringify([registry.offers(), lines]);
  for (const [name, value] of Object.entries(values)) assert.ok(!said.includes(value) && !said.includes(CANARY), `${name}'s value is said nowhere`);
  assert.ok(!said.includes("RAW-"), "no answer's body and no command's output");
});

test("a box key set in the server's environment reaches no run's process: not in its environment, not on its pipe, while the server still reads it", async () => {
  const values = keys();
  const control = `${CANARY}-OPENAI_API_KEY`;
  const script = `const { childEnv, RUN_SECRETS } = await import(${JSON.stringify(new URL("../dist/runs.js", import.meta.url).href)});
const { handover, secret, SECRET_NAMES } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const names = ${JSON.stringify(BOX_KEYS)};
process.stdout.write(JSON.stringify({ env: childEnv(process.env, "the-server-token"), handed: handover(RUN_SECRETS).toString("utf8"), runSecrets: RUN_SECRETS, secretNames: SECRET_NAMES, held: names.filter((name) => secret(name) !== undefined) }));`;
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...values, OPENAI_API_KEY: control } }, (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))));
  const seen = JSON.parse(out);
  for (const [name, value] of Object.entries(values)) {
    assert.ok(!(name in seen.env) && !Object.values(seen.env).some((v) => v.includes(value)), `${name} is not in a run's environment`);
    assert.ok(!seen.runSecrets.includes(name) && !seen.handed.includes(name) && !seen.handed.includes(value), `${name} is not handed to a run's process`);
    assert.ok(seen.secretNames.includes(name), `${name} is on the launcher's list of secrets, which the server holds`);
  }
  assert.deepEqual(seen.held, BOX_KEYS, "the server reads every box key");
  assert.ok(seen.handed.includes(`OPENAI_API_KEY=${control}`), "a run's own secret is still handed over its pipe");
});
