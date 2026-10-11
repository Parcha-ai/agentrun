// modalHost unit tests over a fake Modal SDK whose sandboxes run each exec with a local process (the in-box launcher and a
// fake instance really run, in a scratch directory standing for the box): the handle, the tags, the create parameters, the
// token's path, status and stop, the error mapping, the janitor-facing list. No Modal, no Archil, no network.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaytonaApiError, LABEL_FLEET, LABEL_RUN, type CreateSandboxBody } from "../src/hosts/daytona.ts";
import { launchStatus, mountBlockers, type LaunchSpec, type LaunchState } from "../src/hosts/daytona-launch.ts";
import { modalHost, modalSandboxes, MODAL_MAX_TIMEOUT_MS, type ModalCreateParams, type ModalProcess, type ModalSandbox, type ModalSdk } from "../src/hosts/modal.ts";

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const TOKEN = `tok-${"7".repeat(40)}`;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCE = fileURLToPath(new URL("./fixtures/daytona-instance.mjs", import.meta.url));
const ME = userInfo().username;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
let fresh: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  fresh.push(d);
  return d;
};

/** Launchers and instances of these scratch directories, found in /proc (a launcher names its box on its command line). */
function fixtureProcesses(within: string[]): number[] {
  if (within.length === 0 || !existsSync("/proc/self/environ")) return [];
  const found: number[] = [];
  for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      const launcher = within.some((d) => argv.includes("serve") && argv[argv.indexOf("--dir") + 1] === join(d, "box"));
      const instance = within.some((d) => env.some((e) => e.startsWith(`PDA_TEST_OUT=${d}/`)));
      if (launcher || instance) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

async function reap(within: string[]): Promise<void> {
  for (let t0 = Date.now(), left = fixtureProcesses(within); left.length > 0 && Date.now() - t0 < 10_000; left = fixtureProcesses(within)) {
    for (const pid of left) for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
    await sleep(50);
  }
}

/** No fixture process outlives its test. */
afterEach(async () => {
  const mine = fresh;
  fresh = [];
  const t0 = Date.now();
  let left = fixtureProcesses(mine);
  while (left.length > 0 && Date.now() - t0 < 5_000) {
    await sleep(50);
    left = fixtureProcesses(mine);
  }
  await reap(mine);
  assert.deepEqual(left, [], "a fixture process outlived its test");
});

after(async () => {
  await reap(dirs);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(20)) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

class NotFoundError extends Error {}
class AlreadyExistsError extends Error {}
class ResourceExhaustedError extends Error {}
class InternalFailure extends Error {}

type Fault = Error | "landed-then-fail";

/** A Modal whose sandboxes exec locally. Names are unique among live sandboxes; a terminated one polls its exit code. */
function fakeModal(cwd: string) {
  const live = new Map<string, FakeSandbox>();
  const all = new Map<string, FakeSandbox>();
  const creates: { app: string; image: unknown; params: ModalCreateParams }[] = [];
  const execs: { id: string; argv: string[]; stdin: string }[] = [];
  const faults = { create: [] as Fault[], setTags: [] as Error[], poll: [] as Error[], terminate: [] as Error[] };
  let next = 1;

  class FakeSandbox implements ModalSandbox {
    readonly sandboxId = `sb-${next++}`;
    exit: number | null = null;
    tags: Record<string, string> = {};
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async exec(argv: string[], params: { mode: "binary"; timeoutMs?: number }): Promise<ModalProcess> {
      if (this.exit !== null) throw new NotFoundError("Modal Sandbox has terminated");
      assert.equal(params.mode, "binary");
      const record = { id: this.sandboxId, argv, stdin: "" };
      execs.push(record);
      const child = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd }, stdio: ["pipe", "pipe", "pipe"] });
      const drain = (s: NodeJS.ReadableStream) => new Promise<Uint8Array>((resolve) => {
        const chunks: Buffer[] = [];
        s.on("data", (c: Buffer) => chunks.push(c));
        s.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      });
      const out = drain(child.stdout);
      const err = drain(child.stderr);
      const code = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
      return {
        stdin: {
          writeBytes: async (b) => void (record.stdin += new TextDecoder().decode(b), child.stdin.write(b)),
          close: async () => void child.stdin.end(),
        },
        stdout: { readBytes: () => out },
        stderr: { readBytes: () => err },
        wait: () => code,
      };
    }
    async poll() {
      const f = faults.poll.shift();
      if (f) throw f;
      return this.exit;
    }
    async terminate() {
      const f = faults.terminate.shift();
      if (f) throw f;
      this.exit = 137;
      live.delete(this.name);
    }
    async setTags(tags: Record<string, string>) {
      const f = faults.setTags.shift();
      if (f) throw f;
      this.tags = { ...tags };
    }
    async getTags() {
      return { ...this.tags };
    }
  }

  const sdk: ModalSdk = {
    apps: { fromName: async (name) => ({ appId: `ap-${name}` }) },
    images: { fromRegistry: (tag) => ({ registry: tag }), fromId: async (id) => ({ id }) },
    sandboxes: {
      async create(app, image, params) {
        creates.push({ app: app.appId, image, params });
        const f = faults.create.shift();
        if (f instanceof Error) throw f;
        if (live.has(params.name)) throw new AlreadyExistsError(`sandbox name "${params.name}" is already in use`);
        const box = new FakeSandbox(params.name);
        live.set(params.name, box);
        all.set(box.sandboxId, box);
        if (f === "landed-then-fail") throw new InternalFailure("connection reset");
        return box;
      },
      async fromId(id) {
        const box = all.get(id);
        if (!box) throw new NotFoundError(`no sandbox ${id}`);
        return box;
      },
      async fromName(_app, name) {
        const box = live.get(name);
        if (!box) throw new NotFoundError(`no sandbox ${name}`);
        return box;
      },
      async *list({ tags }) {
        for (const box of live.values()) if (Object.entries(tags).every(([k, v]) => box.tags[k] === v)) yield box;
      },
    },
  };
  return { sdk, live, all, creates, execs, faults };
}

