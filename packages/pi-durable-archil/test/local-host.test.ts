// localHost unit tests: the systemd unit's shape and its stop sequence over a recording runner (no systemd touched),
// the status mapping, and child mode with real processes. No Archil, no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIL_SCOPED } from "../src/claim.ts";
import { currentBootId, localHost, parseShow, procStartTicks, TERMINAL_EXITS, unitStatus, type Ran, type Runner } from "../src/hosts/local-host.ts";
import { PdaError } from "../src/errors.ts";

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const TOKEN = `tok-${"5".repeat(40)}`;
const API_KEY_SENTINEL = "api-key-must-not-travel";
const FAKE_INSTANCE = fileURLToPath(new URL("./fixtures/fake-instance.mjs", import.meta.url));
const ok = (stdout = ""): Ran => ({ code: 0, timedOut: false, stdout, stderr: "" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Records every command; `answer` decides each result and may change the fake world (mounts, scopes). */
function recorder(answer: (argv: string[]) => Ran | undefined = () => undefined) {
  const calls: { argv: string[]; input?: string }[] = [];
  const exec: Runner = async (argv, opts) => {
    calls.push({ argv, input: opts?.input });
    return answer(argv) ?? ok();
  };
  return { calls, exec };
}

function world() {
  const dir = scratch("pda-local-");
  const procMounts = join(dir, "mounts");
  const mountRoot = join(dir, "mnt");
  const mp = join(mountRoot, "runs", REF.id);
  const setMounted = (on: boolean) => writeFileSync(procMounts, on ? `${REF.disk}:/runs/${REF.id} ${mp} fuse.archil rw 0 0\n` : "");
  setMounted(false);
  return { dir, procMounts, mountRoot, mp, setMounted };
}

test("systemd start: a transient unit that kills its control group, restarts in place but never after 65, 70, 75 or 76, runs as the user", async () => {
  const w = world();
  const { calls, exec } = recorder();
  const prevKey = process.env.ARCHIL_API_KEY;
  process.env.ARCHIL_API_KEY = API_KEY_SENTINEL;
  try {
    const host = localHost({ exec, mountRoot: w.mountRoot, procMounts: w.procMounts, unitPrefix: "pda-t-", user: "1000", group: "1000", hostName: "host-a", runArgs: ["--heartbeat-ms", "1000"], command: ["/usr/bin/node", "/pkg/cli.ts"] });
    const handle = await host.start(REF, TOKEN);
    assert.equal(handle.driver, "local");
    assert.equal(handle.mode, "systemd");
    assert.equal(handle.host, "host-a");
    assert.equal(handle.bootId, currentBootId());
    assert.equal(handle.mountpoint, w.mp);
    const unit = String(handle.unit);
    assert.match(unit, /^pda-t-r1-[0-9a-z]+$/);

    const file = `/run/pi-durable-archil/${unit}.mount-token`;
    const [cred, run, empty] = calls;
    assert.equal(cred.argv[0], "/usr/bin/sudo");
    assert.equal(cred.input, TOKEN, "the token goes into a root-only file through stdin");
    assert.equal(cred.argv.at(-1), file);
    assert.deepEqual(run.argv.slice(0, 3), ["/usr/bin/sudo", "-n", "/usr/bin/systemd-run"]);
    const a = run.argv;
    const prop = (p: string) => a.some((x, i) => a[i - 1] === "-p" && x === p);
    assert.ok(a.includes(`--unit=${unit}`) && a.includes("--service-type=exec"));
    assert.deepEqual([...TERMINAL_EXITS], [65, 70, 75, 76], "data error, store head unreadable, fenced, held");
    for (const p of ["KillMode=control-group", "Restart=on-failure", "RestartPreventExitStatus=65 70 75 76", "User=1000", "Group=1000", `StandardInput=file:${file}`, "TimeoutStopSec=30s"]) {
      assert.ok(prop(p), `property ${p}`);
    }
    const holder = JSON.parse(a.find((x) => x.startsWith("--setenv=PDA_HOLDER="))!.slice("--setenv=PDA_HOLDER=".length));
    assert.deepEqual(holder, { driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit, mountpoint: w.mp });
    assert.ok(!a.some((x) => /ImportCredential|LoadCredential|SetCredential|TOKEN/.test(x)), "no systemd credential the run's user could read");
    const cmd = a.slice(a.indexOf("--") + 1);
    assert.deepEqual(cmd, ["/usr/bin/node", "/pkg/cli.ts", "run", "--disk", REF.disk, "--region", REF.region, "--id", "r1", "--mount-root", w.mountRoot, "--archil", ARCHIL_SCOPED, "--heartbeat-ms", "1000", "--token-stdin"]);
    assert.deepEqual(empty.argv.slice(0, 4), ["/usr/bin/sudo", "-n", "/bin/sh", "-c"]);
    assert.ok(empty.argv[4].includes("mv -f") && empty.argv.at(-1) === file, "once started, the path holds an empty file (a restart in place reads nothing)");
    assert.equal(empty.input ?? "", "", "nothing is written into the replacement");
    const everything = JSON.stringify(calls.map((c) => c.argv));
    assert.ok(!everything.includes(TOKEN), "the token is in no argv");
    assert.ok(!everything.includes(API_KEY_SENTINEL), "the API key reaches no command");
  } finally {
    if (prevKey === undefined) delete process.env.ARCHIL_API_KEY;
    else process.env.ARCHIL_API_KEY = prevKey;
  }
});

test("systemd start that fails: the credential file is still removed and the error is typed", async () => {
  const w = world();
  const { calls, exec } = recorder((argv) => (argv.includes("/usr/bin/systemd-run") ? { code: 1, timedOut: false, stdout: "", stderr: "Failed to start transient service unit: Unit already exists." } : undefined));
  const host = localHost({ exec, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  const err = await host.start(REF, TOKEN).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof PdaError && err.code === "START_FAILED" && /already exists/.test(err.message), String(err));
  assert.ok(calls.at(-1)!.argv.includes("/bin/rm"));
  const noRestart = recorder();
  await localHost({ exec: noRestart.exec, mountRoot: w.mountRoot, restart: false }).start(REF, TOKEN);
  assert.ok(!noRestart.calls[1].argv.some((x) => x.startsWith("Restart")), "restart: false drops Restart=");
});

test("status: the unit's state, a foreign host is unknown, another boot is gone", async () => {
  assert.deepEqual(parseShow("LoadState=loaded\nActiveState=failed\nExecMainStatus=75\n"), { LoadState: "loaded", ActiveState: "failed", ExecMainStatus: "75" });
  const table: [Record<string, string>, string][] = [
    [{ LoadState: "loaded", ActiveState: "active" }, "running"],
    [{ LoadState: "loaded", ActiveState: "activating", SubState: "auto-restart" }, "running"],
    [{ LoadState: "loaded", ActiveState: "deactivating" }, "running"],
    [{ LoadState: "loaded", ActiveState: "failed" }, "failed"],
    [{ LoadState: "loaded", ActiveState: "inactive" }, "stopped"],
    [{ LoadState: "not-found", ActiveState: "inactive" }, "gone"],
    [{}, "gone"],
    [{ LoadState: "loaded", ActiveState: "maintenance" }, "unknown"],
  ];
  for (const [show, want] of table) assert.equal(unitStatus(show), want, JSON.stringify(show));
  const { exec } = recorder((argv) => (argv[1] === "show" ? ok("LoadState=loaded\nActiveState=active\nSubState=running\n") : undefined));
  const host = localHost({ exec, hostName: "host-a", user: "1000", group: "1000" });
  const h = { driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: "/mnt/x" };
  assert.equal(await host.status(h), "running");
  assert.equal(await host.status({ ...h, host: "host-b" }), "unknown");
  assert.equal(await host.status({ ...h, driver: "k8s" }), "unknown");
  assert.equal(await host.status({ ...h, bootId: "another-boot" }), "gone");
  assert.equal(await host.status({ ...h, unit: "bad name; rm -rf /" }), "unknown");
});

test("stop: the unit, then nothing else when the instance released its own mount", async () => {
  const w = world();
  const { calls, exec } = recorder();
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  const h = { driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp };
  await host.stop(h);
  const argvs = calls.map((c) => c.argv.join(" "));
  assert.equal(argvs[0], "/usr/bin/sudo -n /usr/bin/systemctl stop pda-t-r1-x.service");
  assert.ok(argvs.some((a) => a.includes("list-units --all --plain --no-legend --type=scope pda-t-r1-x-fuse-*")), "the unit's FUSE scope is looked for even with nothing mounted");
  assert.ok(!argvs.some((a) => /\/usr\/bin\/archil|fusermount|umount|stat |kill/.test(a)), "nothing mounted and no scope: nothing to clean");
  assert.equal(argvs.at(-2), "/usr/bin/sudo -n /usr/bin/systemctl reset-failed pda-t-r1-x.service");
  assert.equal(argvs.at(-1), "/usr/bin/sudo -n /bin/rm -f /run/pi-durable-archil/pda-t-r1-x.mount-token", "stop removes the unit's token file");
  calls.length = 0;
  await host.stop({ ...h, host: "host-b" });
  await host.stop({ ...h, bootId: "other" });
  assert.equal(calls.length, 0, "a handle this driver cannot reach is a no-op");
});

test("stop: the unit's mount left behind is checked in by archil unmount when its daemon answers", async () => {
  const w = world();
  w.setMounted(true);
  let scope = true;
  const { calls, exec } = recorder((argv) => {
    if (argv.includes("list-units")) return ok(scope ? "pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n" : "");
    if (argv.includes("unmount")) {
      scope = false;
      w.setMounted(false);
    }
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  await host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp });
  const argvs = calls.map((c) => c.argv.join(" "));
  assert.ok(argvs.includes(`/usr/bin/sudo -n /usr/bin/archil unmount ${w.mp}`));
  assert.ok(!argvs.some((a) => a.includes("kill")), "a daemon that let go is never killed");
});

test("stop: a daemon that does not let go is SIGKILLed through its scope (power-off semantics)", async () => {
  const w = world();
  w.setMounted(true);
  let scope = true;
  const { calls, exec } = recorder((argv) => {
    if (argv.includes("list-units")) return ok(scope ? "pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n" : "");
    if (argv.includes("unmount")) return { code: null, timedOut: true, stdout: "", stderr: "" };
    if (argv.includes("kill")) {
      scope = false;
      w.setMounted(false);
    }
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  await host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp });
  const argvs = calls.map((c) => c.argv.join(" "));
  const kill = argvs.indexOf("/usr/bin/sudo -n /usr/bin/systemctl kill --signal=SIGKILL pda-t-r1-x-fuse-1.scope");
  assert.ok(kill > argvs.findIndex((a) => a.includes("archil unmount")), "kill only after the polite unmount");
});

test("stop: a FUSE scope still active after its mount left the table is SIGKILLed (a client FAILED at its token refresh keeps the mountpoint's socket)", async () => {
  for (const mountedAtStop of [false, true]) {
    const w = world();
    w.setMounted(mountedAtStop);
    let scope = true;
    const { calls, exec } = recorder((argv) => {
      if (argv.includes("list-units")) return ok(scope ? "pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n" : "");
      // The FAILED client: the polite unmount takes the mount out of the table, and its process stays.
      if (argv.includes("unmount")) w.setMounted(false);
      if (argv.includes("kill")) scope = false;
      return undefined;
    });
    const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
    await host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp });
    const argvs = calls.map((c) => c.argv.join(" "));
    assert.equal(argvs.some((a) => a.includes("archil unmount")), mountedAtStop, "the polite unmount only for a mount in the table");
    assert.ok(argvs.includes("/usr/bin/sudo -n /usr/bin/systemctl kill --signal=SIGKILL pda-t-r1-x-fuse-1.scope"), `mounted at stop: ${mountedAtStop}`);
    assert.equal(scope, false, "the scope is gone");
    assert.ok(!argvs.some((a) => /fusermount|umount -l/.test(a)), "no mount to remove");
  }
});

test("stop: a FUSE scope that outlives SIGKILL is a typed failure", async () => {
  const w = world();
  const { exec } = recorder((argv) => (argv.includes("list-units") ? ok("pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n") : undefined));
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  await assert.rejects(
    host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp }),
    (e: unknown) => e instanceof PdaError && e.code === "STOP_FAILED" && /pda-t-r1-x-fuse-1\.scope still active/.test(e.message),
  );
});

