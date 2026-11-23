// Fly.io (deploy/fly/fly.toml and launch.sh) and a DigitalOcean Droplet's user data (deploy/digitalocean/user-data.sh),
// with neither account: fly.toml runs the image the release pins the way the image runs itself, on one Machine that is
// never stopped, its data on a volume at /data; launch.sh, against a stand-in `fly`, makes the token and the seal key
// once, hands them to Fly on stdin alone and shows them nowhere; and the user data is the README's --vps line.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { tokenProblem } from "../dist/api-token.js";
import { sealKeyOf } from "../dist/tool-keys.js";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const fly = parseToml(await read("deploy/fly/fly.toml"));
const LAUNCH = fileURLToPath(new URL("deploy/fly/launch.sh", ROOT));
const FLY_TOML = fileURLToPath(new URL("deploy/fly/fly.toml", ROOT));

test("fly.toml pins this release's image, the same as render.yaml and the Coolify template", async () => {
  const { version } = JSON.parse(await read("packages/serve/package.json"));
  const image = `ghcr.io/parcha-ai/agentrun-server:v${version}`;
  assert.equal(fly.build.image, image);
  assert.equal(/^ {6}url: (\S+)$/m.exec(await read("render.yaml"))?.[1], image);
  assert.equal(parseYaml(await read("deploy/coolify/agentrun.yaml")).services.agentrun.image, image);
  assert.deepEqual(Object.keys(fly.build), ["image"], "the published image, no build");
});

test("the image's own command, its data on one volume at /data, port 7340 and GET /v2/health", async () => {
  const dockerfile = await read("packages/serve/docker/Dockerfile");
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)[1]);
  const port = Number(/^EXPOSE (\d+)$/m.exec(dockerfile)[1]);
  assert.equal(port, 7340);
  assert.equal(Number(cmd[cmd.indexOf("--port") + 1]), port);
  assert.equal(cmd[cmd.indexOf("--data") + 1], "/data");
  assert.equal(fly.app, undefined, "no app name: launch.sh names it with -a, so the file stays as committed");
  assert.equal(fly.processes, undefined, "the image's command");
  assert.equal(fly.experimental, undefined, "the image's entrypoint and command");
  const mounts = [fly.mounts].flat();
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].destination, "/data");
  assert.match(mounts[0].source, /^[a-z0-9_]+$/);
  assert.equal(fly.http_service.internal_port, port);
  assert.equal(fly.services, undefined, "one service, the http_service");
  const health = /healthCheckPath: (\S+)/.exec(await read("render.yaml"))[1];
  assert.equal(health, "/v2/health");
  assert.deepEqual(fly.http_service.checks.map((c) => [c.method ?? "GET", c.path]), [["GET", health]]);
});

test("the Machine is never stopped: a scheduled agent keeps running with no one visiting", () => {
  const s = fly.http_service;
  assert.equal(s.auto_stop_machines, "off", "Fly Proxy never stops it");
  assert.ok(s.min_machines_running >= 1, "and one is kept running");
  // The runner drains for 6 s, then hands its runs back for up to 25 s more; Fly's default is SIGINT and 5 s.
  assert.equal(fly.kill_signal, "SIGTERM");
  assert.ok(fly.kill_timeout >= 31 && fly.kill_timeout <= 300, `kill_timeout ${fly.kill_timeout}`);
});

test("one Machine on one volume: a deploy replaces it in place and never boots a second beside it", async () => {
  // canary and bluegreen boot a new Machine beside the old one (with a fresh, empty volume); rolling, one at a time,
  // updates the one Machine on its own volume.
  assert.deepEqual({ ...fly.deploy }, { strategy: "rolling", max_unavailable: 1 });
  // The first deploy runs one Machine, not Fly's default two: --ha=false (and Fly runs one for a group with a volume).
  assert.match(await readFile(LAUNCH, "utf8"), /^fly deploy .*--ha=false/m);
});

test("fly.toml holds no secret: the token and the seal key are Fly secrets", () => {
  assert.deepEqual(Object.keys(fly.env ?? {}).sort(), ["AGENTRUN_RUN_USER"]);
  assert.equal(fly.env.AGENTRUN_RUN_USER, "same", "as on Render and Railway");
});

