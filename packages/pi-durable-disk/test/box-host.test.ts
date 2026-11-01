// boxHost over pi-transport's fake provider: what it asks the provider and the launcher, and how it behaves when either
// says no. No network, no key, no real box: a box is the fake's, and its programs are functions.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeBoxes, fakeClock, type FakeProvider } from "@parcha/pi-transport/testing";
import type { Box, BoxSpec } from "@parcha/pi-transport";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BOX_ATTEMPT_LABEL, BOX_RUN_DIR, BOX_RUN_LABEL, boxHost, BoxHostError, type BoxStart } from "../src/box-host.ts";
import type { HostHandle } from "../src/supervise.ts";

/** Every fake provider a test makes; their boxes end after the file (a live box's lifetime timer would hold the process). */
const providers: FakeProvider[] = [];
const fake = (options: Parameters<typeof fakeBoxes>[0]) => {
  const provider = fakeBoxes(options);
  providers.push(provider);
  return provider;
};
after(() => {
  for (const provider of providers) provider.endAll();
});

/** A provider whose boxes take a launch frame (secretsVia fd), and one whose boxes take none. */
const withFd = (more: Parameters<typeof fakeBoxes>[0] = {}) =>
  fake({ name: "vm-fd", startedAt: true, ...more, facts: { isolation: "vm", liveProcesses: true, secretsVia: "fd", ...more.facts } });
const withoutFd = () => fake({ name: "no-fd", startedAt: true, facts: { isolation: "container", liveProcesses: true } });

const REF = { disk: "local", region: "local", id: "r1" };
const SPEC: BoxSpec = { maxLifetimeMs: 3_600_000, image: "agentrun-sandbox:test" };
const APP = "/opt/agentrun/app.js";
const APP_FILE = { path: APP, bytes: new TextEncoder().encode("export default {};\n") };
const TOKEN = `run-tok-${"7".repeat(24)}`;
const code = (c: string) => (e: unknown) => e instanceof BoxHostError && e.code === c;
const host = (provider: FakeProvider, more: Partial<Parameters<typeof boxHost>[0]> = {}) => boxHost({ provider, spec: SPEC, app: APP, startTimeoutMs: 5_000, callTimeoutMs: 5_000, ...more });
const start = (driver: ReturnType<typeof boxHost>, attempt = 1) => driver.start(REF, "", { attempt });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const forever = ({ signal }: { signal: AbortSignal }) => new Promise<number>((resolve) => signal.addEventListener("abort", () => resolve(0)));
const runs = (provider: FakeProvider) => provider.program("pi-durable-disk", forever);
const running = (provider: FakeProvider) => provider.boxes.filter((b) => b.state === "running").map((b) => b.id);
const seqOf = (provider: FakeProvider, op: string, box?: string, nth = 1) => provider.calls.filter((c) => c.op === op && (box === undefined || c.box === box))[nth - 1]?.seq;

