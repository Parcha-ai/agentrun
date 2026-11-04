// A fake `docker` for run-box.test.mjs, run by a `docker` script first on PATH: it never reaches a daemon. Each call's
// arguments go to `$FAKE_DOCKER_STATE/argv.jsonl`, and each container is a file under `containers/`. `exec` runs the
// command on this machine, the container's mount targets mapped to their sources and its `--env` its whole environment
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
// `info` answers as a daemon on this Linux machine (its kernel), or as `docker-info` says.
// An `exec` of the box's network relay (socat) is noted, never run here (`no-socat`, `no-setsid` or `relay-dead` in the
// state directory: an image without one, or a relay that never listened).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, release } from "node:os";
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
    done("27.0.0-fake\n");
    break;
  case "info": {
    // `docker info --format {{.OSType}}|{{.KernelVersion}}|{{.OperatingSystem}}`: a daemon of this Linux machine's own
    // (its kernel), or what `docker-info` in the state directory says; it fails with `docker-info-fail`'s text, and with
    // `docker-info-hold` it never answers.
    if (existsSync(join(state, "docker-info-hold"))) setInterval(() => {}, 60_000);
    else if (existsSync(join(state, "docker-info-fail"))) fail(readFileSync(join(state, "docker-info-fail"), "utf8").trim() || "Cannot connect to the Docker daemon");
    else done(existsSync(join(state, "docker-info")) ? readFileSync(join(state, "docker-info"), "utf8") : `linux|${release()}|Debian GNU/Linux 13 (trixie)\n`);
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
    appendFileSync(join(state, "builds.jsonl"), `${JSON.stringify({ tag, labels, context, mode: (at.mode & 0o777).toString(8), files: readdirSync(context).sort(), recipe: readFileSync(join(context, "Dockerfile"), "utf8") })}\n`);
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
        container.mounts.push({ source: fields.source, target: fields.target });
        i++;
      } else if (args[i] === "--workdir") container.workdir = args[++i];
      else if (args[i] === "--network") container.HostConfig.NetworkMode = args[++i];
      else if (args[i] === "--cap-drop") (container.HostConfig.CapDrop ??= []).push(args[++i]);
      else if (args[i] === "--security-opt") (container.HostConfig.SecurityOpt ??= []).push(args[++i]);
      else if (args[i] === "--user") container.Config.User = args[++i];
    }
    container.Config.Env = container.env;
    // Docker's `run` pulls an image it does not have, inside the call: the fake notes whether it would have, in
    // `made.jsonl`, which outlives the container.
    const image = args[args.indexOf("--entrypoint") + 2];
    appendFileSync(join(state, "made.jsonl"), `${JSON.stringify({ id: container.Id, image, pulledInRun: !hasImage(image) })}\n`);
    if (!hasImage(image) && image.startsWith("agentrun-box:")) fail(`Unable to find image '${image}' locally\ndocker: Error response from daemon: pull access denied for agentrun-box, repository does not exist or may require 'docker login': denied: requested access to the resource is denied.\nSee 'docker run --help'.`, 125);
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
    // The box's network relay (box-egress.ts) is never started on this machine: noted in `relays.jsonl`, it answers as an
    // image with socat and setsid whose relay listens would (exit 0); with `no-socat` in the state directory, as one with
    // no socat (127); with `no-setsid`, as one with no setsid (126); with `relay-dead`, as a relay that never listened
    // (124, that file's text on stderr).
    if (command.some((arg) => arg.includes("socat"))) {
      appendFileSync(join(state, "relays.jsonl"), `${JSON.stringify({ id: container.Id, command })}\n`);
      if (existsSync(join(state, "no-socat"))) process.exit(127);
      if (existsSync(join(state, "no-setsid"))) process.exit(126);
      if (existsSync(join(state, "relay-dead"))) fail(readFileSync(join(state, "relay-dead"), "utf8").trim(), 124);
      process.exit(0);
    }
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
