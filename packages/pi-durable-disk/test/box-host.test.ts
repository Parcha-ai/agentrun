// boxHost over transport's fake provider (T9): what it asks the provider, and how it behaves when the provider or the box
// says no. No network, no key, no real box: a box is the fake's, and its programs are functions.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { daytonaLike, fakeBoxes, fakeClock, modalLike, type FakeProvider } from "@parcha/pi-transport/testing";
import type { Box, BoxSpec } from "@parcha/pi-transport";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { boxHost, BoxHostError } from "../src/box-host.ts";
import type { HostHandle } from "../src/supervise.ts";

/** Every fake provider a test makes; their boxes end after the file (a live box's lifetime timer would hold the process). */
const providers: FakeProvider[] = [];
const fake = (options?: Parameters<typeof fakeBoxes>[0]) => {
  const provider = fakeBoxes(options);
  providers.push(provider);
  return provider;
};
after(() => {
  for (const provider of providers) provider.endAll();
});

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const SPEC: BoxSpec = { maxLifetimeMs: 3_600_000, image: "pda-home" };
const TOKEN = `tok-${"7".repeat(24)}`;
const fd = { secretsVia: "fd" as const };
const code = (c: string) => (e: unknown) => e instanceof BoxHostError && e.code === c;
const host = (provider: FakeProvider, more: Partial<Parameters<typeof boxHost>[0]> = {}) => boxHost({ provider, spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000, ...more });

describe("boxHost: its options", () => {
  it("refuses at once, INVALID_ARGUMENT: no provider, no positive maxLifetimeMs, spec.env, a label key that is transport's or boxHost's, no app, an empty command, a bad user, a relative mountRoot", () => {
    const provider = fake(modalLike({ facts: fd }));
    const bad: [string, () => unknown][] = [
      ["no provider", () => boxHost({ provider: undefined as never, spec: SPEC, app: "/a.js" })],
      ["no maxLifetimeMs", () => boxHost({ provider, spec: { image: "x" } as BoxSpec, app: "/a.js" })],
      ["maxLifetimeMs 0", () => boxHost({ provider, spec: { maxLifetimeMs: 0 }, app: "/a.js" })],
      ["spec.env", () => boxHost({ provider, spec: { ...SPEC, env: { A: "1" } }, app: "/a.js" })],
      ["pi-transport label", () => boxHost({ provider, spec: { ...SPEC, labels: { "pi-transport": "x" } }, app: "/a.js" })],
      ["pi-transport.* label", () => boxHost({ provider, spec: { ...SPEC, labels: { "pi-transport.owner": "x" } }, app: "/a.js" })],
      ["boxHost's own label", () => boxHost({ provider, spec: { ...SPEC, labels: { "pi-durable-disk.run": "x" } }, app: "/a.js" })],
      ["no app", () => boxHost({ provider, spec: SPEC, app: "" })],
      ["empty command", () => boxHost({ provider, spec: SPEC, app: "/a.js", command: [] })],
      ["a bad runAs", () => boxHost({ provider, spec: SPEC, app: "/a.js", runAs: "Bad User" })],
      ["runAs root by name", () => boxHost({ provider, spec: SPEC, app: "/a.js", runAs: "root" })],
      ["runAs root by uid", () => boxHost({ provider, spec: SPEC, app: "/a.js", runAs: "0" })],
      ["runAs root by a padded uid", () => boxHost({ provider, spec: SPEC, app: "/a.js", runAs: "000" })],
      ["relative mountRoot", () => boxHost({ provider, spec: SPEC, app: "/a.js", mountRoot: "mnt" })],
    ];
    for (const [why, make] of bad) assert.throws(make, code("INVALID_ARGUMENT"), why);
    assert.equal(provider.calls.length, 0, "nothing was asked of the provider");
    const ok = host(provider);
    assert.equal(ok.provider, provider.name, "the driver names its provider: a place hands HOST_BOX over");
    assert.equal(ok.kills, "box");
  });

  it("a start with no mount token, or with no attempt, is INVALID_ARGUMENT before any call", async () => {
    const provider = fake(modalLike({ facts: fd }));
    const driver = host(provider);
    await assert.rejects(driver.start(REF, "", { attempt: 1 }), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, TOKEN), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 0 }), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1, env: { PATH: "/x" } }), code("INVALID_ARGUMENT"), "attemptEnv's rules");
    assert.equal(provider.calls.length, 0);
  });
});

describe("boxHost: an environment the launcher refuses is refused before any box", () => {
  it("a launcher-internal, loader or LD_ name (in options.env or the start's env) is INVALID_ARGUMENT before any call to the provider, naming the variable, never its value; never run as root; not remembered", async () => {
    const VALUE = `v-${"q".repeat(14)}`;
    for (const [why, opts, env] of [
      ["a launcher-internal name in options.env", { env: { D: VALUE } }, {}],
      ["a loader name in options.env", { env: { BASH_ENV: VALUE } }, {}],
      ["an LD_ name in options.env", { env: { LD_PRELOAD: VALUE } }, {}],
      ["an LD_ name in the start's env", {}, { LD_LIBRARY_PATH: VALUE }],
      ["a launcher-internal name in the start's env", {}, { RUNAS: VALUE }],
    ] as const) {
      const provider = fake(modalLike({ facts: fd }));
      provider.program("pi-durable-disk", () => 0);
      const driver = host(provider, opts as Partial<Parameters<typeof boxHost>[0]>);
      const name = Object.keys({ ...(opts as { env?: object }).env, ...env })[0]!;
      for (const round of [1, 2]) {
        await assert.rejects(driver.start(REF, TOKEN, { attempt: round, env: env as Record<string, string> }), (e: unknown) => {
          assert.ok(code("INVALID_ARGUMENT")(e), `${why}: ${String(e)}`);
          assert.ok((e as Error).message.includes(name), `${why}: names ${name}`);
          assert.ok(!(e as Error).message.includes(VALUE) && !String((e as { cause?: unknown }).cause).includes(VALUE), `${why}: never the value`);
          return true;
        });
      }
      assert.equal(provider.calls.length, 0, `${why}: no call to the provider, so no VM is booted, on any tick`);
    }
  });
});