test("as root, the driver refuses to run instances (and so the agent's tools) as root unless a user is named", () => {
  const getuid = process.getuid;
  process.getuid = () => 0;
  try {
    assert.throws(() => localHost({}), (e: unknown) => e instanceof PdaError && e.code === "INVALID_ARGUMENT");
    assert.doesNotThrow(() => localHost({ user: "pda", group: "pda" }));
  } finally {
    process.getuid = getuid;
  }
});

test("child mode: token on stdin, holder in the environment, no API key; stop ends it; its detached command outlives it", async () => {
  const dir = scratch("pda-child-");
  const out = join(dir, "out.json");
  const prevKey = process.env.ARCHIL_API_KEY;
  process.env.ARCHIL_API_KEY = API_KEY_SENTINEL;
  let grandchild = 0;
  try {
    const host = localHost({ mode: "child", command: [process.execPath, FAKE_INSTANCE], env: { PDA_TEST_OUT: out }, hostName: "host-a", mountRoot: "/mnt/x", stopTimeoutMs: 3_000 });
    const h = await host.start(REF, TOKEN);
    for (let i = 0; i < 100 && !existsSync(out); i++) await sleep(50);
    const seen = JSON.parse(readFileSync(out, "utf8"));
    grandchild = seen.grandchild;
    assert.equal(seen.token, TOKEN);
    assert.deepEqual(seen.argv.slice(-1), ["--token-stdin"]);
    assert.ok(seen.argv.includes("run") && seen.argv.includes("--archil") && seen.argv.includes(ARCHIL_SCOPED), "child mode mounts through the wrapper too");
    assert.ok(!seen.envKeys.some((k: string) => k.startsWith("ARCHIL_")), "no Archil key in the instance's environment");
    assert.deepEqual(JSON.parse(seen.holder), { driver: "local", mode: "child", host: "host-a", bootId: currentBootId(), mountpoint: "/mnt/x/runs/r1", tag: h.tag });
    assert.equal(h.pid, seen.pid);
    assert.equal(h.startTicks, procStartTicks(seen.pid));
    assert.equal(await host.status(h), "running");
    await host.stop(h);
    assert.equal(await host.status(h), "stopped");
    assert.ok(procStartTicks(grandchild) !== null, "development mode has no cgroup: a detached command survives its instance");
    assert.equal(await host.status({ ...h, startTicks: 1 }), "stopped", "a reused pid is not the instance");
  } finally {
    if (grandchild) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {}
    }
    if (prevKey === undefined) delete process.env.ARCHIL_API_KEY;
    else process.env.ARCHIL_API_KEY = prevKey;
  }
});