function world(codes = "hold", over: Partial<Parameters<typeof modalHost>[0]> = {}) {
  const d = scratch("pda-md-");
  const box = join(d, "box");
  const out = join(d, "instance.jsonl");
  const fake = fakeModal(d);
  const host = modalHost({
    sdk: fake.sdk,
    appName: "pda-demo-t",
    image: "ubuntu:24.04",
    fleet: "mdt",
    labels: { suite: "unit" },
    mountRoot: "/mnt/pda/md",
    node: process.execPath,
    packageDir: REPO,
    launcher: join(REPO, "src/hosts/daytona-launch.ts"),
    command: [process.execPath, INSTANCE],
    runArgs: ["--app", "/opt/app.ts"],
    user: ME,
    boxDir: box,
    stageDir: join(d, "stage"),
    env: { PDA_TEST_OUT: out, PDA_TEST_CODES: codes },
    pollMs: 5,
    startTimeoutMs: 20_000,
    stopTimeoutMs: 5_000,
    ...over,
  });
  const lines = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...fake, host, box, out, lines, dir: d };
}

test("start: a VM sandbox tagged with its fleet and run; the token only on an exec's stdin into the staging directory; the instance gets it on stdin; stop terminates", async () => {
  const w = world();
  const h = await w.host.start(REF, TOKEN);
  const name = String(h.name);
  assert.match(name, /^pda-r1-[0-9a-z]+$/);
  assert.deepEqual(h, { driver: "modal", fleet: "mdt", target: null, sandboxId: "sb-1", name, mountpoint: "/mnt/pda/md/runs/r1" });

  assert.equal(w.creates.length, 1);
  assert.deepEqual(w.creates[0].image, { registry: "ubuntu:24.04" });
  assert.equal(w.creates[0].app, "ap-pda-demo-t");
  assert.deepEqual(w.creates[0].params, { name, runtime: "vm", timeoutMs: MODAL_MAX_TIMEOUT_MS });
  assert.deepEqual(w.all.get("sb-1")!.tags, { suite: "unit", [LABEL_FLEET]: "mdt", [LABEL_RUN]: "r1" });

  const stage = join(w.dir, "stage");
  assert.deepEqual(w.execs.filter((e) => e.stdin.includes(TOKEN)).map((e) => e.argv.at(-1)), [join(stage, `${name}.token`)], "the token travels once, as an exec's stdin body");
  assert.ok(!JSON.stringify(w.creates).includes(TOKEN) && !w.execs.some((e) => e.argv.join(" ").includes(TOKEN)), "never in the create parameters or an argument vector");
  assert.equal(statSync(w.box).mode & 0o777, 0o700);
  assert.equal(statSync(stage).mode & 0o777, 0o700);
  assert.ok(!existsSync(join(stage, `${name}.token`)) && !existsSync(join(w.box, `${name}.token`)), "the launcher moved the token out and unlinked it once read");

  const [first] = await waitFor("the instance", () => (w.lines().length ? w.lines() : null));
  assert.equal(first.token, TOKEN);
  assert.deepEqual(JSON.parse(first.holder), h, "run.json's holder is the driver's handle");
  assert.ok(!first.envKeys.some((k: string) => /^(MODAL|ARCHIL)_/.test(k)), "no API key reaches the instance");

  assert.equal(await w.host.status(h), "running");
  await w.host.stop(h);
  assert.equal(launchStatus(w.box, name).status, "stopped", "stop drained the instance before the sandbox went");
  assert.equal(w.all.get("sb-1")!.exit, 137, "and terminated it");
  assert.equal(await w.host.status(h), "gone", "a terminated sandbox, found by id, is gone");
});