// A stand-in for flyctl: it keeps the app, the secrets' names, the volume's region and what it was given (its arguments,
// its environment, the secrets imported) in $FAKE, outside the script's directories, so the test can see the values the
// script made. `--json` answers in flyctl's shapes: `secrets list` an array of {name, digest, status}
// (internal/command/secrets/list.go), `volumes list` an array of fly-go's Volume ({id, name, state, region, ...}).
// FAKE_LIST: `fails` (an empty list on stdout, but exit 1: only the exit status says it failed), `stderr` (the names on stderr, nothing on stdout, exit 0), `table` (a table on stdout) or `Name` (the JSON list, its key spelled `Name`: a flyctl whose shape changed).
const FAKE_FLY = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/argv.log"
env >> "$FAKE/env.log"
case $1 in
  status) [ -f "$FAKE/app" ]; exit ;;
  apps) [ "$2" = create ] && : > "$FAKE/app"; exit 0 ;;
  volumes)
    if [ -f "$FAKE/volume" ]; then
      printf '[\n  {\n    "id": "vol_1",\n    "name": "agentrun_data",\n    "state": "created",\n    "size_gb": 10,\n    "region": "%s",\n    "attached_machine_id": "m_1"\n  }\n]\n' "$(cat "$FAKE/volume")"
    else
      printf '[]\n'
    fi
    exit 0 ;;
  secrets)
    case $2 in
      list)
        mode=$FAKE_LIST
        case $mode in
          fails) printf '[]\n'; echo "Error: failed to list secrets" >&2; exit 1 ;;
          stderr) [ ! -f "$FAKE/names" ] || cat "$FAKE/names" >&2; exit 0 ;;
          table) printf 'NAME\tDIGEST\n'; [ ! -f "$FAKE/names" ] || sed 's/$/\tdeadbeef/' "$FAKE/names"; exit 0 ;;
        esac
        printf '['
        sep=
        if [ -f "$FAKE/names" ]; then
          key=name; [ "$mode" != Name ] || key=Name
          while IFS= read -r n; do printf '%s\n  {\n    "%s": "%s",\n    "digest": "deadbeef",\n    "status": "Deployed"\n  }' "$sep" "$key" "$n"; sep=,; done < "$FAKE/names"
        fi
        printf '\n]\n' ;;
      import) while IFS= read -r line; do printf '%s\n' "$line" >> "$FAKE/imported"; printf '%s\n' "$line" | sed 's/=.*//' >> "$FAKE/names"; done ;;
    esac
    exit 0 ;;
  deploy)
    prev=
    for arg in "$@"; do
      [ "$prev" != --primary-region ] || [ -f "$FAKE/volume" ] || printf '%s' "$arg" > "$FAKE/volume"
      prev=$arg
    done
    exit 0 ;;
  logs) printf '%s\n' 'app[1] iad [info] agentrun-serve: Set up this server: https://my-agents.fly.dev/setup#code=FAKECODE' ;;
