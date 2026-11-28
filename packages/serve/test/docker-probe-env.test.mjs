// serve asks Docker itself, outside any computer: whether a daemon answers (place-offers.ts askDockerDaemon and the
// docker box's probe), which daemon the CLI reaches (box-paths.ts remoteDockerOf, the same call reads the data
// volume's mounts), and the Docker host's addresses (docker-host-addresses.ts readHostAddresses). Each of those docker
// CLI calls starts with the names docker reads alone (@parcha/agentrun-computer's DOCKER_ENV_NAMES), as every docker
// call the computer package makes does: not the server's whole environment with its secrets cut out. A stand-in
// `docker`, first on PATH, writes its environment to a file named in its own text, so each call's is read back whole.
import assert from "node:assert/strict";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DOCKER_ENV_NAMES } from "@parcha/agentrun-computer";
import { remoteDockerOf } from "../dist/box-paths.js";
import { readHostAddresses } from "../dist/docker-host-addresses.js";
import { askDockerDaemon, placeOffers } from "../dist/place-offers.js";
import { scratch } from "./support.mjs";

/** A stand-in `docker` in `bin`: dumps its environment to `dumps/docker.<n>.env`, then answers what each probe asks. */
async function standIn(bin, dumps) {
  const script = [
    "#!/bin/sh",
    `n=0; while [ -e "${dumps}/docker.$n.env" ]; do n=$((n+1)); done`,
    `/usr/bin/env > "${dumps}/docker.$n.env"`,
    'case "$1" in',
    '  version) echo "27.0.0 amd64" ;;',
    "  context) echo '\"unix:///var/run/docker.sock\"' ;;",
    "  run) echo '[]' ;;",
    "esac",
    "",
  ].join("\n");
  await writeFile(join(bin, "docker"), script);
  await chmod(join(bin, "docker"), 0o755);
}

/** The names each dumped environment holds, the shell's own (PWD, SHLVL, _) aside, one set per docker call. */
async function namesOf(dumps) {
  const files = (await readdir(dumps)).filter((one) => one.endsWith(".env")).sort();
  return Promise.all(files.map(async (file) => new Set((await readFile(join(dumps, file), "utf8")).split("\n").filter(Boolean).map((line) => line.slice(0, line.indexOf("="))).filter((name) => !["PWD", "OLDPWD", "SHLVL", "_"].includes(name)))));
}

test("serve's own docker probes (the daemon check, the box's probe, the CLI's endpoint, the host's addresses) start docker with the names it reads alone, not the server's other names", async (t) => {
  const bin = await scratch(t);
  const home = await scratch(t);
  const dumps = await scratch(t);
  await standIn(bin, dumps);
  // Docker's own names, one a probe reads (DOCKER_CONTEXT) and one a pull's credential helper does (GNUPGHOME), beside
  // names that are no secret and that docker never reads: the server's own settings, a session's, a host's.
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    DOCKER_CONTEXT: "probe-walk",
    GNUPGHOME: join(home, ".gnupg"),
    AGENTRUN_PROBE_CANARY: "canary-value",
    AGENT_MODEL_FAST: "faux:fast",
    CLAUDE_CODE_SESSION_LABEL: "session-label",
  };
  const groups = { file: "/dev/null", user: "nobody", ids: [] };
  const container = { where: "host" };

  assert.deepEqual(await askDockerDaemon(env, AbortSignal.timeout(10_000), groups, container), { up: true });
  const offers = await placeOffers(env, { groups, container, timeoutMs: 10_000 });
  assert.equal(offers.find((one) => one.id === "docker")?.available, true, "the docker box's probe ran and answered");
  assert.equal(await remoteDockerOf(env), undefined, "the CLI's endpoint is this machine's");
  assert.ok("addresses" in (await readHostAddresses(env, undefined, 10_000, "agentrun-host-read-probe")), "the host's addresses were read");

  const calls = await namesOf(dumps);
  assert.ok(calls.length >= 4, `every probe called docker (${calls.length} calls)`);
  for (const [n, names] of calls.entries()) assert.ok(names.has("DOCKER_CONTEXT") && names.has("GNUPGHOME") && names.has("PATH"), `call ${n} holds docker's own names: ${[...names].sort().join(" ")}`);
  const others = calls.map((names) => [...names].filter((name) => !DOCKER_ENV_NAMES.includes(name)).sort());
  assert.deepEqual(others, calls.map(() => []), "no docker call holds a name docker doesn't read");
});
