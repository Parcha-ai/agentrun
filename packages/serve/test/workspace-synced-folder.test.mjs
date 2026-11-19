// The synced folder, the runner's side (serve/src/workspace/synced-folder.ts, resolve-computer.ts start): in Mode 2 a
// sandbox whose provider takes no Archil mount here (Daytona with no DAYTONA_ARCHIL_EGRESS) holds the run's folder as a
// plain /workspace, and the runner keeps it on the run's disk (ArchilWorkspace.syncStore, over a fake disk). At the
// claim the disk's folder is held to the caps before anything is rented, then pushed in; each call that may change it
// lands its delta on the disk before it answers, or fails in words; a kept computer attached again is pulled whole; at
// release a final delta lands. A loopback fake computer (one folder level, no tar) runs everywhere; a real computerd in a
// user namespace of its own (as the computer package's sync-folder.test.mjs runs it) pushes modes and links into a new
// computer, skipped in words where the host has no daemon build or refuses the namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonClient, readBackOf, SYNC_MAX_BYTES, SYNC_MAX_ENTRIES } from "@parcha/agentrun-computer";
import { archilWorkspace, resolveComputer, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const ROOT = runKey("acme", "r1");
/** Where the folder's modes and links are kept: beside it (archil.ts syncMetaOf). */
const META = ROOT.replace(/\/work$/, "/sync.json");
const EPOCH = 7;
/** The check the claim builds, with its epoch: start() marks it a synced folder's. */
const CHECK = { readBackOf, epoch: EPOCH };
const DAYTONA = { kind: "sandbox", provider: "daytona" };
const KEYS = { DAYTONA_API_KEY: "fake-test-key" };
const DAYTONA_SANDBOX = KINDS.PROVIDERS.find((one) => one.id === "daytona").capabilities.find((one) => one.kind === "linux");

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const scratch = (name = "agentrun-synced-") => {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name)));
  dirs.push(dir);
  return dir;
};

const text = (bytes) => (bytes === undefined ? undefined : Buffer.from(bytes).toString());
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The claim's side: Daytona's keys, and a launch that hands out `computers()` in turn, recording each spec. */
function claim(computers, reattach) {
  const launched = [];
  const released = [];
  return {
    launched,
    released,
    keysOf: async () => KEYS,
    ...(reattach ? { reattach } : {}),
    launch: async (entry, spec) => {
      launched.push(spec);
      const computer = computers();
      const hello = { protocol: "0.2", version: "0", os: "linux", kind: "linux", arch: "amd64", groups: DAYTONA_SANDBOX.groups };
      return { id: computer.id, client: computer.client, readBack: computer.readBack, groups: DAYTONA_SANDBOX.groups, hello, release: async () => void released.push(computer.id) };
    },
  };
}

/** A loopback computer over host folder `root`, reading back a synced folder under the claim's epoch. */
const loopback = (root, options = {}) => fakeComputer(root, { readBack: { kind: "sync", epoch: EPOCH }, ...options });

async function started(disk, computer) {
  const side = claim(() => computer);
  const resolved = await resolveComputer(DAYTONA, 2, KINDS, side);
  const workspace = archilWorkspace(disk, ROOT);
  const run = await resolved.start({ workspace, check: CHECK });
  return { side, resolved, workspace, run, client: run.computer.computer.client };
}

test("Mode 2: a Daytona sandbox with no DAYTONA_ARCHIL_EGRESS holds the run's folder as a synced folder, launched with a sync mount and read back as one", async () => {
  const resolved = await resolveComputer(DAYTONA, 2, KINDS, claim(() => loopback(scratch())));
  assert.equal("refused" in resolved, false, resolved.refused);
  assert.deepEqual({ mounts: resolved.mounts, folder: resolved.folder, ports: resolved.ports }, { mounts: true, folder: "sync", ports: ["files", "exec", "processes"] });
  const { side, workspace, run } = await started(new FakeArchilDisk(), loopback(scratch()));
  assert.deepEqual(side.launched[0].mount, { kind: "sync" }, "no disk, region or token goes to the computer");
  assert.deepEqual(run.computer.check, { ...CHECK, sync: true });
  await workspace.attach(run.computer.computer, run.computer.check);
  await run.release();
});