esac
exit 0
`;

async function stage(t) {
  const dir = await mkdtemp(join(tmpdir(), "fly-launch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "fake");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const d of [fake, bin, home]) await mkdir(d);
  await writeFile(join(bin, "fly"), FAKE_FLY);
  await chmod(join(bin, "fly"), 0o755);
  const launch = (args, { env = {}, shell = [] } = {}) =>
    promisify(execFile)("sh", [...shell, LAUNCH, ...args], {
      cwd: home,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: home, FAKE: fake, ...env },
    });
  const argv = async () => (await readFile(join(fake, "argv.log"), "utf8")).trim().split("\n");
  const imported = async () =>
    Object.fromEntries((await readFile(join(fake, "imported"), "utf8")).trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { fake, home, launch, argv, imported };
}

const made = (lines) => lines.filter((l) => /^(apps|secrets import|deploy)/.test(l));
const deployIn = (region) => `deploy -a my-agents -c ${FLY_TOML} --primary-region ${region} --ha=false --yes`;

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}

test("launch.sh makes the token and the seal key once, from openssl, gives them to Fly on stdin, and shows or writes them nowhere", async (t) => {
  const { fake, home, launch, argv, imported } = await stage(t);
  // Lowercase variables of the same names in the caller's environment, and a shell tracing every command: neither may
  // carry a value out (an exported `seal` would take the key into fly's environment; `sh -x` would print the printf).
  const first = await launch(["my-agents"], { env: { token: "from-caller", seal: "from-caller", url: "from-caller" }, shell: ["-x"] });
  const values = await imported();
  assert.deepEqual(Object.keys(values).sort(), ["AGENTRUN_PUBLIC_URL", "AGENTRUN_SEAL_KEY", "AGENTRUN_TOKEN"]);
  assert.match(values.AGENTRUN_TOKEN, /^[0-9a-f]{64}$/, "openssl rand -hex 32");
  assert.equal(tokenProblem(values.AGENTRUN_TOKEN), undefined);
  assert.equal(sealKeyOf(values.AGENTRUN_SEAL_KEY)?.length, 32, "openssl rand -base64 32");
  assert.equal(values.AGENTRUN_PUBLIC_URL, "https://my-agents.fly.dev/");

  const calls = await argv();
  assert.deepEqual(made(calls), ["apps create my-agents", "secrets import --stage -a my-agents", deployIn("iad")]);
  assert.ok(calls.includes("secrets list -a my-agents --json"), "the names from flyctl's JSON, never its table");
  assert.match(first.stdout, /Set up this server: https:\/\/my-agents\.fly\.dev\/setup#code=FAKECODE/);

  const again = await launch(["my-agents", "iad"]);
  const calls2 = (await argv()).slice(calls.length);
  assert.deepEqual(made(calls2), [deployIn("iad")], "a second run makes no app and no secret: the seal key is kept, so what it sealed still opens");

  const secrets = [values.AGENTRUN_TOKEN, values.AGENTRUN_SEAL_KEY];
  const env = await readFile(join(fake, "env.log"), "utf8");
  for (const out of [first.stdout, first.stderr, again.stdout, again.stderr, calls.join("\n"), calls2.join("\n"), env]) {
    for (const s of secrets) assert.ok(!out.includes(s), "never printed or traced, never on a command line, never in fly's environment");
  }
  const files = [...(await filesUnder(home)), ...(await filesUnder(fileURLToPath(new URL("deploy/fly/", ROOT))))];
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const s of secrets) assert.ok(!text.includes(s), `never written to a file (${f})`);
  }
});

test("launch.sh never makes a seal key over one Fly has: a list that fails, or names it can't read, stop it before any import", async (t) => {
  for (const mode of ["fails", "stderr", "table", "Name"]) {
    const { fake, launch, argv, imported } = await stage(t);
    await launch(["my-agents"]);
    const before = await imported();
    const calls = (await argv()).length;
    await assert.rejects(launch(["my-agents"], { env: { FAKE_LIST: mode } }), /secrets/, mode);
    assert.deepEqual(await imported(), before, `${mode}: nothing imported, so the seal key Fly holds is still the one`);
    assert.deepEqual(made((await argv()).slice(calls)), [], `${mode}: no import and no deploy`);
    // A first run whose list can't be read makes nothing either (a first `Name` list is `[]`, which reads: no secrets).
    if (mode === "Name") continue;
    const fresh = await stage(t);
    await assert.rejects(fresh.launch(["my-agents"], { env: { FAKE_LIST: mode } }), /secrets/, mode);
    await assert.rejects(readFile(join(fresh.fake, "imported")), { code: "ENOENT" }, mode);
  }
});

test("a run with no region deploys where the volume is; one naming another region is refused, so no volume is left behind", async (t) => {
  const { launch, argv } = await stage(t);
  await launch(["my-agents", "fra"]);
  assert.deepEqual(made(await argv()).at(-1), deployIn("fra"));
  await launch(["my-agents"]);
  assert.deepEqual(made(await argv()).at(-1), deployIn("fra"), "the volume's region, not iad");
  const calls = (await argv()).length;
  await assert.rejects(launch(["my-agents", "iad"]), /fra/);
  assert.deepEqual(made((await argv()).slice(calls)), [], "no deploy");
  // The volume the script looks for is the one fly.toml mounts.
  assert.match(await readFile(LAUNCH, "utf8"), new RegExp(`"name":"${[fly.mounts].flat()[0].source}"`));
});

test("launch.sh refuses an app name Fly would not take, before it calls fly", async (t) => {
  const { fake, launch } = await stage(t);
  await assert.rejects(launch(["My Agents"]), /app name/);
  await assert.rejects(launch([]), /app name/);
  await assert.rejects(readFile(join(fake, "argv.log")), { code: "ENOENT" });
});

// The README's section, from its heading to the next.
function section(readme, heading) {
  const start = readme.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, heading);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
}

test("the Droplet's user data runs the README's --vps line, and nothing else", async () => {
  const readme = await read("deploy/README.md");
  const rent = section(readme, "One command on a server you rent");
  const vps = /```sh\n(curl -fsSL https:\/\/agentrun\.ai\/install \| sh -s -- --vps)\n```/.exec(rent)?.[1];
  assert.ok(vps, "the section's command");
  const userData = await read("deploy/digitalocean/user-data.sh");
  // pipefail: a download that fails leaves sh an empty script, which exits 0; the pipeline then fails with curl.
  assert.deepEqual(userData.split("\n"), ["#!/bin/bash", "set -o pipefail", vps, ""]);
  assert.ok(rent.includes("```sh\n" + userData + "```"), "the README shows the file as it is");
});

test("the Droplet's user data fails when the installer's download fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "user-data-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A curl that fails before writing a byte, as `curl -f` does on a 404 or no network.
  await writeFile(join(dir, "curl"), "#!/bin/sh\nexit 22\n");
  await chmod(join(dir, "curl"), 0o755);
  const run = promisify(execFile)("bash", [fileURLToPath(new URL("deploy/digitalocean/user-data.sh", ROOT))], {
    env: { PATH: `${dir}:${process.env.PATH}` },
  });
  await assert.rejects(run, (e) => e.code === 22);
});

test("the README's Fly section runs launch.sh and says what it costs and when that was read", async () => {
  const flySection = section(await read("deploy/README.md"), "Fly.io");
  assert.match(flySection, /sh deploy\/fly\/launch\.sh <app name>/);
  assert.match(flySection, /\$\d+(\.\d\d)? a month/);
  assert.match(flySection, /20\d\d-\d\d-\d\d/);
  assert.match(flySection, /no shell/);
  // Until a deploy on a real account shows it works, the section says so, and names the line a volume the server can't
  // write would print (start.sh's, for the image's user).
  assert.match(flySection, /has not yet run on a real Fly account/);
  assert.match(flySection, /`\/data is not writable by uid 1000 \.\.\.`/);
  assert.match(await read("packages/serve/docker/start.sh"), /say "\$data is not writable by uid \$\(id -u\)/);
  assert.match(await read("packages/serve/docker/Dockerfile"), /^RUN groupadd --gid 1000 node && useradd --uid 1000 /m);
});