describe("boxHost: the instance holds the token as root, and every agent command runs as runAs (never root)", () => {
  it("launches the instance as root with --run-as <runAs> (default pda; disk's own spawn drops every command to it, with no capabilities); the token rides only the launch's stdin; nothing goes through sudo", async () => {
    for (const [why, runAs, want] of [["the default", undefined, "pda"], ["a named user", "agent", "agent"], ["a uid", "1500", "1500"]] as const) {
      const provider = fake(modalLike({ facts: fd }));
      provider.program("pi-durable-disk", ({ signal }) => new Promise<number>((r) => signal.addEventListener("abort", () => r(0))));
      const driver = host(provider, runAs === undefined ? {} : { runAs });
      await driver.start(REF, TOKEN, { attempt: 1 });
      const launch = provider.boxes[0]!.launches[0]!;
      assert.equal(launch.spec.user, "root", `${why}: the instance runs as root`);
      const argv = launch.spec.argv;
      assert.deepEqual(argv.slice(argv.indexOf("--run-as"), argv.indexOf("--run-as") + 2), ["--run-as", want], `${why}: the tools' user`);
      assert.equal(launch.spec.toolsUser, want, `${why}: the launcher verifies the very user --run-as drops every command to (toolsUser), from one value`);
      assert.ok(!argv.some((a) => /sudo/.test(a)) && argv[0] !== "sudo", `${why}: nothing goes through sudo, so the tools' user needs no sudo rule`);
      assert.deepEqual(provider.leaks(TOKEN).map((l) => `${l.op}:${l.where}`), ["launch:stdin"]);
    }
  });
});

describe("boxHost: the box it asks for, and a box that cannot hold the mount", () => {
  it("creates with the spec, capabilities fuse added, its three labels and the box's minted key; never an env in the spec", async () => {
    const provider = fake(daytonaLike());
    await assert.rejects(host(provider, { spec: { ...SPEC, capabilities: [], labels: { team: "crew" } } }).start(REF, TOKEN, { attempt: 3 }), code("UNSUPPORTED"));
    const asked = provider.callsOf("create")[0]!.spec!;
    assert.deepEqual(asked.capabilities, ["fuse"]);
    const { "agentrun-host-key": key, ...rest } = asked.labels!;
    assert.deepEqual(rest, { team: "crew", "pi-durable-disk.disk": REF.disk, "pi-durable-disk.run": REF.id, "pi-durable-disk.attempt": "3" });
    assert.match(String(key), /^r1\/3\/[0-9a-f]{16}$/, "no HOST_BOX: the run's id and the attempt, then the nonce");
    assert.equal(asked.env, undefined);
    assert.equal(asked.maxLifetimeMs, SPEC.maxLifetimeMs);
  });

  it("a box without the fuse fact, or with no fd for the launcher's frame, is destroyed and the start is UNSUPPORTED; every later start of that spec is refused at once, with no box made", async () => {
    for (const [why, provider] of [
      ["no fuse", fake(daytonaLike({ facts: fd }))],
      ["fuse absent", fake(modalLike({ facts: { ...fd, fuse: undefined } }))],
      ["no secretsVia", fake(modalLike())],
      ["secretsVia file", fake(modalLike({ facts: { secretsVia: "file" } }))],
      ["no live processes", fake(modalLike({ facts: { ...fd, liveProcesses: false } }))],
    ] as const) {
      const driver = host(provider, { files: [{ path: "/opt/app/app.js", bytes: new TextEncoder().encode("export default {};\n") }] });
      await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), code("UNSUPPORTED"), why);
      assert.ok(provider.boxes.every((b) => b.state === "ended"), `${why}: the box is destroyed, never left running`);
      assert.deepEqual(provider.calls.filter((c) => ["upload", "exec", "launch"].includes(c.op)).map((c) => c.op), [], `${why}: refused before any upload or launch`);
      await assert.rejects(driver.start(REF, TOKEN, { attempt: 2 }), (e: unknown) => code("UNSUPPORTED")(e) && /refused before/.test((e as Error).message), `${why}: refused again`);
      assert.equal(provider.callsOf("create").length, 1, `${why}: no second box (ensureRunning has no backoff: a VM a tick would be booted and destroyed)`);
      assert.equal(provider.leaks(TOKEN).length, 0, `${why}: the token went nowhere`);
    }
  });

  it("a create the provider refuses: invalid is INVALID_ARGUMENT, unsupported is UNSUPPORTED and remembered, capacity is CREATE_FAILED and not remembered", async () => {
    const cases = [
      { fail: "invalid", expect: "INVALID_ARGUMENT", remembered: false },
      { fail: "unsupported", expect: "UNSUPPORTED", remembered: true },
      { fail: "capacity", expect: "CREATE_FAILED", remembered: false },
    ] as const;
    for (const c of cases) {
      const provider = fake(daytonaLike({ facts: fd }));
      provider.script.on({ op: "create" }, { fail: c.fail }, { times: 1 });
      const driver = host(provider);
      await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), (e: unknown) => code(c.expect)(e) && (e as { cause?: { code?: string } }).cause?.code === c.fail, c.fail);
      await driver.start(REF, TOKEN, { attempt: 1 }).catch(() => undefined);
      assert.equal(provider.callsOf("create").length, c.remembered ? 1 : 2, `${c.fail}: ${c.remembered ? "remembered: no second create" : "a later start creates again"}`);
    }
  });

  it("a box a failed create made anyway is found by its labels and dealt with, never leaked", async () => {
    const provider = fake(daytonaLike({ facts: fd }));
    provider.script.on({ op: "create" }, { fail: "unknown", leakBox: true });
    await assert.rejects(host(provider).start(REF, TOKEN, { attempt: 1 }), code("UNSUPPORTED"), "found, then refused for its facts");
    assert.equal(provider.boxes.length, 1, "the one box the failed create made");
    assert.equal(provider.boxes[0]!.state, "ended", "destroyed, not leaked");
    assert.ok(provider.callsOf("list").length >= 1, "it looked for it by its labels");
  });
});