describe("boxHost: its options and a start's arguments", () => {
  it("refuses at once, INVALID_ARGUMENT: no provider, no positive maxLifetimeMs, a label key of transport's or boxHost's, a key-shaped spec.env name, no app, an empty command, runArgs that repeat boxHost's or a disk's flags, env naming PDA_HOLDER", () => {
    const provider = withFd();
    const bad: [string, () => unknown][] = [
      ["no provider", () => boxHost({ provider: undefined as never, spec: SPEC, app: APP })],
      ["no maxLifetimeMs", () => boxHost({ provider, spec: { image: "x" } as BoxSpec, app: APP })],
      ["maxLifetimeMs 0", () => boxHost({ provider, spec: { maxLifetimeMs: 0 }, app: APP })],
      ["pi-transport label", () => boxHost({ provider, spec: { ...SPEC, labels: { "pi-transport": "x" } }, app: APP })],
      ["pi-transport.* label", () => boxHost({ provider, spec: { ...SPEC, labels: { "pi-transport.owner": "x" } }, app: APP })],
      ["boxHost's own label", () => boxHost({ provider, spec: { ...SPEC, labels: { [BOX_RUN_LABEL]: "x" } }, app: APP })],
      ["a key-shaped spec.env name", () => boxHost({ provider, spec: { ...SPEC, env: { MODEL_API_KEY: "x" } }, app: APP })],
      ["no app", () => boxHost({ provider, spec: SPEC, app: "" })],
      ["empty command", () => boxHost({ provider, spec: SPEC, app: APP, command: [] })],
      ["runArgs --dir", () => boxHost({ provider, spec: SPEC, app: APP, runArgs: ["--dir", "/elsewhere"] })],
      ["runArgs --serve-host=", () => boxHost({ provider, spec: SPEC, app: APP, runArgs: ["--serve-host=0.0.0.0"] })],
      ["runArgs --serve-host", () => boxHost({ provider, spec: SPEC, app: APP, runArgs: ["--serve-host", "box.example.com"] })],
      ["runArgs --disk", () => boxHost({ provider, spec: SPEC, app: APP, runArgs: ["--disk", "d"] })],
      ["runArgs --token-stdin", () => boxHost({ provider, spec: SPEC, app: APP, runArgs: ["--token-stdin"] })],
      ["env PDA_HOLDER", () => boxHost({ provider, spec: SPEC, app: APP, env: { PDA_HOLDER: "{}" } })],
    ];
    for (const [why, make] of bad) assert.throws(make, code("INVALID_ARGUMENT"), why);
    assert.equal(provider.calls.length, 0, "nothing was asked of the provider");
    const ok = host(provider);
    assert.equal(ok.provider, provider.name);
    assert.equal(ok.kills, "box");
  });

  it("a start with a mount token, no run id, no attempt, an attempt env it refuses, or an env or user the launcher refuses is INVALID_ARGUMENT before any call", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    await assert.rejects(driver.start(REF, "tok-from-a-disk-supervisor", { attempt: 1 }), code("INVALID_ARGUMENT"), "a mount token: boxHost is no host for a run on a disk");
    await assert.rejects(driver.start({ ...REF, id: "" }, "", { attempt: 1 }), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, ""), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, "", { attempt: 0 }), code("INVALID_ARGUMENT"));
    await assert.rejects(driver.start(REF, "", { attempt: 1, env: { PATH: "/x" } }), code("INVALID_ARGUMENT"), "attemptEnv's rules");
    await assert.rejects(driver.start(REF, "", { attempt: 1, env: { RUN_TOKEN: TOKEN } }), (e: unknown) => code("INVALID_ARGUMENT")(e) && !(e as Error).message.includes(TOKEN), "a key-shaped name in the env, never echoing its value");
    await assert.rejects(host(provider, { env: { LD_PRELOAD: "/x.so" } }).start(REF, "", { attempt: 1 }), code("INVALID_ARGUMENT"), "a loader name");
    await assert.rejects(host(provider, { user: "root", secrets: { AGENTRUN_RUN_TOKEN: TOKEN } }).start(REF, "", { attempt: 1 }), code("INVALID_ARGUMENT"), "root holding secrets with no tools user");
    assert.equal(provider.calls.length, 0, "no call to the provider, so no box is booted");
  });
});

