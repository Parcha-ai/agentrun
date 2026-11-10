// A fake `docker` for the box tests, run by a `docker` script first on PATH: it never reaches a daemon. Each call's
// arguments go to `$FAKE_DOCKER_STATE/argv.jsonl`, and each container is a file under `containers/`. `exec` runs the
// command on this machine, the container's mount targets mapped to their sources (one with no mount at /workspace has a
// /workspace of its own under the state directory, never this machine's) and its `--env` its whole environment
// (with a TMPDIR of its own), so pi-transport's box environment works over it. Like Docker's, a killed `exec` client
// leaves its command running. With `fail-run` in the state directory, `run` leaves a running container behind and fails,
// as a client cut off while the daemon made the container would.
//
// Images, each a file under `images/` with its labels: Docker has every image it pulled or built there, and, until the
// state directory holds `no-image`, any other image but the server's own (`agentrun-box:*`), with no labels. `image
// inspect --format {{json .Config.Labels}}` prints an image's labels, or says there is no such image (in Podman's words
// with `podman-words`). A `pull` holds while `pull-hold` is there, and with `pull-fail` it fails, its stderr the file's
// text (Docker's own words); a `build` reads its context directory's Dockerfile, is noted in `builds.jsonl`, and holds
// and fails the same way with `build-hold` and `build-fail`; with `build-fail-once`, only the next build fails, with that
// file's text, and the mark goes. Each `run` is noted in `made.jsonl`, `pulledInRun` when Docker had no image then, as
// Docker would pull it there, inside the call; for the server's own image (`agentrun-box:*`), which no registry has, that
// pull fails, and `run` with it, in Docker's words.
// `info` answers as a daemon on this Linux machine (its kernel), or as `docker-info` says, or, with `docker-runtime` naming
// one of RUNTIMES, as that runtime's daemon does, each field of `--format` filled in from its own `docker info` (quoted
// from each runtime's own pasted output: see RUNTIMES).
// Named volumes (`volume create`, `inspect`, `rm`) are directories under /tmp (volumeDir), their options and labels noted in
// `volumes.jsonl`; a `--mount type=volume` maps its target there. A `--mount type=volume` with a `volume-subpath`, or of
// a volume `volumes.json` in the state directory names, is the directory that file names for it, and the subpath below it.
// A container may have a `--name`, which `inspect`, `logs`
// and `rm` take as well as its id (a second with a taken name is refused, as Docker refuses it). The proxy container (label
// `agentrun.egress`) is RUN here: its `node` command, its mounts mapped, in a process group of its own, its output its
// `docker logs`, with `--import $FAKE_DOCKER_EGRESS_PRELOAD` when that is set (the tests' fake network); `rm` kills it.
// `ps --all` lists stopped containers too.
// An `exec` of the box's network relay (socat) is noted, never run here (`no-socat`, `no-setsid` or `relay-dead` in the
// state directory: an image without one, or a relay that never listened).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, release } from "node:os";
import { join } from "node:path";
import { sudoStandIn } from "./sudo-stand-in.mjs";

/** What each runtime's `docker info` says, field by field, as its users pasted it: Docker Desktop for Mac
 *  (docker/for-mac#7791), OrbStack (orbstack/orbstack#1902), colima (abiosoft/colima#1450), Rancher Desktop on a Mac
 *  (rancher-sandbox/rancher-desktop#9866). */
export const RUNTIMES = {
  "docker-desktop": { OSType: "linux", KernelVersion: "6.10.14-linuxkit", DockerRootDir: "/var/lib/docker", OperatingSystem: "Docker Desktop", Name: "docker-desktop" },
  orbstack: { OSType: "linux", KernelVersion: "6.13.7-orbstack-00283-g9d1400e7e9c6", DockerRootDir: "/var/lib/docker", OperatingSystem: "OrbStack", Name: "orbstack" },
  // colima's OperatingSystem is its VM's distro; detection keys on Name, not on this.
  colima: { OSType: "linux", KernelVersion: "6.8.0-64-generic", DockerRootDir: "/var/lib/docker", OperatingSystem: "Debian GNU/Linux 12 (bookworm)", Name: "colima" },
  "rancher-desktop": { OSType: "linux", KernelVersion: "6.6.119-0-virt", DockerRootDir: "/var/lib/docker", OperatingSystem: "Alpine Linux v3.23", Name: "lima-rancher-desktop" },
};