describe("boxHost: status, stop and kill of a handle", () => {
  const handleFor = (provider: FakeProvider, box: string): HostHandle => ({ driver: "box", provider: provider.name, box, attempt: 1, launch: { v: 1, name: "pda-r1-g1" } });

  it("a handle that is not its own is unknown to status and a no-op to stop and kill; a box that is gone or ended is gone", async () => {
    const provider = fake(modalLike({ facts: fd }));
    const driver = host(provider);
    const other: HostHandle = { driver: "daytona", sandboxId: "x" };
    assert.equal(await driver.status(other), "unknown");
    await driver.stop(other);
    await driver.kill!(other);
    assert.equal(provider.calls.length, 0, "nothing asked for another driver's handle");
    assert.equal(await driver.status(handleFor(provider, "fake-404")), "gone", "no such box");
    await driver.stop(handleFor(provider, "fake-404"));
    await driver.kill!(handleFor(provider, "fake-404"));
    const made = await provider.create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
    assert.ok(made.ok);
    made.value.end(0);
    assert.equal(await driver.status(handleFor(provider, made.value.id)), "gone", "an ended box");
  });

  it("status is unknown when the provider cannot be asked; kill destroys the box at once", async () => {
    const provider = fake(modalLike({ facts: fd }));
    const driver = host(provider);
    const made = await provider.create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
    assert.ok(made.ok);
    provider.script.on({ op: "attach" }, { fail: "unknown" });
    assert.equal(await driver.status(handleFor(provider, made.value.id)), "unknown");
    await driver.kill!(handleFor(provider, made.value.id));
    assert.equal(made.value.state, "ended");
    assert.ok(!provider.calls.some((c) => c.op === "launchStop"), "a kill never drains: it is a crash");
  });
});

