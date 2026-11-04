// A fake `docker` for run-box.test.mjs, run by a `docker` script first on PATH: it never reaches a daemon. Each call's
// arguments go to `$FAKE_DOCKER_STATE/argv.jsonl`, and each container is a file under `containers/`. `exec` runs the
// command on this machine, the container's mount targets mapped to their sources and its `--env` its whole environment
// (with a TMPDIR of its own), so pi-transport's box environment works over it. Like Docker's, a killed `exec` client
// leaves its command running. With `fail-run` in the state directory, `run` leaves a running container behind and fails,
// as a client cut off while the daemon made the container would.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const state = process.env.FAKE_DOCKER_STATE;
if (!state) {
  process.stderr.write("fake docker: FAKE_DOCKER_STATE is not set\n");
  process.exit(1);
}
const args = process.argv.slice(2);
const containers = join(state, "containers");
mkdirSync(containers, { recursive: true });
appendFileSync(join(state, "argv.jsonl"), `${JSON.stringify(args)}\n`);

const file = (id) => join(containers, `${id}.json`);
const read = (id) => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf8")) : undefined);
const save = (container) => {
  writeFileSync(`${file(container.Id)}.tmp`, JSON.stringify(container));
  renameSync(`${file(container.Id)}.tmp`, file(container.Id));
};
const all = () => readdirSync(containers).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(containers, name), "utf8")));
const done = (text = "", code = 0) => {
  process.stdout.write(text);
  process.exit(code);
};
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

switch (args[0]) {
  case "version":
    done("27.0.0-fake\n");
    break;
  case "run": {
    const container = { Id: randomBytes(32).toString("hex"), State: { Running: true, ExitCode: 0 }, Config: { Labels: {} }, HostConfig: { NetworkMode: "default" }, env: [], mounts: [], workdir: "/" };
    for (let i = 1; i < args.length; i++) {
      const value = args[i + 1];
      if (args[i] === "--label") {
        const at = value.indexOf("=");
        container.Config.Labels[value.slice(0, at)] = value.slice(at + 1);
        i++;
      } else if (args[i] === "--env") container.env.push(args[++i]);
      else if (args[i] === "--mount") {
        const fields = Object.fromEntries(value.split(",").map((part) => [part.split("=")[0], part.slice(part.indexOf("=") + 1)]));
        container.mounts.push({ source: fields.source, target: fields.target });
        i++;
      } else if (args[i] === "--workdir") container.workdir = args[++i];
      else if (args[i] === "--network") container.HostConfig.NetworkMode = args[++i];
      else if (args[i] === "--cap-drop") (container.HostConfig.CapDrop ??= []).push(args[++i]);
      else if (args[i] === "--security-opt") (container.HostConfig.SecurityOpt ??= []).push(args[++i]);
      else if (args[i] === "--user") container.Config.User = args[++i];
    }
    container.Config.Env = container.env;
    container.Mounts = container.mounts.map((mount) => ({ Type: "bind", Source: mount.source, Destination: mount.target, RW: true }));
    save(container);
    if (existsSync(join(state, "fail-run"))) fail("docker: Error response from daemon: the fake's start failed.", 125);
    done(`${container.Id}\n`);
    break;
  }
  case "ps": {
    const filters = [];
    for (let i = 1; i < args.length; i++) if (args[i] === "--filter") filters.push(args[++i].replace(/^label=/, ""));
    const matches = (labels) => filters.every((filter) => (filter.includes("=") ? labels[filter.slice(0, filter.indexOf("="))] === filter.slice(filter.indexOf("=") + 1) : filter in labels));
    done(all().filter((c) => c.State.Running && matches(c.Config.Labels)).map((c) => `${c.Id}\n`).join(""));
    break;
  }
  case "inspect": {
    const container = read(args.at(-1));
    if (!container) fail(`Error: No such object: ${args.at(-1)}`);
    // `--format {{json .}}` gives the object; without it Docker answers a list.
    done(`${JSON.stringify(args.includes("--format") ? container : [container])}\n`);
    break;
  }
  case "rm": {
    const id = args.at(-1);
    if (!read(id)) fail(`Error response from daemon: No such container: ${id}`);
    rmSync(file(id));
    done(`${id}\n`);
    break;
  }
  case "exec": {
    let i = 1;
    let workdir;
    for (; args[i]?.startsWith("-"); i++) if (args[i] === "-w") workdir = args[++i];
    const container = read(args[i]);
    if (!container) fail(`Error response from daemon: No such container: ${args[i]}`);
    const command = args.slice(i + 1);
    const map = (text) => container.mounts.reduce((mapped, mount) => mapped.split(mount.target).join(mount.source), text);
    const tmp = join(state, "tmp", container.Id.slice(0, 12));
    mkdirSync(tmp, { recursive: true });
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: tmp, ...Object.fromEntries(container.env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])) };
    const child = spawn(map(command[0]), command.slice(1).map(map), { cwd: map(workdir ?? container.workdir), env, stdio: "inherit" });
    child.once("error", () => fail(`OCI runtime exec failed: ${command[0]}: not found`, 127));
    child.once("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 1)));
    break;
  }
  default:
    fail(`fake docker: no ${args[0]}`);
}