test("an exec's file is on the run's disk before the exec answers; one held at the disk holds the answer", async () => {
  const root = scratch();
  const disk = new FakeArchilDisk();
  const computer = loopback(root, { exec: () => (computer.plant.file("/workspace/out.txt", "made by the exec\n"), undefined) });
  const { client, run } = await started(disk, computer);
  let letGo;
  disk.hold = new Promise((resolve) => { letGo = resolve; });
  let answered = false;
  const call = client.call("exec.run", { argv: ["sh", "-c", "echo made by the exec > out.txt"], cwd: "/workspace", timeoutMs: 10_000 }).then((result) => ((answered = true), result));
  await tick();
  assert.equal(answered, false, "the exec waits for its delta to land on the disk");
  disk.hold = undefined;
  letGo();
  const result = await call;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(text(disk.files.get(`${ROOT}/out.txt`)), "made by the exec\n");
  await run.release();
});

test("a put the disk refuses fails the call in words: it ran, but the run's folder could not be made durable", async () => {
  const root = scratch();
  const disk = new FakeArchilDisk();
  const computer = loopback(root, { exec: () => (computer.plant.file("/workspace/out.txt", "x"), undefined) });
  const { client, run } = await started(disk, computer);
  const put = disk.putObject.bind(disk);
  let refuse = true;
  disk.putObject = async (key, body) => {
    if (refuse && key.endsWith("/out.txt")) throw new FakeDiskError(503, "ServiceUnavailable", "the disk is away");
    return put(key, body);
  };
  const result = await client.call("exec.run", { argv: ["true"], timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /^exec\.run ran, but the run's folder could not be made durable: 1 of the folder's changes did not land, and are sent again at the next sync: out\.txt: .*the disk is away/);
  assert.equal(disk.files.has(`${ROOT}/out.txt`), false);
  // The next call that may change the folder sends it again.
  refuse = false;
  assert.equal((await client.call("files.mkdir", { path: "/workspace/d" })).ok, true);
  assert.equal(text(disk.files.get(`${ROOT}/out.txt`)), "x");
  assert.equal(disk.dirs.has(`${ROOT}/d`), true);
  await run.release();
});

test("a folder over a cap refuses the claim before any byte is read and anything is rented, naming its size and the cap", async () => {
  const many = new FakeArchilDisk();
  many.pageSize = 5000;
  for (let i = 0; i <= SYNC_MAX_ENTRIES; i++) many.dirs.add(`${ROOT}/d${i}`);
  const big = new FakeArchilDisk();
  big.files.set(`${ROOT}/a.txt`, Buffer.from("a"));
  big.files.set(`${ROOT}/big.bin`, Buffer.from("b"));
  const list = big.listPage.bind(big);
  // The listing's size stands for 2 GiB the fake doesn't hold.
  big.listPage = async (...args) => {
    const page = await list(...args);
    return { ...page, objects: page.objects.map((object) => (object.key.endsWith("/big.bin") ? { ...object, size: SYNC_MAX_BYTES } : object)) };
  };
  for (const [disk, words] of [
    [many, `A Daytona sandbox can't hold this run's folder: the run's folder holds more than ${SYNC_MAX_ENTRIES} entries (files, directories and links), the most a synced folder holds.`],
    [big, `A Daytona sandbox can't hold this run's folder: the run's folder holds ${SYNC_MAX_BYTES + 1} bytes, more than ${SYNC_MAX_BYTES}, the most a synced folder holds.`],
  ]) {
    const side = claim(() => loopback(scratch()));
    const resolved = await resolveComputer(DAYTONA, 2, KINDS, side);
    await assert.rejects(resolved.start({ workspace: archilWorkspace(disk, ROOT), check: CHECK }), (error) => error.code === "computer_unavailable" && error.message === words);
    assert.deepEqual(side.launched, [], "nothing rented");
    assert.deepEqual(disk.calls.filter((call) => call.op !== "listPage"), [], "nothing read but the listing");
  }
});

test("release: a final delta lands what a background program wrote since the last call, then the computer goes; a failed one says writes may be lost, and the computer still goes", async () => {
  const disk = new FakeArchilDisk();
  const computer = loopback(scratch());
  const { side, run } = await started(disk, computer);
  computer.plant.file("/workspace/late.log", "written after the last call\n");
  await run.release();
  assert.equal(text(disk.files.get(`${ROOT}/late.log`)), "written after the last call\n");
  assert.deepEqual(side.released, [computer.id]);

  const failing = new FakeArchilDisk();
  const other = loopback(scratch());
  const second = await started(failing, other);
  other.plant.file("/workspace/late.log", "x");
  failing.putObject = async () => { throw new FakeDiskError(503, "ServiceUnavailable", "the disk is away"); };
  await assert.rejects(second.run.release(), /^Error: the run's folder was not let go cleanly: the final sync failed \(1 of the folder's changes did not land, and are sent again at the next sync: late\.log: .*\), so writes since the last sync may be lost$/);
  assert.deepEqual(second.side.released, [other.id]);
});