describe("boxHost: the launch, a start found again, status, stop and receipts", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const forever = ({ signal }: { signal: AbortSignal }) => new Promise<number>((resolve) => signal.addEventListener("abort", () => resolve(0)));
  const modal = () => {
    const provider = fake(modalLike({ facts: fd }));
    provider.program("pi-durable-disk", forever);
    return provider;
  };
  const APP_FILE = { path: "/opt/app/app.js", bytes: new TextEncoder().encode("export default {};\n") };

  it("launches this package's CLI as the run user, with the mount token on that launch's stdin and NOWHERE else; the env is PDA_HOLDER, its own and the start's, never PATH, HOME or LANG", async () => {
    const provider = modal();
    const driver = host(provider, { env: { DEMO_MODE: "fixture" }, files: [APP_FILE] });
    const handle = await driver.start(REF, TOKEN, { attempt: 2, env: { HOST_BOX: '{"provider":"modal-like","key":"0","run":"life-1"}', RUN_LABEL: "life-1" } });
    const box = provider.boxes[0]!;
    assert.deepEqual(handle, { driver: "box", provider: provider.name, box: box.id, attempt: 2, launch: { v: 1, name: "pda-r1-g2" } });
    const launch = box.launches[0]!;
    assert.deepEqual(launch.spec.argv, ["pi-durable-disk", "run", "--disk", REF.disk, "--region", REF.region, "--id", REF.id, "--mount-root", "/mnt/archil", "--archil", "/usr/local/sbin/archil-scoped", "--app", "/opt/app/app.js", "--run-as", "pda", "--token-stdin"]);
    assert.equal(launch.spec.user, "root", "the instance holds the token as root; every agent command runs as pda (--run-as)");
    assert.equal(launch.spec.inheritEnv, false);
    assert.equal(launch.spec.restart, true);
    assert.deepEqual(launch.spec.terminalExits, [65, 70, 75, 76]);
    assert.deepEqual(Object.keys(launch.spec.env!).sort(), ["DEMO_MODE", "HOST_BOX", "PDA_HOLDER", "RUN_LABEL"]);
    assert.deepEqual(JSON.parse(launch.spec.env!.PDA_HOLDER!), handle, "the holder is the handle");
    assert.equal(new TextDecoder().decode(launch.spec.stdin), `${TOKEN}\n`);
    const leaks = provider.leaks(TOKEN);
    assert.deepEqual(leaks.map((l) => `${l.op}:${l.where}`), ["launch:stdin"], "the token is on the launch's stdin and nowhere else: no argv, env, label, spec, upload or exec");
    const ops = provider.calls.map((c) => c.op);
    assert.ok(ops.indexOf("upload") < ops.indexOf("launch"), "the app's files go up before the launch");
    assert.ok(!ops.includes("exec"), "boxHost makes no exec of its own");
    assert.equal(await driver.status(handle), "running");
  });

  it("a start of the same attempt finds its box: a running launch is adopted (no create, no second launch, the new token used nowhere); a launch that ended or was lost means a new box, never a relaunch", async () => {
    const provider = modal();
    const driver = host(provider, { files: [APP_FILE] });
    const first = await driver.start(REF, TOKEN, { attempt: 1 });
    const second = await driver.start(REF, "tok-second-unused", { attempt: 1 });
    assert.deepEqual(second, { ...first, adopted: true });
    assert.equal(provider.callsOf("create").length, 1);
    assert.equal(provider.callsOf("launch").length, 1);
    assert.equal(provider.callsOf("upload").length, 1, "no upload into a box found again");
    assert.deepEqual(provider.leaks("tok-second-unused"), [], "an adopted start's token goes nowhere");
    for (const [why, end] of [
      ["exited 65", (l: { exit(code: number): void }) => l.exit(65)],
      ["lost", (l: { setState(s: object): void }) => l.setState({ phase: "lost", launcherAlive: false })],
    ] as const) {
      const before = provider.boxes.filter((b) => b.state === "running");
      end(before.at(-1)!.launches.at(-1)! as never);
      await tick();
      const again = await driver.start(REF, TOKEN, { attempt: 1 });
      assert.notEqual(again.box, before.at(-1)!.id, `${why}: a new box`);
      assert.equal(before.at(-1)!.state, "ended", `${why}: the old box destroyed`);
      assert.equal(before.at(-1)!.launches.length, 1, `${why}: never relaunched in the old box`);
    }
  });

  it("names its boxes by provider and box id, the same for a fresh handle and an adopted one, so a place keeps an adopted box's key; another driver's handle names nothing", async () => {
    const provider = modal();
    const driver = host(provider);
    const first = await driver.start(REF, TOKEN, { attempt: 1 });
    const adopted = await driver.start(REF, TOKEN, { attempt: 1 });
    assert.equal(adopted.adopted, true);
    assert.ok(driver.instanceOf(first) !== undefined && driver.instanceOf(first) === driver.instanceOf(adopted));
    provider.boxes[0]!.launches[0]!.setState({ phase: "lost", launcherAlive: false });
    const replaced = await driver.start(REF, TOKEN, { attempt: 1 });
    assert.notEqual(replaced.box, first.box, "the lost launch's box was replaced");
    assert.notEqual(driver.instanceOf(replaced), driver.instanceOf(first), "a new box for the same attempt is another instance");
    const other = await driver.start(REF, TOKEN, { attempt: 2 });
    assert.notEqual(driver.instanceOf(other), driver.instanceOf(first), "another attempt's box");
    assert.equal(driver.instanceOf({ driver: "daytona", sandboxId: "sb-1" }), undefined);
    assert.equal(driver.instanceOf({ ...first, provider: "another-provider" }), undefined, "a box of another provider is not this driver's");
  });

  it("status maps the launcher's phases: running while it runs or stops, stopped on a clean end, failed on any other end, a lost launcher or none, unknown when unreadable", async () => {
    const provider = modal();
    const driver = host(provider);
    const handle = await driver.start(REF, TOKEN, { attempt: 1 });
    const launch = provider.boxes[0]!.launches[0]!;
    const cases: [object, string][] = [
      [{ phase: "starting" }, "running"],
      [{ phase: "running" }, "running"],
      [{ phase: "restarting" }, "running"],
      [{ phase: "stopping" }, "running"],
      [{ phase: "stopped" }, "stopped"],
      [{ phase: "exited", lastExit: 0 }, "stopped"],
      [{ phase: "exited", lastExit: 1 }, "failed"],
      [{ phase: "gave_up", lastExit: 1 }, "failed"],
      [{ phase: "lost", launcherAlive: false }, "failed"],
    ];
    for (const [state, want] of cases) {
      launch.setState(state);
      assert.equal(await driver.status(handle), want, JSON.stringify(state));
    }
    provider.script.on({ op: "launchState" }, { fail: "unknown" });
    assert.equal(await driver.status(handle), "unknown", "an unreadable state");
    assert.equal(await driver.status({ ...handle, launch: { v: 1, name: "never-launched" } }), "failed", "a live box with no such launch");
  });

  it("stop drains the instance, then destroys the box; the receipt is facts only: provider, kind, from (startedAt) and to", async () => {
    const provider = modal();
    const driver = host(provider, { stopGraceMs: 50 });
    const handle = await driver.start(REF, TOKEN, { attempt: 1 });
    const box = provider.boxes[0]!;
    const open = driver.box(handle)!;
    assert.deepEqual({ ...open, from: typeof open.from, key: typeof open.key }, { provider: provider.name, kind: "vm", from: "string", to: null, key: "string" });
    assert.equal(open.key, box.spec.labels?.["agentrun-host-key"], "the key is the box's label");
    assert.equal(open.from, box.facts().startedAt, "from is the box's own startedAt");
    assert.ok(!("usdPerSecond" in open), "no price");
    await driver.stop(handle);
    const ops = provider.calls.map((c) => c.op);
    assert.ok(ops.lastIndexOf("launchStop") < ops.lastIndexOf("destroy"), "the drain before the destroy");
    assert.equal(box.launches[0]!.events[0], "drain");
    assert.equal(box.state, "ended");
    assert.equal(typeof driver.box(handle)!.to, "string", "to is set once the box is gone");
    assert.equal(await driver.status(handle), "gone");
  });

  it("a launch the launcher already reports could not run (exit 126: the user switch, the env clear or the cwd) is a FAILED start: LAUNCH_FAILED naming the exit, the box destroyed, not remembered", async () => {
    const provider = modal();
    // As a real launcher can answer when its first incarnation failed before the state was read: ok(), restarting, exit 126.
    const said126 = (box: Box): Box =>
      new Proxy(box, {
        get(target, key) {
          if (key === "launcher") {
            const real = target.launcher!;
            return { ...real, launch: async (...args: Parameters<typeof real.launch>) => {
              const r = await real.launch(...args);
              return r.ok ? { ok: true as const, value: { ...r.value, phase: "restarting" as const, lastExit: 126 } } : r;
            } };
          }
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    let first = true;
    const wrapped: FakeProvider = Object.assign(Object.create(provider) as FakeProvider, {
      create: async (spec: BoxSpec, context: Parameters<FakeProvider["create"]>[1]) => {
        const made = await provider.create(spec, context);
        if (!made.ok || !first) return made;
        first = false;
        return { ok: true as const, value: said126(made.value) as never };
      },
    });
    const driver = host(wrapped);
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), (e: unknown) => code("LAUNCH_FAILED")(e) && /exit 126/.test((e as Error).message));
    assert.equal(provider.boxes[0]!.state, "ended", "the box is destroyed");
    const second = await driver.start(REF, TOKEN, { attempt: 1 });
    assert.equal(second.adopted, undefined, "not remembered: a later start launches again, in a new box");
    assert.equal(provider.callsOf("create").length, 2);
  });

  it("an instance whose every incarnation exits 126 is never reported running for long: the launcher gives up, and status says failed", async () => {
    const clock = fakeClock(Date.now());
    const provider = fake(modalLike({ facts: fd, clock }));
    // Every incarnation exits 126, as each would when the launcher cannot run the program as its user.
    provider.program("pi-durable-disk", () => 126);
    const driver = host(provider);
    const handle = await driver.start(REF, TOKEN, { attempt: 1 }).catch((e: unknown) => e);
    if (handle instanceof BoxHostError) return assert.equal(handle.code, "LAUNCH_FAILED", "or refused at the start already");
    // The launcher's restart delay and its limit (5 in 60 s) run on the fake's clock.
    let status = await driver.status(handle as HostHandle);
    for (let i = 0; i < 20 && status !== "failed"; i++) {
      await clock.advance(1_100);
      await tick();
      status = await driver.status(handle as HostHandle);
    }
    assert.equal(status, "failed");
  });

  it("the launch's errors: refused, unsupported and unsafe are UNSUPPORTED and remembered; timeout is START_TIMED_OUT; failed and box are LAUNCH_FAILED and not remembered; invalid is INVALID_ARGUMENT; the box is destroyed every time", async () => {
    const cases = [
      { fail: "refused", expect: "UNSUPPORTED", remembered: true },
      { fail: "unsupported", expect: "UNSUPPORTED", remembered: true },
      { fail: "unsafe", expect: "UNSUPPORTED", remembered: true },
      { fail: "timeout", expect: "START_TIMED_OUT", remembered: false },
      { fail: "failed", expect: "LAUNCH_FAILED", remembered: false },
      { fail: "box", expect: "LAUNCH_FAILED", remembered: false },
      { fail: "invalid", expect: "INVALID_ARGUMENT", remembered: false },
    ] as const;
    for (const c of cases) {
      const provider = modal();
      provider.script.on({ op: "launch" }, { fail: c.fail as never }, { times: 1 });
      const driver = host(provider);
      await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), (e: unknown) => code(c.expect)(e) && (e as { cause?: { code?: string } }).cause?.code === c.fail, c.fail);
      assert.equal(provider.boxes[0]!.state, "ended", `${c.fail}: the box is destroyed`);
      await driver.start(REF, TOKEN, { attempt: 1 }).catch(() => undefined);
      assert.equal(provider.callsOf("create").length, c.remembered ? 1 : 2, `${c.fail}: ${c.remembered ? "remembered" : "a later start tries again"}`);
    }
  });

  it("an unsafe launch (a spool or launch directory another user could change: the image's layout, so a retry repeats it) ends the box and is UNSUPPORTED naming the code and the path; the next tick makes no box", async () => {
    const provider = modal();
    const why = "/tmp/.pi-transport-launch belongs to uid 1500, not to the launcher's uid 0";
    provider.script.on({ op: "launch" }, { fail: "unsafe", message: why }, { times: 1 });
    const driver = host(provider);
    const named = (e: unknown) => code("UNSUPPORTED")(e) && (e as Error).message.includes("(unsafe)") && (e as Error).message.includes(why);
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), named);
    assert.equal(provider.boxes[0]!.state, "ended", "the box is ended");
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 2 }), (e: unknown) => named(e) && /refused before/.test((e as Error).message), "the next tick is refused at once");
    assert.equal(provider.callsOf("create").length, 1, "no second box");
  });
});

