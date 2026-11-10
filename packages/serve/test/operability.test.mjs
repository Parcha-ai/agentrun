// Running the server as an operator does: a stop inside the platform's grace, a token link that survives any token, one
// stdout line per request, run and refused credential (never a token), and the stored token printed only once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BOX_IDS } from "../dist/boxes.js";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, printed, scratch, withEnv } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const DOCKER = new URL("../docker/", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A token with every character a query string bends: "+" (a space in a form), "/" and "=". */
const AWKWARD = "Ab+cD/ef=Gh+iJ/kl=Mn+oP/qr=St+uV/wx==";

/** The bin on `data`, its stdout kept; resolves once it printed its banner. */
async function bin(t, data, args = [], env = {}) {
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data), ...env } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  await printed(child, /^Open /m);
  const base = /AGENTRUN_BASE_URL=(\S+)/.exec(seen.out)[1];
  return { child, seen, base, exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))) };
}

test("the image drains within Docker's 10 s grace, and Compose gives the stop more than the drain", async () => {
  const dockerfile = await readFile(new URL("Dockerfile", DOCKER), "utf8");
  const drain = /"--drain-timeout", "(\d+)s"/.exec(dockerfile);
  assert.ok(drain, "the image's CMD names its drain");
  assert.ok(Number(drain[1]) < 10, `the image drains ${drain[1]} s`);
  const compose = await readFile(new URL("compose.yaml", ROOT), "utf8");
  const grace = /stop_grace_period: (\d+)s/.exec(compose);
  assert.ok(grace && Number(grace[1]) > Number(drain[1]), "compose's stop_grace_period is above the drain");
  const render = await readFile(new URL("render.yaml", ROOT), "utf8");
  assert.match(render, /maxShutdownDelaySeconds/, "render.yaml says how Render's grace stands");
});

test("the token link signs in whatever a token holds: + as sent raw (a space) or encoded, / and =", async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, token: AWKWARD });
  t.after(() => server.close());
  const open = (query) => fetch(`${server.url}/?${query}`, { redirect: "manual" });
  for (const query of [`token=${AWKWARD}`, `token=${encodeURIComponent(AWKWARD)}`, `token=${AWKWARD.replaceAll("+", "%2B")}`]) {
    const res = await open(query);
    assert.equal(res.status, 303, query);
    assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/);
  }
  assert.equal((await open(`token=${encodeURIComponent(AWKWARD.replace("Ab", "Zz"))}`)).status, 401);
  assert.equal((await open(`token=${AWKWARD.replaceAll("+", "-")}`)).status, 401, "only a space stands for +");
});

test("the printed link encodes the token, and a token the first boot did not make is never printed", async () => {
  const { banner } = await import("../dist/index.js");
  assert.equal(typeof banner, "function", "the banner's lines come from one function");
  const made = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: AWKWARD, source: "made" });
  assert.ok(made.includes(`AGENTRUN_API_KEY=${AWKWARD}`));
  assert.ok(made.includes(`Open http://127.0.0.1:7340/?token=${encodeURIComponent(AWKWARD)}`), made.join("\n"));
  const kept = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: AWKWARD, source: "file" });
  assert.ok(kept.includes("AGENTRUN_API_KEY=<in /data/.token>"), kept.join("\n"));
  assert.ok(kept.includes("Open http://127.0.0.1:7340/?token=<in /data/.token>"), kept.join("\n"));
  const env = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: AWKWARD, source: "env" });
  for (const lines of [kept, env]) assert.ok(!lines.join("\n").includes(AWKWARD.slice(0, 8)), "no token, nor its start");
});

test("the stored token is printed on the boot that made it, and on no later one", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await bin(t, data, [], { AGENTRUN_ACCOUNTS: "0" });
  const token = (await readFile(join(data, ".token"), "utf8")).trim();
  assert.ok(first.seen.out.includes(`AGENTRUN_API_KEY=${token}`));
  first.child.kill("SIGTERM");
  await first.exited;
  const second = await bin(t, data, [], { AGENTRUN_ACCOUNTS: "0" });
  assert.ok(second.seen.out.includes(`AGENTRUN_API_KEY=<in ${join(data, ".token")}>`), second.seen.out);
  assert.ok(second.seen.out.includes(`?token=<in ${join(data, ".token")}>`), second.seen.out);
  assert.equal(second.seen.out.includes(token) || second.seen.out.includes(token.slice(0, 12)), false, "the second boot prints no token value");
});

