// A server's docker children hold what docker reads of the server's environment and never a key the server holds: a
// server started with a key-shaped variable in its environment runs an agent in the Docker box, and every docker call the
// Docker provider makes for that run (run, inspect, exec of computerd, rm) is started without it, and with PATH, HOME
// and DOCKER_HOST as the server has them. Over the computer package's fake docker first on PATH (docker-host-fake.mjs),
// which records each call's environment; no Docker is reached.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerHost } from "./docker-host-fake.mjs";
import { follow, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const DOCKER = { mode: "sandbox", box: "docker" };
const KEY = "FOO_API_KEY";
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
const NO_COMPUTERD_FILE = !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)";

test("a server with a key in its environment runs an agent in the Docker box: no docker call for the run holds the key, and each has PATH, HOME and DOCKER_HOST", { timeout: 120_000, skip: NO_COMPUTERD_FILE }, async (t) => {
  const host = dockerHost({ computerd: true });
  // The default socket's address, named: the fake answers in its place, and the server's own probe reads the same.
  const dockerHostValue = "unix:///var/run/docker.sock";
  withEnv(t, { PATH: `${host.dir}:${process.env.PATH}`, DOCKER_HOST: dockerHostValue, [KEY]: `not-a-secret-${"canary"}` }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW", "DAYTONA_API_KEY"]);
  const { api } = await serve(t, { faux: PROBE });
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe." } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.place, DOCKER, "a new agent lands in the Docker box, docker being on by default");
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "true" } }] }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.deepEqual(run.body.place, DOCKER);
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  // Every call that reached the fake behind the host's own answers: the provider's run, inspect, exec and rm.
  const envs = host.fake.envs();
  assert.ok(envs.some(({ args }) => args[0] === "run" && args.includes(`agentrun.run=${run.body.run_id}`)), `the run's computer was made in Docker: ${JSON.stringify(envs.map(({ args }) => args[0]))}`);
  assert.ok(envs.some(({ args }) => args[0] === "exec"), "its computerd was reached through docker exec");
  for (const { args, names, seen } of envs) {
    const call = `docker ${args.slice(0, 2).join(" ")}`;
    assert.ok(!names.includes(KEY), `${KEY} reached ${call}`);
    assert.deepEqual([seen.PATH, seen.HOME, seen.DOCKER_HOST], [process.env.PATH, process.env.HOME, dockerHostValue], `${call} has PATH, HOME and DOCKER_HOST as the server has them`);
  }
});

test("Settings → Computers' Docker test runs docker with PATH, HOME and DOCKER_HOST as the server has them, and no key", { timeout: 60_000 }, async (t) => {
  const host = dockerHost();
  const dockerHostValue = "unix:///var/run/docker.sock";
  withEnv(t, { PATH: `${host.dir}:${process.env.PATH}`, DOCKER_HOST: dockerHostValue, [KEY]: `not-a-secret-${"canary"}` }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW", "DAYTONA_API_KEY"]);
  // Not --faux: Settings → Computers is the package's own providers, Docker's among them.
  const { api } = await serve(t, { faux: undefined });
  const tested = await api("POST", "/computers/docker/test");
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  const listed = host.fake.envs().filter(({ args }) => args[0] === "ps");
  assert.ok(listed.length > 0, `the test's docker ps reached the docker first on the server's PATH: ${JSON.stringify(tested.body)}`);
  for (const { args, names, seen } of listed) {
    const call = `docker ${args.slice(0, 2).join(" ")}`;
    assert.ok(!names.includes(KEY), `${KEY} reached ${call}`);
    assert.deepEqual([seen.PATH, seen.HOME, seen.DOCKER_HOST], [process.env.PATH, process.env.HOME, dockerHostValue], `${call} has PATH, HOME and DOCKER_HOST as the server has them`);
  }
});
