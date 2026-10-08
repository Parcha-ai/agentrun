// dockerHost over a fake docker CLI (test/fixtures/fake-docker.mjs): the container it creates (FUSE, AppArmor, no new
// privileges, no restart policy, labels, the app mounted read-only), the token's path (a root-only file copied in between
// create and start, never an argument or an environment variable), idempotent starts keyed on the attempt, the state map,
// stop, and the cleanup of a run's dead containers. Plus the CLI's `--host docker` plumbing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containerStatus, diskKey, dockerHost, tarOneFile, type DockerHostOptions } from "../src/hosts/docker.ts";
import { main } from "../src/cli.ts";
import { PdaError } from "../src/errors.ts";
import type { HostHandle } from "../src/supervise.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));
const TOKEN = "tok-secret-0123456789abcdef";
const ref = { disk: "dsk-1", region: "aws-us-east-1", id: "run-1" };
/** The container name dockerHost gives run `id` on ref's disk at attempt `g`. */
const nm = (id: string, g: number | string, r: { disk: string; region: string } = ref) => `pda-${id}-${diskKey(r)}-g${g}`;

type Call = { argv: string[]; stdin: string };
type Container = { id: string; name: string; image: string; cmd: string[]; labels: Record<string, string>; env: string[]; flags: [string, string][]; files: Record<string, string>; state: { Status: string; ExitCode: number } };
type State = { daemon?: string; securityOptions?: string[]; containers: Record<string, Container>; calls: Call[]; fail?: Record<string, string>; startAs?: { status: string; exitCode?: number }; sticky?: string[]; stopExit?: number };