describe("boxHost: a box found again by attach whose facts fail what the start needs (the caller rule)", () => {
  // The provider's attach reads the facts again; an ok attach carries only measured ones. Here the read says the box
  // cannot serve (fuse, the fd, the GPU it asked for): the box is the real one, so ending it through the handle ends it.
  const misread = (provider: FakeProvider, bad: Record<string, unknown>): FakeProvider => ({
    ...provider,
    attach: async (id, context) => {
      const r = await provider.attach(id, context);
      if (!r.ok || r.value === undefined) return r;
      const real = r.value;
      const box = new Proxy(real, {
        get: (target, key) => {
          if (key === "facts") return () => ({ ...target.facts(), ...bad });
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { ok: true, value: box } as typeof r;
    },
  });
  const runs = (provider: FakeProvider) => provider.program("pi-durable-disk", ({ signal }) => new Promise<number>((r) => signal.addEventListener("abort", () => r(0))));
  const running = (provider: FakeProvider) => provider.boxes.filter((b) => b.state === "running");
  const seqOf = (provider: FakeProvider, op: string, box?: string, nth = 1) => provider.calls.filter((c) => c.op === op && (box === undefined || c.box === box))[nth - 1]?.seq;

  it("ends a running box whose facts fail the needs through its handle BEFORE it creates the replacement, launches in the replacement, and never adopts it", async () => {
    for (const [why, bad] of [["fuse not true", { fuse: false }], ["no fd for the frame", { secretsVia: "stdin" }], ["no live processes", { liveProcesses: false }]] as const) {
      const provider = fake(modalLike({ facts: fd }));
      runs(provider);
      const hA = await host(provider).start(REF, TOKEN, { attempt: 1 });
      const hB = await boxHost({ provider: misread(provider, bad), spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 });
      assert.notEqual(hB.adopted, true, `${why}: never adopted`);
      assert.notEqual(hB.box, hA.box, `${why}: a replacement`);
      const ended = seqOf(provider, "destroy", String(hA.box));
      const replaced = seqOf(provider, "create", undefined, 2);
      assert.ok(ended !== undefined && replaced !== undefined && ended < replaced, `${why}: ended (${ended}) before the replacement's create (${replaced})`);
      assert.deepEqual(running(provider).map((b) => b.id), [hB.box], `${why}: exactly one box running, the replacement`);
    }
  });

  it("an end that fails makes nothing: STOP_FAILED, no replacement, and the box is still there", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await host(provider).start(REF, TOKEN, { attempt: 1 });
    provider.script.on({ op: "destroy" }, { fail: "unknown" });
    const creates = provider.calls.filter((c) => c.op === "create").length;
    await assert.rejects(boxHost({ provider: misread(provider, { fuse: false }), spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 }), code("STOP_FAILED"));
    assert.equal(provider.calls.filter((c) => c.op === "create").length, creates, "no replacement while the first may still serve");
    assert.deepEqual(running(provider).map((b) => b.id), [hA.box]);
  });

  it("a box found again that never launched, with a needed fact present and wrong: ended and replaced, and no refusal is remembered for the spec", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const labels = { "pi-durable-disk.disk": REF.disk, "pi-durable-disk.run": REF.id, "pi-durable-disk.attempt": "1" };
    const made = await provider.create({ ...SPEC, capabilities: ["fuse"], labels }, BACKGROUND_CONTEXT);
    assert.ok(made.ok);
    const driver = boxHost({ provider: misread(provider, { fuse: false }), spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 });
    const h = await driver.start(REF, TOKEN, { attempt: 1 });
    assert.notEqual(h.box, made.value.id);
    assert.equal(made.value.state, "ended");
    assert.deepEqual(running(provider).map((b) => b.id), [h.box]);
    await driver.start(REF, TOKEN, { attempt: 2 }).then((h2) => assert.ok(h2.box !== undefined, "a later start is not refused"));
  });

  it("a GPU it asked for, as create judges it: a measured none (null) is ended and replaced; a model name is never compared, so a served model is kept", async () => {
    const gpus = () => fake({ name: "gpus", facts: { ...fd, fuse: true, liveProcesses: true } });
    for (const [why, asked, measured, kept] of [
      ["the measured name of the model asked for, '!' exact", "H100!", "NVIDIA H100 80GB HBM3", true],
      ["another model for a bare request, which the provider may serve", "H100", "NVIDIA H200", true],
      ["a measured none", "T4", null, false],
    ] as const) {
      const provider = gpus();
      runs(provider);
      const spec = { ...SPEC, gpu: asked };
      const hA = await boxHost({ provider, spec, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 });
      const hB = await boxHost({ provider: misread(provider, { gpu: measured }), spec, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 });
      if (kept) {
        assert.equal(hB.box, hA.box, `${why}: kept`);
        assert.equal(hB.adopted, true, `${why}: adopted`);
        assert.equal(provider.calls.filter((c) => c.op === "destroy").length, 0, `${why}: nothing ended`);
      } else {
        assert.notEqual(hB.box, hA.box, `${why}: replaced`);
        assert.deepEqual(running(provider).map((b) => b.id), [hB.box], `${why}: exactly one box running`);
      }
    }
  });

  it("an ok attach with a needed fact ABSENT (no measurement: a tag carries no security fact) ends nothing and creates nothing: the start fails for the next tick, the box keeps running, and it is never used", async () => {
    for (const [why, bad, spec] of [["secretsVia absent", { secretsVia: undefined }, SPEC], ["fuse absent", { fuse: undefined }, SPEC], ["the GPU asked for, absent", { gpu: undefined }, { ...SPEC, gpu: "T4" }]] as const) {
      const provider = why.includes("GPU") ? fake({ name: "gpus", facts: { ...fd, fuse: true, liveProcesses: true } }) : fake(modalLike({ facts: fd }));
      runs(provider);
      const hA = await boxHost({ provider, spec, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 });
      const creates = provider.calls.filter((c) => c.op === "create").length;
      await assert.rejects(boxHost({ provider: misread(provider, bad), spec, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 }).start(REF, TOKEN, { attempt: 1 }), code("CREATE_FAILED"), why);
      assert.equal(provider.calls.filter((c) => c.op === "create").length, creates, `${why}: nothing created`);
      assert.equal(provider.calls.filter((c) => c.op === "destroy").length, 0, `${why}: nothing ended`);
      assert.deepEqual(running(provider).map((b) => b.id), [hA.box], `${why}: the box keeps running`);
    }
  });

  it("a needed fact that stays absent: from the 5th start that finds the same box so, a named refusal (the box, the fact), still ending nothing; once the operator ends the box, the next start makes another", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await host(provider).start(REF, TOKEN, { attempt: 1 });
    const driver = boxHost({ provider: misread(provider, { secretsVia: undefined }), spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 });
    for (let i = 1; i <= 4; i++) await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), code("CREATE_FAILED"), `start ${i}`);
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), (e: unknown) => code("UNSUPPORTED")(e) && (e as Error).message.includes(String(hA.box)) && /secretsVia/.test((e as Error).message));
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), code("UNSUPPORTED"), "and every start after, while the box is there");
    assert.equal(provider.calls.filter((c) => c.op === "destroy").length, 0, "nothing ended");
    assert.deepEqual(running(provider).map((b) => b.id), [hA.box], "nothing made");
    provider.boxes.find((b) => b.id === hA.box)!.end(0);
    const h = await driver.start(REF, TOKEN, { attempt: 1 });
    assert.notEqual(h.box, hA.box, "the operator ended the box: the next start makes another");
  });

  it("an attach ERROR ends nothing and creates nothing: the start fails for the next tick's retry, and the box keeps running", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await host(provider).start(REF, TOKEN, { attempt: 1 });
    // The error Modal's attach returns when the workspace setup it repeats fails (its mkdir exits non-zero or its exec errs).
    provider.script.on({ op: "attach" }, { fail: "unknown", message: "the workspace setup on attach failed" });
    const creates = provider.calls.filter((c) => c.op === "create").length;
    await assert.rejects(host(provider).start(REF, TOKEN, { attempt: 1 }), (e: unknown) => code("CREATE_FAILED")(e) && /: unknown: the workspace setup on attach failed$/.test((e as Error).message));
    assert.equal(provider.calls.filter((c) => c.op === "create").length, creates, "nothing created");
    assert.equal(provider.calls.filter((c) => c.op === "destroy").length, 0, "nothing ended");
    assert.deepEqual(running(provider).map((b) => b.id), [hA.box]);
  });
});

