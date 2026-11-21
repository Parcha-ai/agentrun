// The public-host guard (pi-browser publicFetch) holds where a run's web tools actually run once runners are split from the
// server: in a run's own process, on a runner started apart (`agentrun-serve runner`, beside a `--no-runner` server), with
// the real resolver and network, no faux web. An agent that asks web_fetch for loopback, a private range,
// carrier-grade NAT, the cloud metadata address (as IPv4, IPv4-mapped IPv6 and AWS's IPv6), a unique-local address and
// GCP's metadata name is refused each time, in the guard's words, and nothing listening on this machine's loopback is
// reached. web_save dials through the same hops (publicDownload; web-save.test.mjs). On Postgres the runner has a data directory of its own, as a runner on a machine apart from its server does
// (the shared-nothing shape the runner split ships); on SQLite it shares the server's, the store being a file there.
//
// Also: the operator's bound on owner-allowed private hosts (AGENTRUN_PRIVATE_HOSTS) is read and said by that runner at
// its start, and inherited by its runs' processes (runner/main.ts runEnv), where MCP and calendar calls dial.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { client, FAUX, follow, printed, scratch } from "./support.mjs";
import { dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"g".repeat(40)}`;
const SEAL = Buffer.alloc(32, 9).toString("base64");

/** Each URL a page could steer an agent to that reaches the operator's own network, by address or by name. */
const PRIVATE_URLS = [
  "http://127.0.0.1/",
  "http://10.0.0.5/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[fd00:ec2::254]/latest/meta-data/",
  "http://[fc00::1]/",
  "http://metadata.google.internal/computeMetadata/v1/",
];

function cli(t, args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  return child;
}

/** A server on loopback that counts every request it is sent: none may come. */
async function loopbackTrap(t) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.end("reached");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/`, hits: () => hits };
}

async function guardOnRunnerApart(t, { postgres }) {
  const schema = postgres ? await freshSchema() : undefined;
  if (schema) t.after(() => dropSchema(schema));
  const root = await scratch(t);
  const data = join(root, "server-data");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_TOKEN: TOKEN,
    AGENTRUN_SEAL_KEY: SEAL,
    ...(schema ? { AGENTRUN_STORE_URL: PG_URL, AGENTRUN_STORE_SCHEMA: schema } : {}),
  };
  const server = cli(t, ["--data", data, "--port", "0", "--faux", FAUX, "--no-runner"], env);
  const out = await printed(server, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  const trap = await loopbackTrap(t);
  // The loopback server on its own port too: refused on its port before its address is read, and never reached.
  const urls = [...PRIVATE_URLS, trap.url];
  assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["web_fetch"], place: { mode: "runner" } } })).status, 201);
  const fetchRun = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify(urls)}` } });
  assert.equal(fetchRun.status, 202, JSON.stringify(fetchRun.body));

  // The runner apart: on Postgres a data directory of its own; the operator's bound set in its environment alone.
  const runnerData = schema ? join(root, "runner-data") : data;
  const runner = cli(t, ["runner", "--data", runnerData, "--faux", FAUX], { ...env, AGENTRUN_RUNNER_NAME: "runner-apart", AGENTRUN_PRIVATE_HOSTS: "none" });
  const err = [];
  createInterface({ input: runner.stderr }).on("line", (line) => err.push(line));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 60 s: ${err.join("\n")}`)), 60_000);
    createInterface({ input: runner.stdout }).on("line", (line) => {
      if (/^Runner runner-apart ready: /.test(line)) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    runner.once("exit", () => reject(new Error(`the runner exited before ready: ${err.join("\n")}`)));
  });

  for (const [run, tool, asked] of [[fetchRun, "web_fetch", urls]]) {
    const { last, rows } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
    const read = (await api("GET", `/runs/${run.body.run_id}`)).body;
    assert.equal(last.status, "completed", `${tool}'s run ended ${last.status}: ${JSON.stringify(read)}\n${err.join("\n")}`);
    // The server runs no runner (--no-runner): the runner apart ran it.
    const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_result_preview);
    assert.equal(results.length, asked.length, `${tool}: one result per URL: ${JSON.stringify(results)}`);
    results.forEach((result, i) => {
      const host = new URL(asked[i]).hostname.replace(/^\[|\]$/g, "");
      const words = new URL(asked[i]).port ? new RegExp(`refused: port ${new URL(asked[i]).port} is not 80 or 443`) : new RegExp(`refused: ${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a public host`);
      assert.match(result, words, `${tool} ${asked[i]}: ${result}`);
    });
  }
  assert.equal(trap.hits(), 0, "nothing on this machine's loopback was reached");
  assert.ok(err.some((line) => /AGENTRUN_PRIVATE_HOSTS=none: an owner's private-network hosts for MCP servers and calendars are never allowed on this runner/.test(line)), `the runner says the operator's bound at its start: ${err.join("\n")}`);
}

test("on a runner apart from its server (SQLite, one data directory), web_fetch refuses every private, loopback, link-local, carrier-grade NAT and metadata address, and the runner says the operator's private-host bound", { timeout: 180_000 }, (t) => guardOnRunnerApart(t, { postgres: false }));

test("on a runner apart from its server with a data directory of its own (Postgres), web_fetch refuses every private, loopback, link-local, carrier-grade NAT and metadata address", { ...postgresOnly("a runner apart on the shared store"), timeout: 180_000 }, (t) => guardOnRunnerApart(t, { postgres: true }));