test("handles: another driver's or fleet's handle is unknown, and its stop is a no-op", async () => {
  const w = world();
  const h = await w.host.start(REF, TOKEN);
  const daytona = { ...h, driver: "daytona" };
  assert.equal(await w.host.status(daytona), "unknown");
  await w.host.stop(daytona);
  assert.equal(w.all.get("sb-1")!.exit, null, "not terminated");
  w.all.get("sb-1")!.tags = { [LABEL_FLEET]: "someone-else", [LABEL_RUN]: "r1" };
  assert.equal(await w.host.status(h), "unknown", "the tag decides whose sandbox this is");
  await w.host.stop(h);
  assert.equal(w.all.get("sb-1")!.exit, null, "a sandbox of another fleet is never terminated");
  w.all.get("sb-1")!.tags = { [LABEL_FLEET]: "mdt", [LABEL_RUN]: "r1" };
  await w.host.stop(h);
});

test("create: runtime, GPU, size, ports and network pass through; the lifetime is the TTL, at most 24 h", async () => {
  const w = world("hold", {
    runtime: "gvisor",
    gpu: "H100",
    cpu: 4,
    memoryMiB: 8192,
    regions: ["us-east"],
    encryptedPorts: [8080],
    unencryptedPorts: [6080],
    ttlMinutes: 90,
    network: { allowList: "10.0.0.0/8, 192.168.0.0/16" },
    create: { workdir: "/work" },
  });
  const h = await w.host.start(REF, TOKEN);
  assert.deepEqual(w.creates[0].params, {
    workdir: "/work",
    name: h.name,
    runtime: "gvisor",
    gpu: "H100",
    cpu: 4,
    memoryMiB: 8192,
    regions: ["us-east"],
    encryptedPorts: [8080],
    unencryptedPorts: [6080],
    timeoutMs: 90 * 60_000,
    outboundCidrAllowlist: ["10.0.0.0/8", "192.168.0.0/16"],
  });
  await w.host.stop(h);

  const long = world("hold", { ttlMinutes: 48 * 60, network: { blockAll: true } });
  const h2 = await long.host.start(REF, TOKEN);
  assert.equal(long.creates[0].params.timeoutMs, MODAL_MAX_TIMEOUT_MS);
  assert.equal(long.creates[0].params.blockNetwork, true);
  await long.host.stop(h2);
});