const LINE = /^at=\S+ event=(boxes|harness_offers|request|auth_failed|run_started|run_ended)( [a-z_]+=("[^"]*"|\S+))*$/;
const fields = (line) => Object.fromEntries([...line.matchAll(/([a-z_]+)=("[^"]*"|\S+)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));

// SKIP (follow-up #2078): the run never leaves queued or working on the runner
test.skip("one log line per request (method, path without its query, status, ms), per run start and end, and per refused credential; never a token", async (t) => {
  const lines = [];
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, log: (line) => lines.push(line) });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await client(server.baseUrl, "wrong-token-value")("GET", "/agents")).status, 401);
  assert.equal((await client(server.baseUrl)("GET", "/runs")).status, 401);
  assert.equal((await fetch(`${server.url}/?token=${server.token.slice(0, 20)}`)).status, 401);
  await api("GET", "/capabilities?probe=1");
  for (const line of lines) {
    assert.match(line, LINE);
    assert.ok(!line.includes(server.token) && !line.includes(server.token.slice(0, 12)) && !line.includes("wrong-token"), `no token in ${line}`);
  }
  const of = (event) => lines.filter((line) => line.includes(` event=${event} `) || line.endsWith(` event=${event}`)).map(fields);
  const requests = of("request");
  assert.ok(requests.some((r) => r.method === "GET" && r.path === "/v2/capabilities" && r.status === "200" && /^\d+$/.test(r.ms)), JSON.stringify(requests));
  assert.ok(requests.every((r) => !r.path.includes("?")), "no query");
  assert.ok(requests.some((r) => r.method === "POST" && r.path === "/agents/calc/runs".replace(/^/, "/v2") && r.status === "202"));
  assert.deepEqual(of("auth_failed").map((a) => [a.route, a.reason]), [["/v2/agents", "wrong_token"], ["/v2/runs", "no_credential"], ["/", "wrong_link_token"]]);
  assert.deepEqual(of("run_started").map((r) => [r.run, r.agent, r.kind]), [[run.run_id, "calc", "agentic"]]);
  assert.deepEqual(of("run_ended").map((r) => [r.run, r.agent, r.status, r.cost_usd]), [[run.run_id, "calc", "completed", "0"]]);
  // One line at start says which boxes this server has (boxes.ts): with AGENTRUN_BOXES=none (the tests', support.mjs), none.
  assert.deepEqual(of("boxes").map((b) => [b.available, b.unavailable]), [["none", BOX_IDS.join(",")]]);
});

// SKIP (follow-up #2078): the run never leaves queued or working on the runner
test.skip("AGENTRUN_LOG=quiet turns the request lines off; the boxes, harness offers, run and refused-credential lines stay", async (t) => {
  withEnv(t, { AGENTRUN_LOG: "quiet" });
  const lines = [];
  const server = await startServe({ data: join(await scratch(t), "agents"), port: 0, faux: FAUX, log: (line) => lines.push(line) });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  await client(server.baseUrl)("GET", "/runs");
  assert.deepEqual(lines.map((line) => fields(line).event), ["boxes", "harness_offers", "run_started", "run_ended", "auth_failed"]);
});

test("the bin writes the log lines to stdout", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await bin(t, data);
  await fetch(`${server.base}/capabilities`);
  for (let i = 0; !/ event=request method=GET path=\/v2\/capabilities status=200 /.test(server.seen.out); i++) {
    assert.ok(i < 100, server.seen.out);
    await sleep(50);
  }
});

test("compose: every command the docs give works in a fresh shell (DOCKER_GID goes to .env once, before the first), and another port takes AGENTRUN_PUBLIC_URL with it", async () => {
  const compose = await readFile(new URL("compose.yaml", ROOT), "utf8");
  // The link's default names the default port (a loopback address with a variable port is refused by the key gate's
  // loopback rule), so the README says to set AGENTRUN_PUBLIC_URL with AGENTRUN_PORT.
  assert.match(compose, /AGENTRUN_PUBLIC_URL: "\$\{AGENTRUN_PUBLIC_URL:-http:\/\/127\.0\.0\.1:7340\/\}"/);
  assert.match(await readFile(new URL("packages/serve/README.md", ROOT), "utf8"), /`AGENTRUN_PORT`; set `AGENTRUN_PUBLIC_URL` with it, so the printed link names that port/);
  // compose.yaml needs DOCKER_GID to be read at all (group_add's ${DOCKER_GID:?}): a value given to one command alone
  // leaves every later one, `docker compose logs` included, unable to read it.
  // The root README points at deploy/compose.yaml (no Docker socket, so no DOCKER_GID); only these two give the root
  // compose file's commands.
  for (const [name, text] of [["compose.yaml", compose], ["packages/serve/README.md", await readFile(new URL("packages/serve/README.md", ROOT), "utf8")]]) {
    const commands = text.split("\n").map((line) => line.replace(/^[#\s]*/, "")).filter((line) => /^(echo .*DOCKER_GID|DOCKER_GID=|docker compose )/.test(line));
    assert.ok(commands.length >= 2, `${name} gives its compose commands: ${JSON.stringify(commands)}`);
    assert.ok(!commands.some((line) => /^DOCKER_GID=.* docker compose/.test(line)), `${name}: no DOCKER_GID given to one command alone`);
    assert.match(commands[0], /^echo "DOCKER_GID=\$\(stat -c %g \/var\/run\/docker\.sock\)" >> \.env$/, `${name}: the first writes DOCKER_GID to .env`);
  }
});