function fakeDaemon(initial: Partial<State> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-fake-docker-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({ containers: {}, calls: [], ...initial }));
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${file}" "$@"\n`);
  chmodSync(bin, 0o755);
  const read = () => JSON.parse(readFileSync(file, "utf8")) as State;
  return {
    dir,
    bin,
    read,
    write: (fn: (s: State) => void) => {
      const s = read();
      fn(s);
      writeFileSync(file, JSON.stringify(s));
    },
    calls: () => read().calls,
    byName: (name: string) => Object.values(read().containers).find((c) => c.name === name),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function host(fake: ReturnType<typeof fakeDaemon>, opts: DockerHostOptions = {}) {
  return dockerHost({ image: "pda-image:test", docker: fake.bin, fleet: "t", ...opts });
}

/** Every byte a call carried: argv and stdin, the tar's decoded too. */
const carried = (calls: Call[]) => calls.map((c) => `${c.argv.join(" ")} ${Buffer.from(c.stdin, "base64").toString("latin1")}`);

test("start: create with FUSE, AppArmor unconfined, no new privileges and no restart policy; the token is copied in, then started", async () => {
  // A daemon that applies AppArmor, as Docker Engine on Ubuntu does.
  const fake = fakeDaemon({ securityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"] });
  try {
    const notes: string[] = [];
    const h = await host(fake, { mountRoot: "/mnt/x", runArgs: ["--heartbeat-ms=1000"], env: { A: "1" }, note: (l) => notes.push(l) }).start(ref, TOKEN, { attempt: 3 });
    assert.deepEqual(notes, ["the docker daemon applies AppArmor, whose default profile denies the mount archil needs: containers run with --security-opt apparmor=unconfined"]);
    assert.equal(h.name, nm("run-1", 3));
    assert.deepEqual({ driver: h.driver, fleet: h.fleet, daemon: h.daemon, mountpoint: h.mountpoint, image: h.image }, { driver: "docker", fleet: "t", daemon: "daemon-1", mountpoint: "/mnt/x/runs/run-1", image: "pda-image:test" });
    const verbs = fake.calls().map((c) => c.argv[0]);
    assert.deepEqual(verbs.filter((v) => v !== "info" && v !== "ps"), ["create", "cp", "start"], "create, copy the token in, start");
    const c = fake.byName(nm("run-1", 3))!;
    const flags = c.flags.map(([f, v]) => `${f} ${v}`);
    for (const want of ["--device /dev/fuse", "--cap-add SYS_ADMIN", "--security-opt apparmor=unconfined", "--security-opt no-new-privileges", "--restart no", "--label pda.fleet=t", "--label pda.run=run-1", "--label pda.attempt=3", "--env A=1"]) {
      assert.ok(flags.includes(want), `create has ${want}: ${flags.join(", ")}`);
    }
    assert.equal(c.image, "pda-image:test");
    assert.deepEqual(c.cmd, ["run", "--disk", "dsk-1", "--region", "aws-us-east-1", "--id", "run-1", "--mount-root", "/mnt/x", "--archil", "/usr/local/sbin/archil-scoped", "--run-as", "pda", "--heartbeat-ms=1000", "--token-stdin"]);
    const holder = JSON.parse(c.env.find((e) => e.startsWith("PDA_HOLDER="))!.slice("PDA_HOLDER=".length));
    assert.deepEqual(holder, { driver: "docker", fleet: "t", daemon: "daemon-1", name: nm("run-1", 3), mountpoint: "/mnt/x/runs/run-1", image: "pda-image:test" });
    // The token: only in the tar `docker cp -` reads from stdin, as /run/pda/token, mode 0600, owned by root.
    const cp = fake.calls().find((x) => x.argv[0] === "cp")!;
    assert.deepEqual(cp.argv, ["cp", "-", `${c.id}:/run/pda`]);
    const tarFile = join(fake.dir, "token.tar");
    writeFileSync(tarFile, Buffer.from(cp.stdin, "base64"));
    const listing = spawnSync("tar", ["-tvf", tarFile], { encoding: "utf8" }).stdout.trim();
    assert.match(listing, /^-rw------- root\/root\s+\d+ .* token$/);
    assert.equal(spawnSync("tar", ["-xOf", tarFile, "token"], { encoding: "utf8" }).stdout, `${TOKEN}\n`);
    const elsewhere = carried(fake.calls().filter((x) => x.argv[0] !== "cp"));
    assert.ok(!elsewhere.some((t) => t.includes(TOKEN)), "the token is in no other call's argv or stdin");
    assert.ok(!JSON.stringify(c.flags).includes(TOKEN) && !c.env.some((e) => e.includes(TOKEN)) && !c.cmd.includes(TOKEN), "nor in the container's configuration");
  } finally {
    fake.remove();
  }
});

test("start: the app's directory is mounted read-only at /opt/pda/app, its node_modules hidden; the module path is translated", async () => {
  const fake = fakeDaemon();
  const appRoot = mkdtempSync(join(tmpdir(), "pda-app-"));
  try {
    mkdirSync(join(appRoot, "examples", "x"), { recursive: true });
    writeFileSync(join(appRoot, "examples", "x", "app.ts"), "export default () => ({})\n");
    await host(fake, { app: join(appRoot, "examples", "x", "app.ts"), appRoot }).start(ref, TOKEN, { attempt: 1 });
    let c = fake.byName(nm("run-1", 1))!;
    let mounts = c.flags.filter(([f]) => f === "--mount").map(([, v]) => v);
    assert.deepEqual(mounts, [`type=bind,source=${appRoot},target=/opt/pda/app,readonly`]);
    assert.deepEqual(c.cmd.slice(c.cmd.indexOf("--app"), c.cmd.indexOf("--app") + 2), ["--app", "/opt/pda/app/examples/x/app.ts"]);
    mkdirSync(join(appRoot, "node_modules"));
    await host(fake, { app: join(appRoot, "examples", "x", "app.ts"), appRoot }).start({ ...ref, id: "run-2" }, TOKEN, { attempt: 1 });
    c = fake.byName(nm("run-2", 1))!;
    mounts = c.flags.filter(([f]) => f === "--mount").map(([, v]) => v);
    assert.deepEqual(mounts[1], "type=tmpfs,target=/opt/pda/app/node_modules,tmpfs-size=4096,tmpfs-mode=0555");
    // Default root: the module's own directory.
    await host(fake, { app: join(appRoot, "examples", "x", "app.ts") }).start({ ...ref, id: "run-3" }, TOKEN, { attempt: 1 });
    c = fake.byName(nm("run-3", 1))!;
    assert.ok(c.cmd.includes("/opt/pda/app/app.ts"));
    assert.throws(() => host(fake, { app: "/elsewhere/app.ts", appRoot }), (e: unknown) => e instanceof PdaError && e.code === "INVALID_ARGUMENT");
    assert.throws(() => host(fake, { app: "/a,b/app.ts" }), (e: unknown) => e instanceof PdaError && /comma/.test((e as Error).message));
  } finally {
    fake.remove();
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("start: AppArmor only where the daemon applies it (auto), or as named, or left out; an image is required; a bad token is refused", async () => {
  const fake = fakeDaemon();
  try {
    // A daemon that applies no AppArmor (Docker Desktop, OrbStack): no option, and the note says so.
    const notes: string[] = [];
    await host(fake, { note: (l) => notes.push(l) }).start({ ...ref, id: "run-0" }, TOKEN, { attempt: 1 });
    assert.ok(!fake.byName(nm("run-0", 1))!.flags.some(([, v]) => v.startsWith("apparmor=")));
    assert.deepEqual(notes, ["the docker daemon applies no AppArmor profile: containers get no AppArmor option"]);
    await host(fake, { apparmor: "pda-fuse" }).start(ref, TOKEN, { attempt: 1 });
    assert.ok(fake.byName(nm("run-1", 1))!.flags.some(([f, v]) => f === "--security-opt" && v === "apparmor=pda-fuse"));
    await host(fake, { apparmor: false }).start({ ...ref, id: "run-2" }, TOKEN, { attempt: 1 });
    assert.ok(!fake.byName(nm("run-2", 1))!.flags.some(([, v]) => v.startsWith("apparmor=")));
    await assert.rejects(dockerHost({ docker: fake.bin }).start(ref, TOKEN), (e: unknown) => e instanceof PdaError && e.code === "INVALID_ARGUMENT");
    await assert.rejects(host(fake).start(ref, "a\nb"), (e: unknown) => e instanceof PdaError && e.code === "INVALID_ARGUMENT");
  } finally {
    fake.remove();
  }
});

test("start again for the same attempt: a running container is adopted (no second token), a dead one replaced", async () => {
  const fake = fakeDaemon();
  try {
    const driver = host(fake);
    const first = await driver.start(ref, TOKEN, { attempt: 2 });
    const before = fake.calls().length;
    const again = await driver.start(ref, "another-token", { attempt: 2 });
    assert.equal(again.name, first.name);
    assert.equal(again.adopted, true, "the handle says the start was adopted, so the supervisor removes the unused token");
    assert.equal(first.adopted, undefined);
    const after = fake.calls().slice(before).map((c) => c.argv[0]);
    assert.ok(!after.includes("cp") && !after.includes("start"), `adopted without a token or a start: ${after}`);
    assert.ok(!carried(fake.calls()).some((t) => t.includes("another-token")), "the second token went nowhere");
    // The container exited (a fenced or failed instance): the same attempt replaces it.
    fake.write((s) => void (Object.values(s.containers)[0].state = { Status: "exited", ExitCode: 1 }));
    const replaced = await driver.start(ref, TOKEN, { attempt: 2 });
    assert.notEqual(replaced.id, first.id);
    assert.equal(Object.keys(fake.read().containers).length, 1);
    // A container of that name in another fleet is never touched.
    fake.write((s) => void (Object.values(s.containers)[0].labels["pda.fleet"] = "other"));
    await assert.rejects(driver.start(ref, TOKEN, { attempt: 2 }), (e: unknown) => e instanceof PdaError && e.code === "START_FAILED" && /not this run's/.test((e as Error).message));
  } finally {
    fake.remove();
  }
});

test("the same run id on two disks (or regions) gets two containers; a container of another disk's run is never adopted or removed", async () => {
  const fake = fakeDaemon();
  try {
    const driver = host(fake);
    const other = { ...ref, disk: "dsk-2" };
    const a = await driver.start(ref, TOKEN, { attempt: 1 });
    const b = await driver.start(other, TOKEN, { attempt: 1 });
    const c = await driver.start({ ...ref, region: "aws-us-west-2" }, TOKEN, { attempt: 1 });
    assert.equal(new Set([a.name, b.name, c.name]).size, 3);
    assert.equal(b.adopted, undefined, "not adopted across disks");
    for (const h of [a, b]) {
      const labels = fake.byName(String(h.name))!.labels;
      assert.equal(labels["pda.disk"], h === a ? "dsk-1" : "dsk-2");
      assert.equal(labels["pda.region"], "aws-us-east-1");
    }
    // A start on dsk-1 collects that run's ended containers only.
    fake.write((s) => {
      for (const x of Object.values(s.containers)) x.state = { Status: "exited", ExitCode: 137 };
    });
    await driver.start(ref, TOKEN, { attempt: 2 });
    assert.ok(fake.byName(String(b.name)), "dsk-2's container stays");
    assert.ok(!fake.byName(String(a.name)), "dsk-1's ended container went");
    // A container with this run's name but another disk's labels is refused, never adopted.
    fake.write((s) => {
      const x = Object.values(s.containers).find((y) => y.name === nm("run-1", 2))!;
      x.labels["pda.disk"] = "dsk-9";
    });
    await assert.rejects(driver.start(ref, TOKEN, { attempt: 2 }), (e: unknown) => e instanceof PdaError && e.code === "START_FAILED" && /not this run's/.test((e as Error).message));
  } finally {
    fake.remove();
  }
});

test("start that fails after create (the token copy, the start): the container is removed and the error is typed", async () => {
  for (const verb of ["cp", "start"]) {
    const fake = fakeDaemon({ fail: { [verb]: `Error response from daemon: ${verb} broke` } });
    try {
      await assert.rejects(host(fake).start(ref, TOKEN, { attempt: 1 }), (e: unknown) => e instanceof PdaError && e.code === "START_FAILED" && new RegExp(`${verb} broke`).test((e as Error).message));
      assert.deepEqual(fake.read().containers, {}, `${verb}: nothing left behind`);
    } finally {
      fake.remove();
    }
  }
});

test("start without an attempt names the container by time; a start removes the run's earlier dead containers only", async () => {
  const fake = fakeDaemon();
  try {
    const driver = host(fake);
    const loose = await driver.start(ref, TOKEN);
    assert.match(String(loose.name), new RegExp(`^pda-run-1-${diskKey(ref)}-t[0-9a-z]+$`));
    fake.write((s) => {
      for (const c of Object.values(s.containers)) c.state = { Status: "exited", ExitCode: 137 };
    });
    await driver.start(ref, TOKEN, { attempt: 1 });
    await driver.start({ ...ref, id: "other" }, TOKEN, { attempt: 1 });
    fake.write((s) => {
      for (const c of Object.values(s.containers)) if (c.name === nm("run-1", 1)) c.state = { Status: "exited", ExitCode: 75 };
    });
    await driver.start(ref, TOKEN, { attempt: 2 });
    const names = Object.values(fake.read().containers).map((c) => `${c.name}:${c.state.Status}`).sort();
    assert.deepEqual(names, [`${nm("other", 1)}:running`, `${nm("run-1", 2)}:running`].sort(), "attempt 1 (exited 75) and the loose one went; another run's stayed");
  } finally {
    fake.remove();
  }
});

test("status: running, paused (a frozen host) is running, exit 0 stopped, any other exit failed, created stopped, missing gone", async () => {
  const fake = fakeDaemon();
  try {
    const driver = host(fake);
    const h = await driver.start(ref, TOKEN, { attempt: 1 });
    const set = (Status: string, ExitCode = 0) => fake.write((s) => void (Object.values(s.containers)[0].state = { Status, ExitCode }));
    assert.equal(await driver.status(h), "running");
    for (const [status, code, want] of [["paused", 0, "running"], ["restarting", 0, "running"], ["exited", 0, "stopped"], ["exited", 75, "failed"], ["exited", 76, "failed"], ["exited", 137, "failed"], ["created", 0, "stopped"], ["dead", 0, "failed"]] as const) {
      set(status, code);
      assert.equal(await driver.status(h), want, `${status} ${code}`);
    }
    set("exited", 75);
    assert.deepEqual(await driver.describe(h).then((d) => d && { status: d.status, state: d.state, exitCode: d.exitCode }), { status: "failed", state: "exited", exitCode: 75 });
    // The supervisor's handle (with the id) and the instance's own holder (name only) both resolve.
    const { id: _id, ...holder } = h;
    assert.equal(await driver.status(holder as HostHandle), "failed");
    fake.write((s) => void (s.containers = {}));
    assert.equal(await driver.status(h), "gone");
    assert.equal(await driver.describe(h), null);
    assert.equal(await driver.status({ ...h, fleet: "other" }), "unknown", "another fleet's handle");
    assert.equal(await driver.status({ ...h, daemon: "daemon-2" }), "unknown", "another daemon's handle");
    assert.equal(await driver.status({ driver: "local", host: "x" }), "unknown");
  } finally {
    fake.remove();
  }
  assert.equal(containerStatus({ Status: "removing" }), "stopped");
  assert.equal(containerStatus({ Status: "something-new" }), "unknown");
});

test("stop: docker stop -t (the drain), then docker rm -f; a gone container, another fleet's or a paused one are handled", async () => {
  const fake = fakeDaemon();
  try {
    const driver = host(fake, { stopTimeoutMs: 7_000 });
    const h = await driver.start(ref, TOKEN, { attempt: 1 });
    const before = fake.calls().length;
    await driver.stop(h);
    const argv = fake.calls().slice(before).map((c) => c.argv.join(" "));
    assert.ok(argv.includes(`stop -t 7 ${h.id}`), argv.join(" | "));
    assert.ok(argv.includes(`rm -f ${h.id}`));
    assert.equal(await driver.status(h), "gone");
    await driver.stop(h); // gone: a no-op
    const p = await driver.start(ref, TOKEN, { attempt: 2 });
    fake.write((s) => void (Object.values(s.containers)[0].state = { Status: "paused", ExitCode: 0 }));
    await driver.stop(p);
    assert.equal(await driver.status(p), "gone", "a paused container (a frozen host) is stopped and removed");
    const q = await driver.start(ref, TOKEN, { attempt: 3 });
    const n = fake.calls().length;
    await driver.stop({ ...q, fleet: "other" });
    assert.ok(!fake.calls().slice(n).some((c) => c.argv[0] === "stop" || c.argv[0] === "rm"), "another fleet's handle is not stopped");
    fake.write((s) => void (s.sticky = [String(q.name)]));
    await assert.rejects(driver.stop(q), (e: unknown) => e instanceof PdaError && e.code === "STOP_FAILED");
  } finally {
    fake.remove();
  }
});

test("a docker daemon that does not answer: status and start throw a typed error (STONITH records it as failed)", async () => {
  const fake = fakeDaemon({ fail: { info: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } });
  try {
    await assert.rejects(host(fake).status({ driver: "docker", fleet: "t", daemon: "x", name: "pda-a-g1" }), (e: unknown) => e instanceof PdaError && e.code === "DOCKER_FAILED");
  } finally {
    fake.remove();
  }
});

test("tarOneFile: a root-owned regular file that tar reads back byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "pda-tar-"));
  try {
    const data = Buffer.alloc(1300, 7);
    writeFileSync(join(dir, "x.tar"), tarOneFile("blob", data, 0o640));
    assert.match(spawnSync("tar", ["-tvf", join(dir, "x.tar")], { encoding: "utf8" }).stdout, /^-rw-r----- root\/root\s+1300 .* blob\n$/);
    assert.ok(spawnSync("tar", ["-xOf", join(dir, "x.tar"), "blob"]).stdout.equals(data));
    assert.throws(() => tarOneFile("../x", data), (e: unknown) => e instanceof PdaError && e.code === "INVALID_ARGUMENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: supervise --host docker needs --image and refuses --check; an unknown host is a usage error", async () => {
  const quiet = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    // Each is refused before the API key is read or Archil is called (the key variable named here is set, the disk is fake).
    process.env.PDA_TEST_FAKE_KEY = "k";
    const supervise = (...extra: string[]) => main(["supervise", "--disk", "d", "--region", "r", "--id", "x", "--api-key-env", "PDA_TEST_FAKE_KEY", ...extra]);
    assert.equal(await supervise("--host", "docker"), 2, "--host docker without --image");
    assert.equal(await supervise("--host", "docker", "--image", "i", "--check"), 2, "--check with --host docker");
    assert.equal(await supervise("--host", "vm"), 2, "an unknown host");
  } finally {
    process.stderr.write = quiet;
    delete process.env.PDA_TEST_FAKE_KEY;
  }
});