test("create: an image id is resolved by id, a function by itself, and once per client", async () => {
  const f = fakeModal("/");
  const body = (name: string): CreateSandboxBody => ({ name, snapshot: "x", labels: { [LABEL_FLEET]: "t" }, autoStopInterval: 0, autoDeleteInterval: 0 });
  const byId = modalSandboxes(f.sdk, { appName: "a", image: "im-abc123" });
  await byId.create(body("one"));
  await byId.create(body("two"));
  assert.deepEqual(f.creates.map((c) => c.image), [{ id: "im-abc123" }, { id: "im-abc123" }]);
  let built = 0;
  const custom = modalSandboxes(f.sdk, { appName: "a", image: () => (built++, { custom: true }) });
  await custom.create(body("three"));
  await custom.create(body("four"));
  assert.equal(built, 1);
  assert.deepEqual(f.creates.at(-1)!.image, { custom: true });
});

test("a create whose answer was lost after the sandbox landed is adopted by name, tagged, and not created twice", async () => {
  const w = world();
  w.faults.create.push("landed-then-fail");
  const h = await w.host.start(REF, TOKEN);
  assert.equal(w.creates.length, 1, "no second create");
  assert.equal(w.all.size, 1, "one sandbox");
  assert.deepEqual(w.all.get("sb-1")!.tags, { suite: "unit", [LABEL_FLEET]: "mdt", [LABEL_RUN]: "r1" }, "the retry's lookup finished the tagging");
  assert.equal(h.sandboxId, "sb-1");
  assert.equal(await w.host.status(h), "running");
  await w.host.stop(h);
});

test("create errors map to the statuses the driver acts on: a duplicate name is 409, exhaustion is 429, the rest is retryable", async () => {
  const w = world();
  const client = modalSandboxes(w.sdk, { appName: "a", image: "ubuntu:24.04" });
  const body = { name: "dup", snapshot: "x", labels: { [LABEL_FLEET]: "t" }, autoStopInterval: 0, autoDeleteInterval: 0 };
  await client.create(body);
  await assert.rejects(client.create(body), (e: unknown) => e instanceof DaytonaApiError && e.status === 409 && !e.retryable);
  w.faults.create.push(new ResourceExhaustedError("no capacity"));
  await assert.rejects(client.create({ ...body, name: "full" }), (e: unknown) => e instanceof DaytonaApiError && e.status === 429 && e.retryable);
  w.faults.create.push(new InternalFailure("boom"));
  await assert.rejects(client.create({ ...body, name: "boom" }), (e: unknown) => e instanceof DaytonaApiError && e.status === null && e.retryable);
});

test("a sandbox that cannot be tagged is terminated, not left untagged", async () => {
  const w = world();
  w.faults.setTags.push(new InternalFailure("tags down"), new InternalFailure("tags down"), new InternalFailure("tags down"));
  await assert.rejects(w.host.start(REF, TOKEN), /tag/);
  assert.ok([...w.all.values()].every((b) => b.exit === 137), "every sandbox it made was terminated");
});

test("client: get maps running, ended and absent; list filters by tag; exec merges stderr and keeps the exit code; upload is owner-only with parents made", async () => {
  const w = world();
  const client = modalSandboxes(w.sdk, { appName: "pda-demo-t", image: "ubuntu:24.04" });
  const made = await client.create({ name: "c1", snapshot: "x", labels: { [LABEL_FLEET]: "mdt", [LABEL_RUN]: "r9" }, autoStopInterval: 0, autoDeleteInterval: 0 });
  assert.equal((await client.get("c1"))?.state, "started");
  assert.deepEqual((await client.get(made.id))?.labels, { [LABEL_FLEET]: "mdt", [LABEL_RUN]: "r9" });
  assert.equal(await client.get("nope"), null);
  assert.equal(await client.get("sb-999"), null);
  assert.deepEqual((await client.list({ [LABEL_FLEET]: "mdt" })).map((b) => b.id), [made.id]);
  assert.deepEqual(await client.list({ [LABEL_FLEET]: "other" }), []);

  const r = await client.exec(made, "echo out; echo err >&2; exit 3", 20);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.result.trim().split("\n").sort(), ["err", "out"]);

  const target = join(w.dir, "deep", "er", "file.txt");
  await client.upload(made, target, new TextEncoder().encode("secret\n"));
  assert.equal(readFileSync(target, "utf8"), "secret\n");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  await assert.rejects(client.upload(made, "/proc/nope/x", new Uint8Array([1])), /upload to sandbox c1/);

  await client.remove(made.id);
  assert.equal((await client.get(made.id))?.state, "destroyed", "found by id after terminate: ended");
  assert.equal(await client.get("c1"), null, "and absent by name");
  await client.remove(made.id);
  await client.remove("sb-999");
  await client.stop("sb-999", true);
  await assert.rejects(client.exec(made, "true", 5), (e: unknown) => e instanceof DaytonaApiError);
});