describe("boxHost: the box and the launch it asks for", () => {
  it("launches the dir-mode argv: run --dir BOX_RUN_DIR --id <run> --app <app> --serve 0 and the caller's flags, the door on the CLI's default (loopback) host, with no flag of a disk's; the env is PDA_HOLDER, the driver's and the start's", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider, { runArgs: ["--serve-token-file", "/run/agentrun/door.token"], env: { AGENTRUN_SERVE_PLACE: "sandbox" } });
    const handle = await driver.start(REF, "", { attempt: 2, env: { AGENTRUN_SERVE_EFFORT: "low" } });
    const box = provider.boxes[0]!;
    assert.equal(BOX_RUN_DIR, "/run/agentrun/run");
    assert.deepEqual(handle, { driver: "box", provider: provider.name, box: box.id, run: "r1", attempt: 2, launch: { v: 1, name: "pdd-run-a2" } });
    const launch = box.launches[0]!;
    const argv = launch.spec.argv;
    assert.deepEqual(argv, ["pi-durable-disk", "run", "--dir", "/run/agentrun/run", "--id", "r1", "--app", APP, "--serve", "0", "--serve-token-file", "/run/agentrun/door.token"]);
    for (const flag of ["--disk", "--region", "--mount-root", "--archil", "--token-stdin", "--run-as", "--serve-host"]) assert.ok(!argv.includes(flag), `no ${flag}`);
    assert.equal(launch.spec.stdin, undefined, "nothing on the program's stdin: no mount token");
    assert.equal(launch.spec.secrets, undefined, "no secrets given, so no frame");
    assert.equal(launch.spec.user, undefined);
    assert.equal(launch.spec.toolsUser, undefined, "no tools user: nothing runs --run-as");
    assert.equal(launch.spec.inheritEnv, false);
    assert.equal(launch.spec.restart, true);
    assert.deepEqual(launch.spec.terminalExits, [65, 70, 75, 76]);
    assert.deepEqual(Object.keys(launch.spec.env!).sort(), ["AGENTRUN_SERVE_EFFORT", "AGENTRUN_SERVE_PLACE", "PDA_HOLDER"]);
    assert.deepEqual(JSON.parse(launch.spec.env!.PDA_HOLDER!), handle, "the holder is the handle");
    assert.equal(await driver.status(handle), "running");
  });

  it("creates the caller's spec as given, with boxHost's two labels added and nothing else; a spec function is asked once per create, with the start, and never for a box adopted", async () => {
    const spec: BoxSpec = {
      maxLifetimeMs: 600_000,
      image: "agentrun-sandbox:1",
      cpus: 2,
      memoryMb: 4096,
      env: { AGENTRUN_SERVE_PLACE: "sandbox", LANG: "C.UTF-8" },
      network: { allow: ["api.example.com"] },
      labels: { team: "crew" },
      workspace: "/workspace",
    };
    const provider = withFd();
    runs(provider);
    await host(provider, { spec }).start(REF, "", { attempt: 3 });
    assert.deepEqual(provider.callsOf("create")[0]!.spec, { ...spec, labels: { team: "crew", [BOX_RUN_LABEL]: "r1", [BOX_ATTEMPT_LABEL]: "3" } });

    const other = withFd();
    runs(other);
    const asked: BoxStart[] = [];
    const driver = host(other, { spec: (s) => (asked.push(s), spec) });
    await start(driver, 1);
    assert.equal((await start(driver, 1)).adopted, true);
    await start(driver, 2);
    assert.deepEqual(asked, [{ run: "r1", attempt: 1 }, { run: "r1", attempt: 2 }]);

    const careless = withFd();
    await assert.rejects(host(careless, { spec: () => ({ ...spec, env: { GATEWAY_TOKEN: TOKEN } }) }).start(REF, "", { attempt: 1 }), code("INVALID_ARGUMENT"), "a function's spec is checked as an object's");
    assert.equal(careless.callsOf("create").length, 0);
    assert.deepEqual(careless.leaks(TOKEN), []);
  });

  it("a create the provider refuses: invalid is INVALID_ARGUMENT, unsupported is UNSUPPORTED, capacity is CREATE_FAILED; a later start creates again", async () => {
    for (const [fail, want] of [["invalid", "INVALID_ARGUMENT"], ["unsupported", "UNSUPPORTED"], ["capacity", "CREATE_FAILED"]] as const) {
      const provider = withFd();
      runs(provider);
      provider.script.on({ op: "create" }, { fail }, { times: 1 });
      const driver = host(provider);
      await assert.rejects(start(driver), (e: unknown) => code(want)(e) && (e as { cause?: { code?: string } }).cause?.code === fail, fail);
      await start(driver);
      assert.equal(provider.callsOf("create").length, 2, `${fail}: a later start creates again`);
    }
  });

  it("a box a failed create made anyway is found by its labels and used, never leaked", async () => {
    const provider = withFd();
    runs(provider);
    provider.script.on({ op: "create" }, { fail: "unknown", leakBox: true });
    const h = await start(host(provider));
    assert.equal(provider.boxes.length, 1, "the one box the failed create made");
    assert.deepEqual(running(provider), [h.box], "used, and the only box");
    assert.ok(provider.callsOf("list").length >= 2, "it looked for it by its labels");
  });

  it("a box that keeps no program running is destroyed before any upload or launch: UNSUPPORTED", async () => {
    const provider = withFd({ facts: { liveProcesses: false } });
    await assert.rejects(host(provider, { files: [APP_FILE] }).start(REF, "", { attempt: 1 }), code("UNSUPPORTED"));
    assert.deepEqual(running(provider), []);
    assert.deepEqual(provider.calls.filter((c) => ["upload", "launch"].includes(c.op)), []);
  });
});

