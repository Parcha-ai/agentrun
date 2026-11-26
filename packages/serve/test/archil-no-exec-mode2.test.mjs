// A Mode 2 server whose Archil region has no serverless exec (gcp-us-central1: https://docs.archil.com/reference/regions)
// gives a run with no computer no shell, so a new agent with bash and no computer is refused at its save, told to name a
// sandbox computer and why (the region), never saved with a shell that never runs: on the runner, Archil's every exec
// would answer "Exec is not enabled", and Docker's box can't mount Archil. capabilities' places.default_place, its bash
// and GET /v2/computers' no-computer shell say the same. A region with exec (aws-us-east-1) is untouched: the runner and
// Archil's exec, as before. Mode 2 comes from AGENTRUN_ARCHIL_REGION, as hosted servers set it; a fake `docker` first on
// PATH answers the start's probe or doesn't, so no Docker command runs here, and no Archil call is made.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { scratch, serve, withEnv } from "./support.mjs";

const UNSET = ["AGENTRUN_SEAL_KEY", "AGENTRUN_BOXES", "DOCKER_HOST", "DOCKER_CONTEXT", "ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"];
const NO_EXEC = /gcp-us-central1 has no serverless exec/;
const SANDBOX = /sandbox computer/;

/** A server in Mode 2 on Archil region `region` (its environment's), on a fake `docker` that answers or not. */
async function server(t, { region, docker }) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  const version = docker ? "echo 27.0.0-fake; exit 0" : "echo 'Cannot connect to the Docker daemon' >&2; exit 1";
  await writeFile(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then ${version}; fi\nexit 0\n`, { mode: 0o755 });
  await chmod(join(bin, "docker"), 0o755);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: [bin, process.env.PATH].join(delimiter), AGENTRUN_ARCHIL_REGION: region, ARCHIL_API_KEY: "fake-test-key" }, UNSET);
  return (await serve(t, { faux: undefined, runner: false, accounts: true, openSetup: true })).api;
}

/** A new agent as `agentrun deploy` and the agent form send it: tools, no place, no computer. */
const fresh = (id, tools) => ({ definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], ...(tools ? { tools } : {}) } });

const noComputer = async (api) => (await api("GET", "/computers")).body.kinds.find((kind) => kind.kind === "none");

for (const docker of [true, false]) {
  const label = docker ? "Docker answering" : "no Docker";

  test(`Mode 2 on gcp-us-central1, ${label}: a new agent with bash and no computer is refused, naming a sandbox computer and the region, and nothing is saved`, async (t) => {
    const api = await server(t, { region: "gcp-us-central1", docker });
    const made = await api("POST", "/agents", fresh("gcp-bash", ["read", "write", "bash"]));
    assert.equal(made.status, 422, JSON.stringify(made.body));
    const fields = made.body.error.fields;
    assert.deepEqual(fields.map((one) => one.field), ["definition.computer"], JSON.stringify(fields));
    assert.match(fields[0].message, SANDBOX);
    assert.match(fields[0].message, NO_EXEC);
    assert.doesNotMatch(JSON.stringify(made.body), /"box":"docker"/, "never told to take Docker's box");
    assert.equal((await api("GET", "/agents/gcp-bash")).status, 404, "not saved, on the runner or on Docker's box");
    // No tools named would give it bash: refused alike.
    const unnamed = await api("POST", "/agents", fresh("gcp-unnamed"));
    assert.equal(unnamed.status, 422, JSON.stringify(unnamed.body));
    assert.match(unnamed.body.error.fields[0].message, NO_EXEC);
    // One with no shell tool runs on the runner, as before.
    const files = await api("POST", "/agents", fresh("gcp-files", ["read", "write"]));
    assert.equal(files.status, 201, JSON.stringify(files.body));
    assert.equal("place" in files.body.definition, false);
  });

  test(`Mode 2 on gcp-us-central1, ${label}: an agent that names no computer and bash on the runner is refused for bash, in words that name the region and a sandbox computer`, async (t) => {
    const api = await server(t, { region: "gcp-us-central1", docker });
    for (const setting of [{ computer: { kind: "none" } }, { place: { mode: "runner" } }]) {
      const made = await api("POST", "/agents", { definition: { ...fresh(`gcp-${Object.keys(setting)[0]}`, ["read", "bash"]).definition, ...setting } });
      assert.equal(made.status, 422, JSON.stringify(made.body));
      const bash = made.body.error.fields.find((one) => one.field === "definition.tools[1]");
      assert.ok(bash, JSON.stringify(made.body.error.fields));
      assert.match(bash.message, NO_EXEC);
      assert.match(bash.message, SANDBOX);
      assert.doesNotMatch(bash.message, /docker box is unavailable|"box": ?"docker"/);
    }
  });

  test(`Mode 2 on gcp-us-central1, ${label}: capabilities give no default place and no bash, and GET /v2/computers' no computer has no shell, each saying why`, async (t) => {
    const api = await server(t, { region: "gcp-us-central1", docker });
    const caps = (await api("GET", "/capabilities")).body;
    assert.equal(caps.places.default_place, null, JSON.stringify(caps.places));
    assert.match(caps.places.default_reason, NO_EXEC);
    assert.match(caps.places.default_reason, SANDBOX);
    const bash = caps.tools.find((tool) => tool.name === "bash");
    assert.equal(bash.available, false, JSON.stringify(bash));
    assert.match(bash.reason, NO_EXEC);
    const none = await noComputer(api);
    assert.deepEqual([none.shell, none.host_tools], ["none", ["read", "write", "edit"]], JSON.stringify(none));
    assert.match(none.shell_note, NO_EXEC);
    assert.match(none.shell_note, SANDBOX);
  });

  test(`Mode 2 on aws-us-east-1, ${label}: untouched, a new agent with bash and no computer saves on the runner, whose shell is Archil's exec`, async (t) => {
    const api = await server(t, { region: "aws-us-east-1", docker });
    const caps = (await api("GET", "/capabilities")).body;
    assert.deepEqual(caps.places.default_place, { mode: "runner" }, JSON.stringify(caps.places));
    assert.equal("default_reason" in caps.places, false);
    assert.equal(caps.tools.find((tool) => tool.name === "bash").available, true);
    const none = await noComputer(api);
    assert.deepEqual([none.shell, none.host_tools], ["local", ["read", "write", "edit", "bash"]], JSON.stringify(none));
    assert.equal(none.shell_note, "No computer: bash runs in a fresh container on the folder's own storage; background commands need a computer.");
    const made = await api("POST", "/agents", fresh("aws-bash", ["read", "write", "bash"]));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal("place" in made.body.definition, false, "no place stamped: the runner");
    assert.equal("computer" in made.body.definition, false);
  });
}