/** A program detached from every process of the test (its shell exits at once): what the agent leaves running. */
function detachedIn(cwd: string): number {
  const r = spawnSync("sh", ["-c", "setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $!"], { cwd, encoding: "utf8" });
  return Number(r.stdout.trim());
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("mountBlockers: a detached program with its working directory on the mount is found; one elsewhere, and the caller, are not", async () => {
  const mount = scratch("pda-mb-");
  const elsewhere = scratch("pda-mb-else-");
  const holder = detachedIn(mount);
  const bystander = detachedIn(elsewhere);
  try {
    await waitFor("the holder to exist", () => isAlive(holder));
    const found = mountBlockers(mount, null);
    assert.ok(found.includes(holder), "the holder blocks the unmount");
    assert.ok(!found.includes(bystander), "a program elsewhere does not");
    assert.ok(!found.includes(process.pid), "nor does the caller");
    assert.deepEqual(mountBlockers(join(mount, "nothing-here"), null).filter((p) => p === holder), [], "only paths under the mount count");
  } finally {
    for (const pid of [holder, bystander]) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

test("mountBlockers: the launcher, the instance's parent, is not a blocker even when it holds the mount", async () => {
  const mount = scratch("pda-mbl-");
  const holder = detachedIn(mount);
  try {
    await waitFor("the holder to exist", () => isAlive(holder));
    assert.ok(mountBlockers(mount, null).includes(holder), "it blocks when nothing names it the launcher");
    assert.ok(!mountBlockers(mount, null, { launcher: holder }).includes(holder), "named the launcher, it is spared");
  } finally {
    try { process.kill(holder, "SIGKILL"); } catch {}
  }
});

test("a planned stop ends what the agent left on the mount before the instance drains, and nothing else", async () => {
  const d = scratch("pda-md-");
  const mnt = join(d, "mnt");
  const w = world("hold", { mountRoot: mnt });
  const h = await w.host.start(REF, TOKEN);
  const mountpoint = join(mnt, "runs", REF.id);
  assert.equal(h.mountpoint, mountpoint);
  mkdirSync(mountpoint, { recursive: true });
  const spec = JSON.parse(readFileSync(join(w.box, `${String(h.name)}.json`), "utf8")) as LaunchSpec;
  assert.equal(spec.mountpoint, mountpoint, "the launcher is told which mount to free");
  const holder = detachedIn(mountpoint);
  const bystander = detachedIn(d);
  try {
    await w.host.stop(h);
    assert.equal(isAlive(holder), false, "the program holding the mount was ended");
    assert.equal(isAlive(bystander), true, "a program that does not hold it was not");
    assert.equal(launchStatus(w.box, String(h.name)).status, "stopped", "the instance still drained and exited 0 by itself");
  } finally {
    for (const pid of [holder, bystander]) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

test("a driver that does not ask for it leaves detached programs alone (reapOnStop false)", async () => {
  const d = scratch("pda-md-");
  const mnt = join(d, "mnt");
  const w = world("hold", { mountRoot: mnt, reapOnStop: false });
  const h = await w.host.start(REF, TOKEN);
  const mountpoint = join(mnt, "runs", REF.id);
  mkdirSync(mountpoint, { recursive: true });
  const holder = detachedIn(mountpoint);
  try {
    await w.host.stop(h);
    assert.equal(isAlive(holder), true);
  } finally {
    try { process.kill(holder, "SIGKILL"); } catch {}
  }
});

test("create: named Modal Volumes are looked up once, never created, and mounted at their paths", async () => {
  const f = fakeModal("/");
  const looked: { name: string; createIfMissing?: boolean | undefined }[] = [];
  const sdk: ModalSdk = { ...f.sdk, volumes: { fromName: async (name, params) => (looked.push({ name, createIfMissing: params?.createIfMissing }), { volume: name }) } };
  const body = (name: string): CreateSandboxBody => ({ name, snapshot: "x", labels: { [LABEL_FLEET]: "t" }, autoStopInterval: 0, autoDeleteInterval: 0 });
  const client = modalSandboxes(sdk, { appName: "a", image: "im-1", volumes: { "/vol": "weights", "/cache": "sae" } });
  await client.create(body("one"));
  await client.create(body("two"));
  assert.deepEqual(looked, [{ name: "weights", createIfMissing: false }, { name: "sae", createIfMissing: false }], "each volume looked up once, for both creates");
  assert.deepEqual(f.creates.at(-1)!.params.volumes, { "/vol": { volume: "weights" }, "/cache": { volume: "sae" } });
  const plain = modalSandboxes(f.sdk, { appName: "a", image: "im-1" });
  await plain.create(body("three"));
  assert.equal(f.creates.at(-1)!.params.volumes, undefined, "no volumes asked, none sent");
  const noApi = modalSandboxes(f.sdk, { appName: "a", image: "im-1", volumes: { "/vol": "weights" } });
  await assert.rejects(noApi.create(body("four")), /no volumes API/);
});

test("create: a lookup that fails (the app, an image, a volume) is tried again by the next create, not remembered", async () => {
  const f = fakeModal("/");
  const body = (name: string): CreateSandboxBody => ({ name, snapshot: "x", labels: { [LABEL_FLEET]: "t" }, autoStopInterval: 0, autoDeleteInterval: 0 });
  const fails = { app: 1, image: 1, volume: 1 };
  const sdk: ModalSdk = {
    ...f.sdk,
    apps: { fromName: async (name, params) => (fails.app-- > 0 ? Promise.reject(new Error("modal is having a moment")) : f.sdk.apps.fromName(name, params)) },
    images: { ...f.sdk.images, fromId: async (id) => (fails.image-- > 0 ? Promise.reject(new Error("modal is having a moment")) : f.sdk.images.fromId(id)) },
    volumes: { fromName: async (name) => (fails.volume-- > 0 ? Promise.reject(new Error("modal is having a moment")) : { volume: name }) },
  };
  const client = modalSandboxes(sdk, { appName: "a", image: "im-1", volumes: { "/vol": "weights" } });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(client.create(body(`try-${attempt}`)), /moment/);
  await client.create(body("recovered")); // every lookup has now succeeded once
  assert.equal(f.creates.length, 1, "the create went through once Modal recovered");
  await client.create(body("again"));
  assert.equal(f.creates.length, 2);
});

test("modalHost refuses the gvisor runtime without a command, as INVALID_ARGUMENT, and accepts it with one", () => {
  const f = fakeModal("/");
  const base = { sdk: f.sdk, appName: "a", image: "im-1", fleet: "t", mountRoot: "/mnt/x", user: "pda", group: "pda" };
  assert.throws(() => modalHost({ ...base, runtime: "gvisor" } as never), (err: unknown) => (err as { code?: string }).code === "INVALID_ARGUMENT" && /gvisor/.test((err as Error).message));
  assert.doesNotThrow(() => modalHost({ ...base, runtime: "gvisor", command: ["node", "agent.js"] } as never));
  assert.doesNotThrow(() => modalHost({ ...base, runtime: "vm" } as never));
});