describe("boxHost: secrets ride the launch frame, never env or argv", () => {
  it("hands the secrets to the instance on its secrets fd only: never in argv, the launch's env, the box's spec, a label or a file; asked once per launch, with the start", async () => {
    const provider = withFd();
    let seen: { secrets: Record<string, string>; env: Record<string, string> } | undefined;
    provider.program("pi-durable-disk", (p) => ((seen = { secrets: { ...p.secrets }, env: { ...p.env } }), forever(p)));
    const asked: BoxStart[] = [];
    const driver = host(provider, { user: "agent", files: [APP_FILE], spec: { ...SPEC, env: { AGENTRUN_SERVE_PLACE: "sandbox" } }, secrets: (s) => (asked.push(s), { AGENTRUN_RUN_TOKEN: TOKEN }) });
    const handle = await driver.start(REF, "", { attempt: 1, env: { AGENTRUN_SERVE_EFFORT: "low" } });
    await tick();
    assert.deepEqual(asked, [{ run: "r1", attempt: 1 }]);
    assert.deepEqual(seen?.secrets, { AGENTRUN_RUN_TOKEN: TOKEN }, "the instance reads them from its secrets fd");
    assert.equal(seen?.env.PI_TRANSPORT_SECRETS_FD, "3");
    assert.ok(!Object.values(seen?.env ?? {}).some((v) => v.includes(TOKEN)), "never in the instance's environment");
    assert.deepEqual(provider.leaks(TOKEN).map((l) => `${l.op}:${l.where}`), ["launch:secret"], "on the launch's frame and nowhere else");
    assert.deepEqual(provider.callsOf("create")[0]!.spec!.env, { AGENTRUN_SERVE_PLACE: "sandbox" }, "the box's env is the caller's, with no secret added");
    const launch = provider.boxes[0]!.launches[0]!;
    assert.equal(launch.spec.user, "agent");
    assert.ok(!launch.spec.argv.some((a) => a.includes(TOKEN)));
    assert.equal(await driver.status(handle), "running");
  });

  it("a box without secretsVia fd is refused only when the start has secrets: with none, or an empty set, it runs; with some, it is destroyed before any upload or launch (UNSUPPORTED), and the secret goes nowhere", async () => {
    const plain = withoutFd();
    runs(plain);
    const h = await host(plain, { files: [APP_FILE] }).start(REF, "", { attempt: 1 });
    assert.equal(await host(plain).status(h), "running", "no secrets: any provider");
    const empty = withoutFd();
    runs(empty);
    await host(empty, { secrets: () => ({}) }).start(REF, "", { attempt: 1 });
    assert.equal(empty.boxes[0]!.launches[0]!.spec.secrets, undefined, "an empty set is no frame");

    const provider = withoutFd();
    runs(provider);
    const driver = host(provider, { user: "agent", files: [APP_FILE], secrets: { AGENTRUN_RUN_TOKEN: TOKEN } });
    await assert.rejects(start(driver), (e: unknown) => code("UNSUPPORTED")(e) && /secretsVia/.test((e as Error).message));
    assert.deepEqual(running(provider), [], "the box is destroyed");
    assert.deepEqual(provider.calls.filter((c) => ["upload", "launch"].includes(c.op)), [], "refused before any upload or launch");
    assert.deepEqual(provider.leaks(TOKEN), [], "the secret went nowhere");
  });

  it("an empty set of secrets is none, whatever the user: root with {} or with a function that gives undefined or {} starts with no frame; root with a secret is refused before any box, given as an object or by a function", async () => {
    for (const [why, secrets] of [
      ["an empty object", {}],
      ["a function that gives undefined", () => undefined],
      ["a function that gives an empty object", () => ({})],
    ] as const) {
      const provider = withFd();
      runs(provider);
      const driver = host(provider, { user: "root", secrets });
      const handle = await start(driver);
      const launch = provider.boxes[0]!.launches[0]!;
      assert.equal(launch.spec.user, "root", why);
      assert.equal(launch.spec.secrets, undefined, `${why}: no frame`);
      assert.equal(await driver.status(handle), "running", why);
    }
    const provider = withFd();
    runs(provider);
    await assert.rejects(host(provider, { user: "root", secrets: { AGENTRUN_RUN_TOKEN: TOKEN } }).start(REF, "", { attempt: 1 }), code("INVALID_ARGUMENT"), "an object: refused before any call");
    assert.equal(provider.calls.length, 0);
    await assert.rejects(host(provider, { user: "root", secrets: () => ({ AGENTRUN_RUN_TOKEN: TOKEN }) }).start(REF, "", { attempt: 1 }), (e: unknown) => code("INVALID_ARGUMENT")(e) && !(e as Error).message.includes(TOKEN), "a function: refused once asked");
    assert.equal(provider.callsOf("create").length, 0, "no box is made");
    assert.deepEqual(provider.leaks(TOKEN), []);
  });

  it("a box adopted never asks the secrets function, on this driver or a new one", async () => {
    const provider = withFd();
    runs(provider);
    let asks = 0;
    const secrets = () => (asks++, { AGENTRUN_RUN_TOKEN: TOKEN });
    const first = await host(provider, { user: "agent", secrets }).start(REF, "", { attempt: 1 });
    assert.equal(asks, 1, "asked once, for the launch");
    for (const driver of [host(provider, { user: "agent", secrets }), host(provider, { user: "agent", secrets })]) {
      const again = await start(driver);
      assert.deepEqual(again, { ...first, adopted: true });
      assert.equal((await start(driver)).adopted, true);
    }
    assert.equal(asks, 1, "never asked for a box adopted");
    assert.equal(provider.callsOf("launch").length, 1);
  });

  it("the secrets are asked for before any box is made: a secrets function that fails makes nothing", async () => {
    const provider = withFd();
    runs(provider);
    await assert.rejects(host(provider, { user: "agent", secrets: () => Promise.reject(new Error("no run token minted")) }).start(REF, "", { attempt: 1 }), /no run token minted/);
    assert.equal(provider.callsOf("create").length, 0);
  });
});

