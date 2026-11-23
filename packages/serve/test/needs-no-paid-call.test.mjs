// A run whose sandbox lacks a program its agent needs (computer.needs) spends nothing: the real server and runner, a faux
// model priced per request whose first turn calls fal's run_model, and a fake MCP server saved with the toolkit `fal`.
// Where the box lacks the program, the run fails with no model request, no fal call and no cost; where it has it, the
// same agent and input reach the model and send the job, so the first case's silence is the check's, not the setup's.
// The Docker box is a stand-in over the run's folder (no Docker runs), whose exec answers `command -v` from `has`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const RUN_MODEL = "mcp:fal/run_model";
const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const JOB = 'Call mcp__fal__run_model with {"endpoint_id":"fal-ai/ideogram/v3","input":{"rendering_speed":"TURBO","prompt":"a title card"},"submission_key":"card-20261121-1"}';

/** The `sh` the check runs: the names after `sh -c <script> sh`. */
const checked = (argv) => (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "sh" ? argv.slice(4) : undefined);

/** Docker's stand-in, for any provider id the runner loads: a box over the run's folder whose PATH has `has`. */
function dockerBox(has) {
  const made = [];
  const released = [];
  const execs = [];
  const provider = {
    id: "docker",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push({ ref, computer: fakeComputer(spec.mount.path, { exec: (params) => {
        const missing = (checked(params.argv) ?? []).filter((name) => !has.includes(name));
        return { exitCode: 0, stdout: Buffer.from(missing.map((name) => `${name}\n`).join("")), stderr: new Uint8Array(0), timedOut: false, truncated: false };
      } }) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      const client = {
        async call(method, params, options) {
          if (method === "exec.run") execs.push(params.argv);
          return one.computer.client.call(method, params, options);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      released.push(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return { made, released, execs, load: async () => provider };
}

/** One capped run of an agent that needs hyperframes, on a box that has `has`: the run's read, the fake fal's calls, the box. */
async function filmRun(t, has) {
  // A `docker` first on PATH that answers the server's probe, so a Docker sandbox is one this server offers.
  const bin = join(await scratch(t), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 27.0.0-fake; exit 0; fi\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: `${bin}:${process.env.PATH}` }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE"]);
  const box = dockerBox(has);
  const { api } = await serve(t, { faux: FAUX, computers: { load: box.load } });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.03, unit: "images", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  fake.tools.run_model = { description: "Run a fal model.", input: { type: "object", properties: {} }, run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: "r1", result: { images: [{ url: "https://v3.fal.media/1.png" }] }, has_result: true }) }] }) };
  const saved = await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await api("POST", "/agents", agent("film", { tools: ["bash", RUN_MODEL], tool_settings: { [RUN_MODEL]: { permission: "allow" } }, computer: { kind: "sandbox", provider: "docker", needs: ["hyperframes"] } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/film/runs", { input: { content: JOB }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const usage = (await api("GET", `/runs/${run.body.run_id}/usage`)).body;
  const falCalls = fake.log.filter((entry) => entry.method === "tools/call");
  return { view, usage, falCalls, box };
}

test("a box that lacks a program the agent needs: the run fails with no model request, no fal call and nothing spent", { timeout: 120_000 }, async (t) => {
  const { view, usage, falCalls, box } = await filmRun(t, []);
  // What was spent first, so a run that went on is caught by what it spent, not only by how it ended.
  assert.deepEqual(falCalls, [], "no fal tool was called, not even its price's read");
  assert.equal(view.cost.tokens?.requests ?? 0, 0, "no model request was made");
  assert.equal(view.cost.tools_usd ?? 0, 0, "no tool was charged");
  assert.deepEqual(usage.lines.filter((line) => line.meter === "model" || line.meter === "tools"), [], "/usage: no model or tool line");
  assert.equal(view.status, "failed", JSON.stringify(view.error));
  assert.equal(view.error.code, "run_failed", JSON.stringify(view.error));
  assert.match(view.error.message, /lacks hyperframes, which the agent needs \(computer\.needs\), so nothing ran\./);
  assert.deepEqual(box.execs.map(checked), [["hyperframes"]], "the box was asked, once");
  assert.deepEqual(box.released, ["c1"], "the box was let go");
});

test("the same agent and input on a box that has the program reach the model and send the fal job", { timeout: 120_000 }, async (t) => {
  const { view, falCalls, box } = await filmRun(t, ["hyperframes"]);
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.deepEqual(box.execs.filter(checked).map(checked), [["hyperframes"]]);
  assert.equal(falCalls.filter((entry) => entry.tool === "run_model").length, 1, "the job was sent once");
  assert.ok(view.cost.tokens.requests >= 1, "the model was asked");
  assert.ok(view.cost.tools_usd > 0, "the job was charged");
});