describe("boxHost: the host box's key, minted per box at each create (agentrun-host-key), handed to that box's runner", () => {
  const KEY = "agentrun-host-key";
  const hostBox = (key: string, run = "L1") => JSON.stringify({ provider: "modal-like", key, run });
  const runs = (provider: FakeProvider) => provider.program("pi-durable-disk", ({ signal }) => new Promise<number>((r) => signal.addEventListener("abort", () => r(0))));
  const labelOf = (provider: FakeProvider, id: unknown) => provider.boxes.find((b) => b.id === id)?.spec.labels?.[KEY];
  const runnerKeyOf = (provider: FakeProvider, id: unknown) => {
    const launch = provider.boxes.find((b) => b.id === id)?.launches.at(-1);
    return (JSON.parse(String(launch?.spec.env?.HOST_BOX)) as { key: string }).key;
  };
  const misread = (provider: FakeProvider, bad: Record<string, unknown>): FakeProvider => ({
    ...provider,
    attach: async (id, context) => {
      const r = await provider.attach(id, context);
      if (!r.ok || r.value === undefined) return r;
      const real = r.value;
      const box = new Proxy(real, { get: (t, k) => (k === "facts" ? () => ({ ...t.facts(), ...bad }) : typeof Reflect.get(t, k, t) === "function" ? Reflect.get(t, k, t).bind(t) : Reflect.get(t, k, t)) });
      return { ok: true, value: box } as typeof r;
    },
  });
  const driverOf = (provider: FakeProvider) => boxHost({ provider, spec: SPEC, app: "/opt/app/app.js", startTimeoutMs: 5_000, callTimeoutMs: 5_000 });

  it("mints <run>/<index>/<16 hex> at the create, labels the box with it as the only writer, hands THAT key to the box's runner, and reports it in the receipt", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const driver = driverOf(provider);
    const h = await driver.start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    const label = labelOf(provider, h.box);
    assert.match(String(label), /^L1\/0\/[0-9a-f]{16}$/);
    assert.equal(runnerKeyOf(provider, h.box), label, "the runner binds host-<key> for its own box");
    assert.equal((driver.box(h) as { key?: string }).key, label, "the receipt, which the place's status entry carries");
    assert.throws(() => boxHost({ provider, spec: { ...SPEC, labels: { [KEY]: "x" } }, app: "/a.js" }), code("INVALID_ARGUMENT"), "one writer: never the spec's");
  });

  it("a replacement within ONE attempt gets a new key, a new label, and its runner gets the replacement's key", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await driverOf(provider).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    const hB = await driverOf(misread(provider, { fuse: false })).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    assert.notEqual(hB.box, hA.box);
    assert.notEqual(labelOf(provider, hB.box), labelOf(provider, hA.box));
    assert.equal(runnerKeyOf(provider, hB.box), labelOf(provider, hB.box));
  });

  it("an index that restarts in a new supervisor life: the later life's box gets a new key, not the first box's", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const life1 = driverOf(provider);
    const hA = await life1.start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    await life1.kill!(hA);
    const hB = await driverOf(provider).start(REF, TOKEN, { attempt: 2, env: { HOST_BOX: hostBox("0") } });
    assert.notEqual(labelOf(provider, hB.box), labelOf(provider, hA.box));
    assert.equal(runnerKeyOf(provider, hB.box), labelOf(provider, hB.box));
  });

  it("an adopted box keeps its first key, read back from its label; nothing new is minted", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await driverOf(provider).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    const later = driverOf(provider);
    const h = await later.start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0", "L2") } });
    assert.equal(h.adopted, true);
    assert.match(String(labelOf(provider, hA.box)), /^L1\/0\/[0-9a-f]{16}$/, "the first life's key");
    assert.equal((later.box(h) as { key?: string }).key, labelOf(provider, hA.box));
  });

  it("a box a list returns WITHOUT this attempt's own labels (another run's) is left alone: neither adopted, used nor ended", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const other = await provider.create({ ...SPEC, capabilities: ["fuse"], labels: { "pi-durable-disk.disk": REF.disk, "pi-durable-disk.run": "another-run", "pi-durable-disk.attempt": "1" } }, BACKGROUND_CONTEXT);
    assert.ok(other.ok);
    // A provider whose list ignores the filter: it returns every box it has.
    const careless: FakeProvider = { ...provider, list: async (_labels, context) => provider.list({}, context) };
    const h = await driverOf(careless).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    assert.notEqual(h.box, other.value.id, "never adopted or used");
    assert.equal(other.value.state, "running", "never ended");
    assert.equal(provider.calls.filter((c) => c.op === "destroy").length, 0);
  });

  it("a box found again WITHOUT the label (made before the key) is never adopted as the run's host box: ended through its handle, then replaced by a labeled one", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await driverOf(provider).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    const unlabeled: FakeProvider = {
      ...provider,
      list: async (labels, context) => {
        const r = await provider.list(labels, context);
        return r.ok ? ({ ok: true, value: r.value.map((ref) => ({ ...ref, labels: Object.fromEntries(Object.entries(ref.labels).filter(([k]) => k !== KEY)) })) } as typeof r) : r;
      },
    };
    const h = await driverOf(unlabeled).start(REF, TOKEN, { attempt: 1, env: { HOST_BOX: hostBox("0") } });
    assert.notEqual(h.adopted, true, "never adopted");
    assert.notEqual(h.box, hA.box);
    assert.deepEqual(provider.boxes.filter((b) => b.state === "running").map((b) => b.id), [h.box], "exactly one box, the labeled replacement");
    assert.match(String(labelOf(provider, h.box)), /^L1\/0\/[0-9a-f]{16}$/);
  });
});