describe("boxHost: status, adopt, restarts, stop and kill", () => {
  it("status maps the launcher's phases: running while it runs, restarts or stops, stopped on a clean end, failed on any other end, a lost launcher or none, unknown when unreadable", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    const handle = await start(driver);
    const launch = provider.boxes[0]!.launches[0]!;
    const cases: [object, string][] = [
      [{ phase: "starting" }, "running"],
      [{ phase: "running" }, "running"],
      [{ phase: "restarting" }, "running"],
      [{ phase: "stopping" }, "running"],
      [{ phase: "stopped" }, "stopped"],
      [{ phase: "exited", lastExit: 0 }, "stopped"],
      [{ phase: "exited", lastExit: 75 }, "failed"],
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

  it("adopts a running launch after a host restart: a new driver reads the stored handle, and its start of the same attempt finds the box by its labels and the launcher's record, making, uploading, launching and asking for secrets nothing", async () => {
    const provider = withFd();
    runs(provider);
    let asks = 0;
    const options = { user: "agent", files: [APP_FILE], secrets: () => (asks++, { AGENTRUN_RUN_TOKEN: TOKEN }) };
    const first = await host(provider, options).start(REF, "", { attempt: 1 });
    // The host restarts: a new driver, with nothing in memory but the handle the host stored.
    const later = host(provider, options);
    assert.equal(await later.status(first), "running", "the stored handle is read again");
    const again = await later.start(REF, "", { attempt: 1 });
    assert.deepEqual(again, { ...first, adopted: true });
    assert.equal(provider.callsOf("create").length, 1);
    assert.equal(provider.callsOf("launch").length, 1);
    assert.equal(provider.callsOf("upload").length, 1, "no upload into a box adopted");
    assert.equal(asks, 1, "no secrets asked for a box adopted");
    assert.ok(later.instanceOf(first) !== undefined && later.instanceOf(first) === later.instanceOf(again), "one instance, fresh or adopted");
    const receipt = later.box(again)!;
    assert.deepEqual({ ...receipt, from: typeof receipt.from }, { provider: provider.name, kind: "vm", from: "string", to: null });
    assert.equal(later.instanceOf({ driver: "daytona", sandboxId: "sb-1" }), undefined);
  });

  it("a launch whose program exits is restarted by the launcher (status running throughout); a terminal exit is not, and status says failed", async () => {
    const clock = fakeClock(Date.now());
    const provider = withFd({ clock });
    let incarnations = 0;
    provider.program("pi-durable-disk", (p) => (++incarnations === 1 ? 1 : forever(p)));
    const driver = host(provider);
    const handle = await start(driver);
    await tick();
    const launch = provider.boxes[0]!.launches[0]!;
    assert.equal(launch.status.phase, "restarting", "the first incarnation exited 1");
    assert.equal(await driver.status(handle), "running");
    await clock.advance(1_100);
    await tick();
    assert.equal(incarnations, 2);
    assert.deepEqual([launch.status.phase, launch.status.restarts], ["running", 1]);
    assert.equal(await driver.status(handle), "running");
    launch.exit(75);
    await tick();
    assert.equal(launch.status.phase, "exited", "75 (fenced) is terminal");
    assert.equal(incarnations, 2, "never restarted");
    assert.equal(await driver.status(handle), "failed");
  });

  it("a start that finds its attempt's box with the launch ended or lost destroys it and makes a new one, never relaunching in the old box", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    await start(driver);
    for (const [why, end] of [
      ["exited 65", (l: { exit(code: number): void }) => l.exit(65)],
      ["lost", (l: { setState(s: object): void }) => l.setState({ phase: "lost", launcherAlive: false })],
    ] as const) {
      const old = provider.boxes.filter((b) => b.state === "running").at(-1)!;
      end(old.launches.at(-1)! as never);
      await tick();
      const again = await start(driver);
      assert.notEqual(again.box, old.id, `${why}: a new box`);
      assert.equal(old.state, "ended", `${why}: the old box destroyed`);
      assert.equal(old.launches.length, 1, `${why}: never relaunched in the old box`);
      assert.deepEqual(running(provider), [again.box], `${why}: one box`);
    }
  });

  it("stop drains the instance through the launcher, then destroys the box; kill destroys it at once; another driver's handle is unknown and a no-op; a box that is gone is gone", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider, { stopGraceMs: 50 });
    const handle = await start(driver);
    const box = provider.boxes[0]!;
    await driver.stop(handle);
    const ops = provider.calls.map((c) => c.op);
    assert.ok(ops.lastIndexOf("launchStop") < ops.lastIndexOf("destroy"), "the drain before the destroy");
    assert.equal(box.launches[0]!.events[0], "drain");
    assert.equal(box.state, "ended");
    assert.equal(typeof driver.box(handle)!.to, "string", "the receipt ends with the box");
    assert.equal(await driver.status(handle), "gone");
    await driver.stop(handle);

    const killed = await start(driver, 2);
    const stops = provider.callsOf("launchStop").length;
    await driver.kill(killed);
    assert.equal(provider.boxes.find((b) => b.id === killed.box)!.state, "ended");
    assert.equal(provider.callsOf("launchStop").length, stops, "a kill never drains: it is a crash");

    const other: HostHandle = { driver: "daytona", sandboxId: "x" };
    const before = provider.calls.length;
    assert.equal(await driver.status(other), "unknown");
    await driver.stop(other);
    await driver.kill(other);
    assert.equal(driver.box(other), null);
    assert.equal(provider.calls.length, before, "nothing asked for another driver's handle");
  });

  it("status is unknown when the provider cannot be asked", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    const handle = await start(driver);
    provider.script.on({ op: "attach" }, { fail: "unknown" });
    assert.equal(await driver.status(handle), "unknown");
  });
});