const state = process.env.FAKE_DOCKER_STATE;
if (!state) {
  process.stderr.write("fake docker: FAKE_DOCKER_STATE is not set\n");
  process.exit(1);
}
const args = process.argv.slice(2);
const containers = join(state, "containers");
mkdirSync(containers, { recursive: true });
/** Notes one record, a line of JSON, in the state directory's `name`, as a reader in another process sees it come:
 *  the file made empty first, then the line. With `torn-writes` there, the line goes in two halves 300 ms apart, so a
 *  test's reader meets a half-written line as it can on a busy machine. */
const note = (name, record) => {
  const file = join(state, name);
  const line = `${JSON.stringify(record)}\n`;
  if (!existsSync(join(state, "torn-writes"))) return appendFileSync(file, line);
  appendFileSync(file, line.slice(0, line.length >> 1));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  appendFileSync(file, line.slice(line.length >> 1));
};
note("argv.jsonl", args);

const file = (id) => join(containers, `${id}.json`);
const byId = (id) => (/^[0-9a-f]{64}$/.test(id) && existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf8")) : undefined);
const read = (ref) => byId(ref) ?? all().find((c) => c.Name === ref);
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

/** A volume's directory: short, under /tmp, by the state directory and the name, so a Unix socket in it stays within a
 *  socket path's limit (107 bytes) wherever the state directory is. The test that made the state removes it. */
const volumeDir = (name) => join("/tmp", `fdv-${createHash("sha256").update(`${state}\0${name}`).digest("hex").slice(0, 12)}`);

/** A process's command line, as `ps` gives it, or "" when there is no such process. */
const commandOf = (pid) => {
  const answer = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return answer.status === 0 ? answer.stdout : "";
};

const images = join(state, "images");
const imageFile = (name) => join(images, `${encodeURIComponent(name)}.json`);
const hasImage = (name) => existsSync(imageFile(name)) || (!existsSync(join(state, "no-image")) && !name.startsWith("agentrun-box:"));
const labelsOf = (name) => (existsSync(imageFile(name)) ? JSON.parse(readFileSync(imageFile(name), "utf8")).labels : null);
const keepImage = (name, labels) => (mkdirSync(images, { recursive: true }), writeFileSync(imageFile(name), JSON.stringify({ labels })));
/** Runs `then` once `mark` is gone from the state directory, or fails with `fail`'s text when that is there. */
const held = (mark, failMark, then) => {
  const go = () => {
    if (existsSync(join(state, mark))) return void setTimeout(go, 25);
    if (existsSync(join(state, failMark))) fail(readFileSync(join(state, failMark), "utf8").trim() || "Error response from daemon: the fake failed");
    then();
  };
  go();
};

switch (args[0]) {
  case "version":
    // The probe's `{{.Server.Version}}`; `{{.Server.APIVersion}}` as Docker Engine 27 gives it, or as `docker-api` there says.
    if (args.some((arg) => arg.includes("APIVersion"))) done(existsSync(join(state, "docker-api")) ? readFileSync(join(state, "docker-api"), "utf8") : "1.47\n");
    done("27.0.0-fake\n");
    break;
  case "info": {
    // `docker info --format {{.OSType}}|{{.KernelVersion}}|{{.DockerRootDir}}|{{.OperatingSystem}}`: a daemon of this
    // Linux machine's own (its kernel, and its state directory as its data root), or what `docker-info` there says; it fails with `docker-info-fail`'s text, and with
    // `docker-info-hold` it never answers.
    if (existsSync(join(state, "docker-info-hold"))) setInterval(() => {}, 60_000);
    else if (existsSync(join(state, "docker-info-fail"))) fail(readFileSync(join(state, "docker-info-fail"), "utf8").trim() || "Cannot connect to the Docker daemon");
    else if (existsSync(join(state, "docker-runtime"))) {
      const fields = RUNTIMES[readFileSync(join(state, "docker-runtime"), "utf8").trim()];
      if (!fields) fail("fake docker: no such runtime");
      done(`${args[args.indexOf("--format") + 1].replace(/\{\{\.(\w+)\}\}/g, (_, name) => fields[name] ?? "")}\n`);
    } else done(existsSync(join(state, "docker-info")) ? readFileSync(join(state, "docker-info"), "utf8") : `linux|${release()}|${state}|Debian GNU/Linux 13 (trixie)\n`);
    break;
  }
  case "image": {
    if (args[1] !== "inspect") fail(`fake docker: no image ${args[1]}`);
    const name = args.at(-1);
    if (!hasImage(name)) fail(existsSync(join(state, "podman-words")) ? `Error: ${name}: image not known` : `Error response from daemon: No such image: ${name}`);
    done(`${JSON.stringify(labelsOf(name))}\n`);
    break;
  }
  case "pull":
    held("pull-hold", "pull-fail", () => (keepImage(args.at(-1), null), done(`docker.io/library/${args.at(-1)}\n`)));
    break;
  case "build": {
    const labels = {};
    let tag;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--label") {
        const at = args[i + 1].indexOf("=");
        labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1);
        i++;
      } else if (args[i] === "--tag") tag = args[++i];
    }
    // Its context is a directory whose Dockerfile can be read; a recipe on stdin (`-`) is refused, as the guard of a real
    // walk refuses it.
    const context = args.at(-1);
    if (context === "-" || !existsSync(join(context, "Dockerfile"))) fail("fake docker: a build takes a context directory with a Dockerfile, never stdin");
    const at = statSync(context);
    note("builds.jsonl", { tag, labels, context, mode: (at.mode & 0o777).toString(8), files: readdirSync(context).sort(), recipe: readFileSync(join(context, "Dockerfile"), "utf8") });
    held("build-hold", "build-fail", () => {
      const once = join(state, "build-fail-once");
      if (existsSync(once)) {
        const text = readFileSync(once, "utf8").trim();
        rmSync(once);
        fail(text || "ERROR: failed to solve: the fake's build failed once");
      }
      keepImage(tag, labels);
      done(`sha256:${randomBytes(32).toString("hex")}\n`);
    });
    break;
  }
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
        // A named volume `volumes.json` in the state directory names, or a mount of a volume's subpath, is the directory that
        // file gives its name, and its subpath below it; one it does not name fails the run, as Docker's subpath that does
        // not exist would. Any other volume a mount names that is not there is made, as Docker does, with Docker's
        // defaults and no label.
        const named = existsSync(join(state, "volumes.json")) ? JSON.parse(readFileSync(join(state, "volumes.json"), "utf8")) : {};
        if (fields.type === "volume" && (named[fields.source] || fields["volume-subpath"] !== undefined)) {
          const at = named[fields.source] && join(named[fields.source], fields["volume-subpath"] ?? "");
          if (!at || !existsSync(at)) fail(`docker: Error response from daemon: cannot access path ${fields["volume-subpath"] ?? ""} of volume ${fields.source}`, 125);
          container.mounts.push({ source: at, target: fields.target, type: "volume", volume: fields.source });
        } else {
          if (fields.type === "volume" && !existsSync(volumeDir(fields.source))) mkdirSync(volumeDir(fields.source), { recursive: true });
          container.mounts.push({ source: fields.type === "volume" ? volumeDir(fields.source) : fields.source, target: fields.target, type: fields.type });
        }
        i++;
      } else if (args[i] === "--name") container.Name = args[++i]; else if (args[i] === "--workdir") container.workdir = args[++i];
      else if (args[i] === "--network") container.HostConfig.NetworkMode = args[++i];
      else if (args[i] === "--cap-drop") (container.HostConfig.CapDrop ??= []).push(args[++i]);
      else if (args[i] === "--security-opt") (container.HostConfig.SecurityOpt ??= []).push(args[++i]);
      else if (args[i] === "--user") container.Config.User = args[++i];
    }
    container.Config.Env = container.env;
    // The server's read of the Docker host's addresses (docker-host-addresses.ts): its answer is `host-addresses.json` in
    // the state directory (the host's interfaces and host.docker.internal's), else none; `host-addresses-fail` fails it.
    if (container.Config.Labels["agentrun.read"] === "host-addresses") {
      note("host-reads.jsonl", args);
      if (existsSync(join(state, "host-addresses-fail"))) fail(readFileSync(join(state, "host-addresses-fail"), "utf8").trim() || "docker: Error response from daemon: the fake's read failed.", 125);
      done(existsSync(join(state, "host-addresses.json")) ? readFileSync(join(state, "host-addresses.json"), "utf8") : `${JSON.stringify({ interfaces: ["127.0.0.1", "::1"], gateway: [] })}\n`);
    }
    // Docker's `run` pulls an image it does not have, inside the call: the fake notes whether it would have, in
    // `made.jsonl`, which outlives the container.
    const image = args[args.indexOf("--entrypoint") + 2];
    note("made.jsonl", { id: container.Id, image, pulledInRun: !hasImage(image) });
    if (!hasImage(image) && image.startsWith("agentrun-box:")) fail(`Unable to find image '${image}' locally\ndocker: Error response from daemon: pull access denied for agentrun-box, repository does not exist or may require 'docker login': denied: requested access to the resource is denied.\nSee 'docker run --help'.`, 125);
    container.Mounts = container.mounts.map((mount) => ({ Type: mount.type ?? "bind", ...(mount.volume ? { Name: mount.volume } : {}), Source: mount.source, Destination: mount.target, RW: true }));
    if (container.Name && read(container.Name)) fail(`docker: Error response from daemon: Conflict. The container name "/${container.Name}" is already in use.`, 125);
    if ("agentrun.egress" in container.Config.Labels) {
      // The proxy container: its command run here, its paths mapped through its mounts (longest target first).
      const command = args.slice(args.indexOf("--entrypoint") + 3);
      const mounts = [...container.mounts].sort((a, b) => b.target.length - a.target.length);
      const map = (text) => mounts.reduce((mapped, mount) => (mapped === mount.target || mapped.startsWith(`${mount.target}/`) ? mount.source + mapped.slice(mount.target.length) : mapped), text);
      mkdirSync(join(state, "logs"), { recursive: true });
      const log = openSync(join(state, "logs", `${container.Id}.log`), "a");
      const preload = process.env.FAKE_DOCKER_EGRESS_PRELOAD;
      const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), ...command.map(map)], { detached: true, stdio: ["ignore", log, log], env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...Object.fromEntries(container.env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])) } });
      child.unref();
      container.pid = child.pid;
      appendFileSync(join(state, "egress.jsonl"), `${JSON.stringify({ id: container.Id, pid: child.pid, args })}\n`);
    }
    save(container);
    if (existsSync(join(state, "fail-run"))) fail("docker: Error response from daemon: the fake's start failed.", 125);
    done(`${container.Id}\n`);
    break;
  }
  case "volume": {
    const name = args.at(-1);
    // A volume's labels are in `.labels.json` in its directory (none for one Docker made on its own).
    const labels = () => (existsSync(join(volumeDir(name), ".labels.json")) ? JSON.parse(readFileSync(join(volumeDir(name), ".labels.json"), "utf8")) : {});
    if (args[1] === "inspect") {
      if (!existsSync(volumeDir(name))) fail(`Error response from daemon: get ${name}: no such volume`);
      const label = /^\{\{index \.Labels "([^"]+)"\}\}$/.exec(args[args.indexOf("--format") + 1] ?? "");
      done(label ? `${labels()[label[1]] ?? "<no value>"}\n` : `[{"Name":${JSON.stringify(name)},"Labels":${JSON.stringify(labels())}}]\n`);
    } else if (args[1] === "create") {
      appendFileSync(join(state, "volumes.jsonl"), `${JSON.stringify(args)}\n`);
      mkdirSync(volumeDir(name), { recursive: true, mode: 0o700 });
      const made = {};
      for (let i = 2; i < args.length; i++) if (args[i] === "--label") made[args[i + 1].split("=")[0]] = args[++i].slice(args[i].indexOf("=") + 1);
      writeFileSync(join(volumeDir(name), ".labels.json"), JSON.stringify(made));
      done(`${name}\n`);
    } else if (args[1] === "rm") {
      appendFileSync(join(state, "volumes.jsonl"), `${JSON.stringify(args)}\n`);
      rmSync(volumeDir(name), { recursive: true, force: true });
      done(`${name}\n`);
    } else fail(`fake docker: no volume ${args[1]}`);
    break;
  }
  case "logs": {
    const container = read(args.at(-1));
    if (!container) fail(`Error response from daemon: No such container: ${args.at(-1)}`);
    const log = join(state, "logs", `${container.Id}.log`);
    done(existsSync(log) ? readFileSync(log, "utf8") : "");
    break;
  }
  case "ps": {
    const filters = [];
    for (let i = 1; i < args.length; i++) if (args[i] === "--filter") filters.push(args[++i].replace(/^label=/, ""));
    const matches = (labels) => filters.every((filter) => (filter.includes("=") ? labels[filter.slice(0, filter.indexOf("="))] === filter.slice(filter.indexOf("=") + 1) : filter in labels));
    done(all().filter((c) => (args.includes("--all") || c.State.Running) && matches(c.Config.Labels)).map((c) => `${c.Id}\n`).join(""));
    break;
  }
  case "inspect": {
    const container = read(args.at(-1));
    if (!container) fail(`Error: No such object: ${args.at(-1)}`);
    // `--format {{.State.Running}}` gives that; `--format {{json .}}` the object, `{{json .Mounts}}` its mounts; without it
    // Docker answers a list.
    if (args.includes("{{.State.Running}}")) done(`${container.State.Running}\n`);
    const format = args[args.indexOf("--format") + 1];
    done(`${JSON.stringify(format === "{{json .Mounts}}" ? container.Mounts ?? [] : args.includes("--format") ? container : [container])}\n`);
    break;
  }
  case "rm": {
    const id = args.at(-1);
    const container = read(id);
    if (!container) fail(`Error response from daemon: No such container: ${id}`);
    // The proxy container's process group, which this fake started (its pgid is its pid).
    // Checked first by its command line, as `ps` gives it (Linux and macOS alike; a Mac has no /proc), so a pid the
    // system gave another process since is never signalled.
    if (container.pid && commandOf(container.pid).includes("main.js")) try {
      process.kill(-container.pid, "SIGKILL");
    } catch {}
    rmSync(file(container.Id));
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
    // The box's network relay (box-egress.ts) is never started on this machine: noted in `relays.jsonl`, it answers as an
    // image with socat and setsid whose relay listens would (exit 0); with `no-socat` in the state directory, as one with
    // no socat (127); with `no-setsid`, as one with no setsid (126); with `relay-dead`, as a relay that never listened
    // (124, that file's text on stderr).
    if (command.some((arg) => arg.includes("socat"))) {
      note("relays.jsonl", { id: container.Id, command });
      if (existsSync(join(state, "no-socat"))) process.exit(127);
      if (existsSync(join(state, "no-setsid"))) process.exit(126);
      if (existsSync(join(state, "relay-dead"))) fail(readFileSync(join(state, "relay-dead"), "utf8").trim(), 124);
      process.exit(0);
    }
    // A container that mounts nothing at /workspace has its own there, under the state directory: never this machine's.
    const own = join(state, "fs", container.Id, "workspace");
    const mounts = container.mounts.some((mount) => mount.target === "/workspace") ? container.mounts : (mkdirSync(own, { recursive: true }), [...container.mounts, { source: own, target: "/workspace" }]);
    const map = (text) => mounts.reduce((mapped, mount) => mapped.split(mount.target).join(mount.source), text);
    const tmp = join(state, "tmp", container.Id.slice(0, 12));
    mkdirSync(tmp, { recursive: true });
    // The command runs on this machine: a sudo it asks for meets the stand-in first on its PATH (sudo-stand-in.mjs), one it
    // names by its absolute path is refused whole, and either is noted for the test to fail on (support.mjs serve).
    const sudo = sudoStandIn(state);
    if (sudo.refuses(command.join(" "))) fail("fake docker: refused a command that names an absolute sudo", 97);
    const given = Object.fromEntries(container.env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    const env = { TMPDIR: tmp, ...given, PATH: `${sudo.bin}:${given.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` };
    const child = spawn(map(command[0]), command.slice(1).map(map), { cwd: map(workdir ?? container.workdir), env, stdio: "inherit" });
    child.once("error", () => fail(`OCI runtime exec failed: ${command[0]}: not found`, 127));
    child.once("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 1)));
    break;
  }
  default:
    fail(`fake docker: no ${args[0]}`);
}