test("stop: a unit wedged in its mount (stop times out, still running) gets its FUSE daemon killed, then stops", async () => {
  const w = world();
  w.setMounted(true);
  let scope = true;
  let wedged = true;
  const { calls, exec } = recorder((argv) => {
    if (argv.includes("list-units")) return ok(scope ? "pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n" : "");
    if (argv.includes("stop") && wedged) return { code: null, timedOut: true, stdout: "", stderr: "" };
    if (argv[1] === "show") return ok(wedged ? "LoadState=loaded\nActiveState=deactivating\n" : "LoadState=not-found\n");
    if (argv.includes("kill")) {
      scope = false;
      wedged = false;
      w.setMounted(false);
    }
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000", stopTimeoutMs: 1_000 });
  await host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp });
  const argvs = calls.map((c) => c.argv.join(" "));
  const stops = argvs.filter((a) => a.endsWith("systemctl stop pda-t-r1-x.service"));
  assert.equal(stops.length, 2, "stopped once more after the kill");
  assert.ok(argvs.indexOf("/usr/bin/sudo -n /usr/bin/systemctl kill --signal=SIGKILL pda-t-r1-x-fuse-1.scope") < argvs.lastIndexOf("/usr/bin/sudo -n /usr/bin/systemctl stop pda-t-r1-x.service"));
  assert.ok(!argvs.some((a) => a.includes("archil unmount")), "the daemon was killed and the mount went with it");
});