describe("boxHost: a launch that fails", () => {
  it("the launch's errors: refused, unsupported and unsafe are UNSUPPORTED; timeout is START_TIMED_OUT; failed and box are LAUNCH_FAILED; invalid is INVALID_ARGUMENT; the box is destroyed every time, and a later start makes a new one", async () => {
    const cases = [
      ["refused", "UNSUPPORTED"],
      ["unsupported", "UNSUPPORTED"],
      ["unsafe", "UNSUPPORTED"],
      ["timeout", "START_TIMED_OUT"],
      ["failed", "LAUNCH_FAILED"],
      ["box", "LAUNCH_FAILED"],
      ["invalid", "INVALID_ARGUMENT"],
    ] as const;
    for (const [fail, want] of cases) {
      const provider = withFd();
      runs(provider);
      provider.script.on({ op: "launch" }, { fail }, { times: 1 });
      const driver = host(provider);
      await assert.rejects(start(driver), (e: unknown) => code(want)(e) && (e as { cause?: { code?: string } }).cause?.code === fail, fail);
      assert.equal(provider.boxes[0]!.state, "ended", `${fail}: the box is destroyed`);
      const h = await start(driver);
      assert.deepEqual(running(provider), [h.box], `${fail}: a later start makes one box`);
    }
  });

  it("a launch the launcher reports could not run (exit 126: the user switch, the env clear or the directory) is LAUNCH_FAILED, the box destroyed", async () => {
    const provider = withFd();
    runs(provider);
    // As a real launcher can answer when its first incarnation failed before the state was read: ok(), restarting, exit 126.
    const said126 = (box: Box): Box =>
      new Proxy(box, {
        get(target, key) {
          if (key === "launcher") {
            const real = target.launcher!;
            return {
              ...real,
              launch: async (...args: Parameters<typeof real.launch>) => {
                const r = await real.launch(...args);
                return r.ok ? { ok: true as const, value: { ...r.value, phase: "restarting" as const, lastExit: 126 } } : r;
              },
            };
          }
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    const wrapped: FakeProvider = Object.assign(Object.create(provider) as FakeProvider, {
      create: async (spec: BoxSpec, context: Parameters<FakeProvider["create"]>[1]) => {
        const made = await provider.create(spec, context);
        return made.ok ? { ok: true as const, value: said126(made.value) as never } : made;
      },
    });
    await assert.rejects(start(host(wrapped)), (e: unknown) => code("LAUNCH_FAILED")(e) && /exit 126/.test((e as Error).message));
    assert.deepEqual(running(provider), []);
  });
});

describe("boxHost: one live box per run", () => {
  it("a start ends every older attempt's box before it makes its own; a start of an older attempt makes and ends nothing (SUPERSEDED), on this driver or after a host restart", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    const h1 = await start(driver, 1);
    const h2 = await start(driver, 2);
    const ended = seqOf(provider, "destroy", h1.box as string);
    const made = seqOf(provider, "create", undefined, 2);
    assert.ok(ended !== undefined && made !== undefined && ended < made, `attempt 1's box ended (${ended}) before attempt 2's create (${made})`);
    assert.deepEqual(running(provider), [h2.box]);
    assert.equal(await driver.status(h1), "gone");
    for (const stale of [driver, host(provider)]) {
      await assert.rejects(start(stale, 1), (e: unknown) => code("SUPERSEDED")(e) && (e as Error).message.includes("attempt 2"));
    }
    assert.equal(provider.callsOf("create").length, 2, "nothing made");
    assert.deepEqual(running(provider), [h2.box], "nothing ended");
  });

  it("an older attempt's box that cannot be ended makes nothing: STOP_FAILED, and that box is still the only one", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    const h1 = await start(driver, 1);
    provider.script.on({ op: "destroy" }, { fail: "unknown" });
    await assert.rejects(start(driver, 2), code("STOP_FAILED"));
    assert.equal(provider.callsOf("create").length, 1);
    assert.deepEqual(running(provider), [h1.box]);
  });

  it("starts of one run go one at a time: two of one attempt at once make one box; two attempts at once leave the newer one's box alone", async () => {
    const provider = withFd();
    runs(provider);
    const driver = host(provider);
    const [a, b] = await Promise.all([start(driver, 1), start(driver, 1)]);
    assert.equal(a.box, b.box);
    assert.equal(b.adopted, true);
    assert.equal(provider.callsOf("create").length, 1);
    const [newer, older] = await Promise.allSettled([start(driver, 3), start(driver, 2)]);
    assert.equal(newer.status, "fulfilled");
    assert.ok(older.status === "rejected" && code("SUPERSEDED")(older.reason));
    assert.deepEqual(running(provider), [(newer as PromiseFulfilledResult<HostHandle>).value.box]);
  });

  it("a box a list returns WITHOUT this run's label (another run's) is left alone: neither adopted, used nor ended", async () => {
    const provider = withFd();
    runs(provider);
    const other = await provider.create({ ...SPEC, labels: { [BOX_RUN_LABEL]: "another-run", [BOX_ATTEMPT_LABEL]: "1" } }, BACKGROUND_CONTEXT);
    assert.ok(other.ok);
    // A provider whose list ignores the filter: it returns every box it has.
    const careless: FakeProvider = { ...provider, list: async (_labels, context) => provider.list({}, context) };
    const h = await start(host(careless), 2);
    assert.notEqual(h.box, other.value.id);
    assert.equal(other.value.state, "running", "never ended");
    assert.equal(provider.callsOf("destroy").length, 0);
  });

  it("a launch state that cannot be read is not 'never launched': the start fails CREATE_FAILED, and nothing is made, uploaded, launched or ended", async () => {
    const provider = withFd();
    runs(provider);
    const h = await host(provider, { files: [APP_FILE] }).start(REF, "", { attempt: 1 });
    const before = provider.calls.length;
    provider.script.on({ op: "launchState" }, { fail: "unknown" }, { times: 1 });
    await assert.rejects(host(provider, { files: [APP_FILE] }).start(REF, "", { attempt: 1 }), code("CREATE_FAILED"));
    const later = provider.calls.slice(before).map((c) => c.op);
    for (const op of ["create", "upload", "launch", "destroy"]) assert.ok(!later.includes(op as never), `no ${op}: ${later.join(",")}`);
    assert.deepEqual(running(provider), [h.box]);
  });
});