describe("boxHost: a read or an end that fails changes nothing it cannot finish", () => {
  const runs = (provider: FakeProvider) => provider.program("pi-durable-disk", ({ signal }) => new Promise<number>((r) => signal.addEventListener("abort", () => r(0))));
  const running = (provider: FakeProvider) => provider.boxes.filter((b) => b.state === "running").map((b) => b.id);

  it("a launch state that cannot be read is not 'never launched': the start fails, and nothing is uploaded, launched or ended", async () => {
    const provider = fake(modalLike({ facts: fd }));
    runs(provider);
    const hA = await host(provider, { files: [{ path: "/opt/app/app.js", bytes: new TextEncoder().encode("x") }] }).start(REF, TOKEN, { attempt: 1 });
    const before = provider.calls.length;
    provider.script.on({ op: "launchState" }, { fail: "unknown" }, { times: 1 });
    await assert.rejects(host(provider, { files: [{ path: "/opt/app/app.js", bytes: new TextEncoder().encode("x") }] }).start(REF, TOKEN, { attempt: 1 }), code("CREATE_FAILED"));
    const after = provider.calls.slice(before).map((c) => c.op);
    for (const op of ["upload", "launch", "destroy", "create"]) assert.ok(!after.includes(op as never), `no ${op} after an unreadable launch state: ${after.join(",")}`);
    assert.deepEqual(running(provider), [hA.box]);
  });

  it("a found box whose launch ended, and whose end fails: STOP_FAILED, no replacement, and its receipt is not marked ended", async () => {
    const provider = fake(modalLike({ facts: fd }));
    const driver = host(provider);
    provider.program("pi-durable-disk", () => Promise.resolve(3));
    const made = await provider.create({ ...SPEC, capabilities: ["fuse"], labels: { "pi-durable-disk.disk": REF.disk, "pi-durable-disk.run": REF.id, "pi-durable-disk.attempt": "1", "agentrun-host-key": "r1/1/0000000000000000" } }, BACKGROUND_CONTEXT);
    assert.ok(made.ok);
    const launcher = await import("@parcha/pi-transport/launch");
    const l = await launcher.launch(made.value, "pda-r1-g1", { argv: ["pi-durable-disk"], user: "pda", restart: false }, BACKGROUND_CONTEXT);
    assert.ok(l.ok);
    const phase = async () => {
      const r = await launcher.launchState(made.value, { v: 1, name: "pda-r1-g1" }, BACKGROUND_CONTEXT);
      return r.ok ? r.value?.phase : undefined;
    };
    for (let i = 0; i < 50 && (await phase()) !== "exited"; i++) await new Promise((r) => setTimeout(r, 5));
    provider.script.on({ op: "destroy" }, { fail: "unknown" });
    const creates = provider.calls.filter((c) => c.op === "create").length;
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), code("STOP_FAILED"));
    assert.equal(provider.calls.filter((c) => c.op === "create").length, creates, "no replacement while the first may still serve");
    assert.deepEqual(running(provider), [made.value.id]);
  });

  it("a refused box whose end fails is ended by a later start, which is still refused at once", async () => {
    const provider = fake(daytonaLike({ facts: fd }));
    provider.script.on({ op: "destroy" }, { fail: "unknown" }, { times: 1 });
    const driver = host(provider);
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 1 }), code("UNSUPPORTED"));
    assert.equal(provider.boxes[0]!.state, "running", "the first end failed");
    await assert.rejects(driver.start(REF, TOKEN, { attempt: 2 }), code("UNSUPPORTED"));
    assert.equal(provider.boxes[0]!.state, "ended", "the later start ended it");
    assert.equal(provider.boxes.length, 1, "and made no box");
  });
});