test("stop: a unit that still will not stop after its daemon is killed is a typed failure", async () => {
  const w = world();
  const { exec } = recorder((argv) => {
    if (argv.includes("stop")) return { code: null, timedOut: true, stdout: "", stderr: "" };
    if (argv[1] === "show") return ok("LoadState=loaded\nActiveState=active\n");
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000", stopTimeoutMs: 1_000 });
  await assert.rejects(host.stop({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: w.mp }), (e: unknown) => e instanceof PdaError && e.code === "STOP_FAILED");
});

// ---- a dead mount left behind (power off, OOM kill of the daemon) --------------------------------------------------------

const DEAD = { code: 1, timedOut: false, stdout: "", stderr: "stat: cannot statx '/x': Transport endpoint is not connected" };
const handleFor = (mp: string) => ({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "pda-t-r1-x", mountpoint: mp });

test("stop after a power off: no FUSE scope left, the dead mount is removed with fusermount -u and the table confirms it", async () => {
  const w = world();
  w.setMounted(true);
  const { calls, exec } = recorder((argv) => {
    if (argv.includes("list-units")) return ok("");
    if (argv[0] === "/usr/bin/stat") return DEAD;
    if (argv.includes("/usr/bin/fusermount")) w.setMounted(false);
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  await host.stop(handleFor(w.mp));
  const argvs = calls.map((c) => c.argv.join(" "));
  assert.ok(argvs.includes(`/usr/bin/stat -c %i ${w.mp}`), "the daemon is checked from a child process");
  assert.ok(argvs.includes(`/usr/bin/sudo -n /usr/bin/fusermount -u ${w.mp}`));
  assert.ok(!argvs.some((a) => a.includes("/usr/bin/umount") || a.includes("archil unmount") || a.includes(" kill ")), "nothing else was needed");
  assert.ok(!readFileSync(w.procMounts, "utf8").includes(w.mp), "the mount table no longer lists it");
});

test("stop after a power off: a dead mount fusermount cannot remove goes with umount -l; one neither removes is a typed failure", async () => {
  {
    const w = world();
    w.setMounted(true);
    const { calls, exec } = recorder((argv) => {
      if (argv.includes("list-units")) return ok("");
      if (argv[0] === "/usr/bin/stat") return DEAD;
      if (argv.includes("/usr/bin/umount")) w.setMounted(false);
      return undefined;
    });
    const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
    await host.stop(handleFor(w.mp));
    const argvs = calls.map((c) => c.argv.join(" "));
    assert.ok(argvs.indexOf(`/usr/bin/sudo -n /usr/bin/umount -l ${w.mp}`) > argvs.indexOf(`/usr/bin/sudo -n /usr/bin/fusermount -u ${w.mp}`));
  }
  {
    const w = world();
    w.setMounted(true);
    const { exec } = recorder((argv) => (argv.includes("list-units") ? ok("") : argv[0] === "/usr/bin/stat" ? DEAD : undefined));
    const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
    await assert.rejects(host.stop(handleFor(w.mp)), (e: unknown) => e instanceof PdaError && e.code === "STOP_FAILED" && /still mounted/.test(e.message));
  }
});

test("stop never touches a mount whose daemon answers, or one that does not answer in time, when no scope of this unit is alive", async () => {
  for (const [name, statResult] of [
    ["live (a newer instance's mount)", ok("4294")],
    ["stuck (a frozen daemon: the stat times out)", { code: null, timedOut: true, stdout: "", stderr: "" }],
  ] as const) {
    const w = world();
    w.setMounted(true);
    const { calls, exec } = recorder((argv) => (argv.includes("list-units") ? ok("") : argv[0] === "/usr/bin/stat" ? statResult : undefined));
    const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
    await host.stop(handleFor(w.mp));
    const argvs = calls.map((c) => c.argv.join(" "));
    assert.ok(!argvs.some((a) => /fusermount|umount|archil unmount|rmdir/.test(a)), `${name}: untouched`);
    assert.ok(readFileSync(w.procMounts, "utf8").includes(w.mp), `${name}: still mounted`);
  }
});

test("stop: a daemon SIGKILLed through its scope leaves a dead mount behind, which is then removed", async () => {
  const w = world();
  w.setMounted(true);
  let scope = true;
  const { calls, exec } = recorder((argv) => {
    if (argv.includes("list-units")) return ok(scope ? "pda-t-r1-x-fuse-1.scope loaded active running /usr/bin/archil mount\n" : "");
    if (argv.includes("unmount")) return { code: null, timedOut: true, stdout: "", stderr: "" };
    if (argv.includes("kill")) scope = false;
    if (argv[0] === "/usr/bin/stat") return scope ? ok("1") : DEAD;
    if (argv.includes("/usr/bin/fusermount")) w.setMounted(false);
    return undefined;
  });
  const host = localHost({ exec, hostName: "host-a", procMounts: w.procMounts, mountRoot: w.mountRoot, user: "1000", group: "1000" });
  await host.stop(handleFor(w.mp));
  const argvs = calls.map((c) => c.argv.join(" "));
  const kill = argvs.findIndex((a) => a.includes("systemctl kill"));
  const fuser = argvs.findIndex((a) => a.includes("fusermount -u"));
  assert.ok(kill >= 0 && fuser > kill, "the dead mount is removed after the kill");
  assert.ok(!readFileSync(w.procMounts, "utf8").includes(w.mp));
});