const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const DAEMON = fileURLToPath(new URL(`../../computer/dist/computerd-linux-${ARCH}`, import.meta.url));
const userns = spawnSync("unshare", ["-Ur", "unshare", "-n", "true"]).status === 0;
const skip = !existsSync(DAEMON) ? `needs ${DAEMON}: npm run build:daemon -w @parcha/agentrun-computer` : !userns ? "needs a user namespace with its capabilities (unshare -Ur), which this host refuses" : false;

/** `client` (computerd's, on this host) as a computer whose /workspace is host folder `root`: every path in and every
 *  listed path out moved between the two, so the runner's code speaks /workspace as it does to a real computer. */
function at(client, root) {
  const inside = (path) => (path === "/workspace" ? root : path.startsWith("/workspace/") ? `${root}${path.slice("/workspace".length)}` : path);
  const outside = (path) => (path === root ? "/workspace" : path.startsWith(`${root}/`) ? `/workspace${path.slice(root.length)}` : path);
  return {
    async call(method, params, options) {
      const given = { ...params };
      if (typeof given.path === "string") given.path = inside(given.path);
      if (typeof given.cwd === "string") given.cwd = inside(given.cwd);
      if (Array.isArray(given.argv)) given.argv = given.argv.map((arg) => arg.replaceAll("/workspace", root));
      const result = await client.call(method, given, options);
      if (method === "files.list" && result.ok) return { ok: true, value: { ...result.value, entries: result.value.entries.map((entry) => ({ ...entry, path: outside(entry.path) })) } };
      return result;
    },
    close() {},
  };
}

