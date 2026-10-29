// Running the server as an operator does: a stop inside the platform's grace, a token link that survives any token, one
// stdout line per request, run and refused credential (never a token), and the stored token printed only once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, withEnv } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const DOCKER = new URL("../docker/", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = processAlive;
/** A token with every character a query string bends: "+" (a space in a form), "/" and "=". */
const AWKWARD = "Ab+cD/ef=Gh+iJ/kl=Mn+oP/qr=St+uV/wx==";

/** The bin on `data`, its stdout kept; resolves once it printed its banner. */
async function bin(t, data, args = [], env = {}) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  for (let i = 0; !/^Open /m.test(seen.out); i++) {
    assert.ok(i < 200 && child.exitCode === null, `the server did not start: ${seen.out}${seen.err}`);
    await sleep(50);
  }
  const base = /AGENTRUN_BASE_URL=(\S+)/.exec(seen.out)[1];
  return { child, seen, base, exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))) };
}

test("on SIGTERM with a run busy, the bin exits within its --drain-timeout, and the run goes on at the next start", { timeout: 90_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const go = join(data, "..", "go");
  const server = await bin(t, data, ["--drain-timeout", "2s"]);
  const token = (await readFile(join(data, ".token"), "utf8")).trim();
  const api = client(server.base, token);
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${go} exists.` } });
  await follow(api, run.run_id, ["working"]);
  const pid = JSON.parse(await readFile(join(data, "runs", run.run_id, "run.json"), "utf8")).holder.pid;
  const from = Date.now();
  server.child.kill("SIGTERM");
  const code = await Promise.race([server.exited, sleep(40_000).then(() => "still running")]);
  const took = Date.now() - from;
  assert.equal(code, 0, server.seen.err);
  assert.ok(took < 2_000 + 3_000, `it exited ${took} ms after SIGTERM, past its 2 s drain`);
  assert.equal(alive(pid), false, "the run's process exited with it");
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  const again = client(next.baseUrl, next.token);
  await writeFile(go, "");
  await follow(again, run.run_id, ["completed"]);
  assert.equal((await again("GET", `/runs/${run.run_id}`)).body.result.final_answer, "Now.");
});

test("the image drains within Docker's 10 s grace, and Compose gives the stop more than the drain", async () => {
  const dockerfile = await readFile(new URL("Dockerfile", DOCKER), "utf8");
  const drain = /"--drain-timeout", "(\d+)s"/.exec(dockerfile);
  assert.ok(drain, "the image's CMD names its drain");
  assert.ok(Number(drain[1]) < 10, `the image drains ${drain[1]} s`);
  const compose = await readFile(new URL("compose.yaml", DOCKER), "utf8");
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
  // A wrong token is no link: the console's public page, with no cookie set.
  for (const [query, why] of [[`token=${encodeURIComponent(AWKWARD.replace("Ab", "Zz"))}`, "another token"], [`token=${AWKWARD.replaceAll("+", "-")}`, "only a space stands for +"]]) {
    const res = await open(query);
    assert.equal(res.status, 200, why);
    assert.equal(res.headers.get("set-cookie"), null, why);
  }
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

const LINE = /^at=\S+ event=(request|auth_failed|run_started|run_ended)( [a-z_]+=("[^"]*"|\S+))*$/;
const fields = (line) => Object.fromEntries([...line.matchAll(/([a-z_]+)=("[^"]*"|\S+)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));

test("one log line per request (method, path without its query, status, ms), per run start and end, and per refused credential; never a token", async (t) => {
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
  const wrongLink = await fetch(`${server.url}/?token=${server.token.slice(0, 20)}`, { redirect: "manual" });
  assert.deepEqual([wrongLink.status, wrongLink.headers.get("set-cookie")], [200, null], "a wrong link is the public page, with no cookie");
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
});

test("AGENTRUN_LOG=quiet turns the request lines off; run and refused-credential lines stay", async (t) => {
  withEnv(t, { AGENTRUN_LOG: "quiet" });
  const lines = [];
  const server = await startServe({ data: join(await scratch(t), "agents"), port: 0, faux: FAUX, log: (line) => lines.push(line) });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  await client(server.baseUrl)("GET", "/runs");
  assert.deepEqual(lines.map((line) => fields(line).event), ["run_started", "run_ended", "auth_failed"]);
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

test("a run whose process crashes at its start fails with the crash in words, never the log's raw JSON", async (t) => {
  const server = await startServe({ data: join(await scratch(t), "agents"), port: 0, faux: new URL("./fixtures/faux-broken.mjs", import.meta.url).pathname });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  await api("POST", "/agents", agent("broken"));
  const { body: run } = await api("POST", "/agents/broken/runs", { input: { content: "hi" } });
  await follow(api, run.run_id, ["failed"]);
  const { error } = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(error.code, "run_failed");
  assert.match(error.message, /has no default export function/);
  assert.doesNotMatch(error.message, /[{}]|"at":|"event":/, error.message);
});
