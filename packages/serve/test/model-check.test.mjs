// A gateway this host cannot reach is said when the server starts and when a definition is saved, with its address and
// the fix, not 15 s into a run's first request as "Connection error.". The check asks GET {base}/models: no model runs
// and nothing is spent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gatewayProblem } from "../dist/model.js";
import { agent, flowAgent, responsesEndpoint, scratch, serve, withEnv } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const GATEWAY_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A loopback address no server listens on: a port taken, then let go. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A gateway answering every request with `status`, the requests it was sent kept. */
async function answering(t, status) {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push({ line: `${req.method} ${req.url}`, authorization: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked };
}

test("the check: a closed port names the address, the cause and the fix; a refused key says so; any other answer is reachable", async (t) => {
  const base = `http://127.0.0.1:${await closedPort()}/v1`;
  const closed = await gatewayProblem({ AGENT_MODEL_BASE_URL: `${base}/` });
  assert.match(closed, new RegExp(`^The model gateway at ${base} \\(AGENT_MODEL_BASE_URL\\) does not answer: ECONNREFUSED\\.`));
  assert.match(closed, /Start the gateway, or set AGENT_MODEL_BASE_URL/);
  assert.match(closed, /--network host/, "a loopback address says what it means in a container");
  const listed = await answering(t, 200);
  assert.equal(await gatewayProblem({ AGENT_MODEL_BASE_URL: listed.url, AGENT_MODEL_API_KEY: "k-1" }), undefined);
  assert.deepEqual(listed.asked, [{ line: "GET /v1/models", authorization: "Bearer k-1" }], "one GET of its models, with its key");
  assert.equal(await gatewayProblem({ AGENT_MODEL_BASE_URL: (await answering(t, 404)).url }), undefined, "a gateway with no /models still answers");
  const refused = await answering(t, 401);
  assert.match(await gatewayProblem({ AGENT_MODEL_BASE_URL: refused.url, AGENT_MODEL_API_KEY: "bad" }), /refused AGENT_MODEL_API_KEY \(HTTP 401\): set AGENT_MODEL_API_KEY/);
  assert.match(await gatewayProblem({ AGENT_MODEL_BASE_URL: refused.url }), /refused a request with no key \(HTTP 401\)/);
  assert.match(await gatewayProblem({ AGENT_MODEL_BASE_URL: (await answering(t, 403)).url, AGENT_MODEL_API_KEY: "bad" }), /refused AGENT_MODEL_API_KEY \(HTTP 403\)/);
  const withUser = await gatewayProblem({ AGENT_MODEL_BASE_URL: base.replace("http://", "http://user:s3cret@") });
  assert.match(withUser, new RegExp(`^The model gateway at ${base} `), "the address is said without its user and password");
  assert.doesNotMatch(withUser, /s3cret|user:/);
  assert.match(withUser, /ECONNREFUSED/, "it asks the address without them");
  assert.equal(await gatewayProblem({ AGENT_MODEL_BASE_URL: "not a url s3cret" }), "AGENT_MODEL_BASE_URL is not a URL: set it to the gateway's address, such as its https://.../v1.");
  assert.equal(await gatewayProblem({}), undefined, "no gateway, nothing to check");
  assert.equal(await gatewayProblem({ AGENT_MODEL_BASE_URL: base, AGENTRUN_SERVE_FAUX: "/faux.mjs" }), undefined, "the faux models need no gateway");
});

test("a gateway that never answers is unreachable after the check's timeout, not after a run's", async (t) => {
  const silent = createServer(() => {});
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (silent.closeAllConnections(), silent.close(resolve))));
  const why = await gatewayProblem({ AGENT_MODEL_BASE_URL: `http://127.0.0.1:${silent.address().port}/v1` }, 200);
  assert.match(why, /no answer in 0\.2 s/);
});

test("a save while the gateway is unreachable is kept, with a warning naming its address", async (t) => {
  const base = `http://127.0.0.1:${await closedPort()}/v1`;
  withEnv(t, { AGENT_MODEL_BASE_URL: base, AGENT_MODEL: "m-1" }, GATEWAY_VARS);
  const { api } = await serve(t, { faux: undefined });
  const saved = await api("POST", "/agents", agent("far"));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.model", "not_set_up_here"]]);
  assert.match(saved.body.warnings[0].message, new RegExp(`The model gateway at ${base} \\(AGENT_MODEL_BASE_URL\\) does not answer`));
  const flow = await api("POST", "/agents", flowAgent("far-flow"));
  assert.equal(flow.status, 201, JSON.stringify(flow.body));
  assert.deepEqual(flow.body.warnings.map((w) => [w.field, w.reason]), [["definition.workflow", "not_set_up_here"]]);
  // A workflow with no model node never asks the gateway, so it saves with no warning.
  const In = { type: "object", required: ["question"], properties: { question: { type: "string" } } };
  const gate = { v: 2, name: "gate", schemas: { In }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" }, root: { node: "chain", steps: [{ node: "escalate", label: "gate", when: { predicate: "field_equals", path: "question", value: "stop" }, kind: "review", stage: "check", summary: "asked to stop" }] } };
  const modelless = await api("POST", "/agents", flowAgent("no-model", gate));
  assert.deepEqual([modelless.status, modelless.body.warnings], [201, []], JSON.stringify(modelless.body));
});

test("a save while the gateway answers has no warning, and the gateway is asked only GET /models", async (t) => {
  const endpoint = await responsesEndpoint(t, "42", 1);
  withEnv(t, { AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL: "m-1" }, GATEWAY_VARS);
  const { api } = await serve(t, { faux: undefined });
  const near = await api("POST", "/agents", agent("near"));
  assert.deepEqual([near.status, near.body.warnings], [201, []], JSON.stringify(near.body));
  assert.ok(endpoint.asked.length > 0 && endpoint.asked.every((line) => line === "GET /models"), `the checks at start and at the save run no model: ${endpoint.asked}`);
});

test("the server started with a gateway it cannot reach says so on stderr, naming the address and the fix", async (t) => {
  const base = `http://127.0.0.1:${await closedPort()}/v1`;
  const data = join(await scratch(t), "agents");
  const env = { ...process.env, AGENT_MODEL_BASE_URL: base, AGENT_MODEL: "m-1" };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !err.includes("does not answer"); i++) {
    assert.ok(i < 200 && child.exitCode === null, `no word of the gateway: ${err}`);
    await sleep(50);
  }
  assert.match(err, new RegExp(`^agentrun-serve: The model gateway at ${base} \\(AGENT_MODEL_BASE_URL\\) does not answer: ECONNREFUSED\\.`, "m"));
  assert.match(err, /Start the gateway, or set AGENT_MODEL_BASE_URL/);
  assert.equal(child.exitCode, null, "it is said, and the server goes on");
});