describe("a synced folder against computerd in a user namespace", { skip }, () => {
  const dir = scratch("agentrun-synced-computerd-");
  const socket = join(dir, "computerd.sock");
  let init;
  let stream;
  let daemon;
  let stderr = "";
  let made = 0;
  /** A new computer: an empty folder of its own as /workspace. */
  const computerd = () => {
    const root = join(dir, `computer-${++made}`);
    mkdirSync(root);
    return { id: `computerd-${made}`, root, client: at(daemon, root), readBack: async () => ({ ok: true, value: { kind: "sync", epoch: EPOCH } }) };
  };
  const sh = async (client, script) => {
    const ran = await client.call("exec.run", { argv: ["sh", "-c", `umask 022 && cd /workspace && ${script}`], timeoutMs: 30_000 });
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.equal(ran.value.exitCode, 0, `${script}: ${Buffer.from(ran.value.stderr, "base64")}`);
    return Buffer.from(ran.value.stdout, "base64").toString();
  };
  const stat = async (computer, path) => (await computer.client.call("files.stat", { path: `/workspace/${path}` })).value;
  const MODAL = { kind: "sandbox", provider: "modal" };
  const modalSide = (computer) => ({ ...claim(() => computer), keysOf: async () => ({ MODAL_TOKEN_ID: "fake-test-key", MODAL_TOKEN_SECRET: "not-a-secret" }) });
  const archilMount = { kind: "archil", disk: "d1", region: "aws-us-east-1", folder: ROOT, token: "not-a-secret" };
  /** A computer with `disk`'s folder `prefix` under its Archil mount, as the file API wrote it: every file at the default
   *  mode and no link. */
  const mounted = (disk, prefix) => {
    const computer = computerd();
    for (const [key, bytes] of disk.files) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const path = join(computer.root, key.slice(prefix.length + 1));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, bytes);
      chmodSync(path, 0o644);
    }
    return { ...computer, readBack: async () => ({ ok: true, value: { kind: "archil", epoch: EPOCH } }) };
  };

  before(async () => {
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    init = spawn("unshare", ["-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
    init.stderr.on("data", (chunk) => (stderr += chunk));
    for (let tries = 0; !existsSync(socket); tries++) {
      assert.ok(tries < 200 && init.exitCode === null, `computerd's init did not listen at ${socket}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    stream = connect(socket);
    await new Promise((resolve, reject) => stream.once("connect", resolve).once("error", reject));
    daemon = new DaemonClient({ readable: stream, writable: stream });
  });

  after(async () => {
    stream?.destroy();
    if (init && init.exitCode === null) {
      const ended = new Promise((resolve) => init.once("exit", resolve));
      init.kill("SIGTERM");
      await ended;
    }
  });

  it("a reopened run on a new computer finds its folder, with its modes and links; a kept computer attached again is pulled whole", async () => {
    const disk = new FakeArchilDisk();
    disk.pageSize = 100;
    const workspace = archilWorkspace(disk, ROOT);
    // The first claim: an empty folder pushed in, then a shell's tree landing on the disk as it is made.
    const first = computerd();
    const side = claim(() => first);
    const one = await (await resolveComputer(DAYTONA, 2, KINDS, side)).start({ workspace, check: CHECK });
    await workspace.attach(one.computer.computer, one.computer.check);
    await sh(one.computer.computer.client, "mkdir -p bin empty && printf '#!/bin/sh\\necho hi\\n' > bin/run && chmod 0755 bin/run && printf s > secret && chmod 0600 secret && ln -s bin/run go && head -c 700000 /dev/zero > big.bin");
    assert.equal(text(disk.files.get(`${ROOT}/bin/run`)), "#!/bin/sh\necho hi\n");
    assert.equal(disk.files.get(`${ROOT}/big.bin`).length, 700000);
    assert.equal(disk.dirs.has(`${ROOT}/empty`), true);
    assert.equal(disk.links.size, 0, "a link is kept in sync.json, never as an object");
    assert.deepEqual(JSON.parse(text(disk.files.get(META))), { modes: { "bin/run": 0o755, secret: 0o600 }, links: { go: "bin/run" } });
    await one.release();

    // The run reopened on a new computer: the disk's folder pushed in, modes and links as they were.
    const second = computerd();
    const two = await (await resolveComputer(DAYTONA, 2, KINDS, claim(() => second))).start({ workspace, check: CHECK });
    assert.equal(text(Buffer.from((await second.client.call("files.read", { path: "/workspace/bin/run" })).value.data, "base64")), "#!/bin/sh\necho hi\n");
    assert.equal((await stat(second, "bin/run")).mode, 0o755);
    assert.equal((await stat(second, "secret")).mode, 0o600);
    assert.deepEqual([(await stat(second, "go")).type, (await stat(second, "go")).target], ["symlink", "bin/run"]);
    assert.equal((await stat(second, "empty")).type, "dir");
    assert.equal((await stat(second, "big.bin")).size, 700000);
    assert.equal(await sh(second.client, "./go"), "hi\n");
    const puts = disk.calls.filter((call) => call.op === "putObject").length;
    assert.equal(await sh(two.computer.computer.client, "true"), "");
    assert.equal(disk.calls.filter((call) => call.op === "putObject").length, puts, "the push's own files are not put back");

    // Kept at the park and attached again by a new runner, after its copy moved on with no runner syncing it: pulled
    // whole, so the disk holds what it holds and nothing beyond.
    await sh(second.client, "printf new > new.txt && rm secret && mkdir -p tree/deep && printf t > tree/deep/t");
    const kept = claim(() => assert.fail("a kept computer is attached, not launched"), async (_entry, spec) => {
      assert.equal(spec.folder, "sync");
      return { id: second.id, client: second.client, readBack: second.readBack, groups: DAYTONA_SANDBOX.groups, hello: { protocol: "0.2", version: "0", os: "linux", kind: "linux", arch: "amd64", groups: DAYTONA_SANDBOX.groups }, release: async () => {}, epoch: EPOCH };
    });
    const three = await (await resolveComputer(DAYTONA, 2, KINDS, kept)).start({ workspace, check: CHECK });
    assert.equal(text(disk.files.get(`${ROOT}/new.txt`)), "new");
    assert.equal(text(disk.files.get(`${ROOT}/tree/deep/t`)), "t");
    assert.equal(disk.files.has(`${ROOT}/secret`), false);
    assert.deepEqual(JSON.parse(text(disk.files.get(META))), { modes: { "bin/run": 0o755 }, links: { go: "bin/run" } });
    await three.release();
  });

  it("a link a synced claim recorded, then a plain file an Archil claim wrote at its path: the Archil claim empties sync.json at its start, so the next synced claim pushes the file's new contents, not the old link", async () => {
    const disk = new FakeArchilDisk();
    const workspace = archilWorkspace(disk, ROOT);
    const first = computerd();
    const one = await (await resolveComputer(DAYTONA, 2, KINDS, claim(() => first))).start({ workspace, check: CHECK });
    await sh(one.computer.computer.client, "printf old > target && ln -s target go");
    await one.release();
    assert.deepEqual(JSON.parse(text(disk.files.get(META))).links, { go: "target" });

    // Claimed next where its provider takes the Archil mount (Modal): an exec writes a plain file at the link's path,
    // which the mount lands on the disk as that file.
    const resolved = await resolveComputer(MODAL, 2, KINDS, modalSide(mounted(disk, ROOT)));
    assert.equal(resolved.folder, "archil", "Modal takes the Archil mount here");
    const two = await resolved.start({ workspace: { syncStore: () => workspace.syncStore(), mountSpec: async () => archilMount }, check: CHECK });
    assert.deepEqual(JSON.parse(text(disk.files.get(META))), { modes: {}, links: {} }, "emptied at the Archil claim's start");
    await sh(two.computer.computer.client, "printf new > go");
    disk.files.set(`${ROOT}/go`, Buffer.from("new"));
    await two.release();

    const third = computerd();
    const three = await (await resolveComputer(DAYTONA, 2, KINDS, claim(() => third))).start({ workspace, check: CHECK });
    assert.equal((await stat(third, "go")).type, "file", "the file the Archil claim wrote, not the link sync.json had");
    assert.equal(await sh(third.client, "cat go"), "new");
    await three.release();
  });

  it("a run made on an Archil mount, claimed next where it syncs: the link an exec made and its 0755 file come back, recorded in sync.json at the Archil release, and the link's object leaves the disk", async () => {
    const disk = new FakeArchilDisk();
    const workspace = archilWorkspace(disk, ROOT);
    const first = mounted(disk, ROOT);
    const one = await (await resolveComputer(MODAL, 2, KINDS, modalSide(first))).start({ workspace: { syncStore: () => workspace.syncStore(), mountSpec: async () => archilMount }, check: CHECK });
    await sh(one.computer.computer.client, "mkdir -p bin && printf '#!/bin/sh\\necho hi\\n' > bin/run && chmod 0755 bin/run && ln -s bin/run go");
    // What the mount wrote to the disk: the file's bytes, at no mode, and the link as an object the file API lists as a
    // file and won't read (501).
    disk.files.set(`${ROOT}/bin/run`, Buffer.from("#!/bin/sh\necho hi\n"));
    disk.links.set(`${ROOT}/go`, "bin/run");
    await one.release();
    assert.deepEqual(JSON.parse(text(disk.files.get(META))), { modes: { "bin/run": 0o755 }, links: { go: "bin/run" } }, "recorded through computerd, which sees the mount");

    // The next claim syncs the folder (Daytona with no DAYTONA_ARCHIL_EGRESS): pushed into a new computer, as it was.
    const second = computerd();
    const two = await (await resolveComputer(DAYTONA, 2, KINDS, claim(() => second))).start({ workspace, check: CHECK });
    assert.equal((await stat(second, "bin/run")).mode, 0o755);
    assert.deepEqual([(await stat(second, "go")).type, (await stat(second, "go")).target], ["symlink", "bin/run"]);
    assert.equal(await sh(second.client, "./go"), "hi\n");
    assert.equal(disk.links.has(`${ROOT}/go`), false, "the link's object left the disk: sync.json keeps the link");
    // The link replaced by a file in the computer: a plain put, with no object in its way.
    await sh(two.computer.computer.client, "rm go && printf f > go");
    assert.equal(text(disk.files.get(`${ROOT}/go`)), "f");
    await two.release();
  });
});
