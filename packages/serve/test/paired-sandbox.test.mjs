// A Linux box of a person's own with no display, paired (spec/computer/attach.md, A Linux box): computerd's hello says
// linux with files, exec and processes, which is a sandbox. It pairs, it is offered as a sandbox that takes the run's
// folder as a synced folder (attached-computers.ts pairedEntry), and in Mode 2 a run whose agent names it holds that
// folder in the box's own /workspace: pushed in at the claim into an emptied /workspace, each call's delta landed on the
// run's disk before the call answers, a final delta at release (resolve-computer.ts, synced-folder.ts), as for a hosted
// computer that syncs. The box is a person's own machine on its own network, so a run that asks no network is refused.
// The claim runs against the real computerd init in a user namespace of its own, its hub socket bridged to init's as
// `computerd attach` carries it, with /workspace moved to a scratch folder (as workspace-synced-folder.test.mjs does);
// skipped in words where the host has no daemon build or refuses the namespace.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, attachedProvider, DaemonClient, PROTOCOL_VERSION, pushTar, readBackOf, tarOf } from "@parcha/agentrun-computer";
import { pairedEntry, pairedOf, servesNoKind, withPaired } from "../dist/workspace/attached-computers.js";
import { archilWorkspace, computerForClaim, resolveComputer, runKey } from "../dist/workspace/index.js";
import { computerReadiness, noNetworkRefusal } from "../dist/workspace/resolve-computer.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

/** What computerd init says on a Linux box with no display. */
const LINUX = { protocol: PROTOCOL_VERSION, version: "0.2.0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const rowOf = (hello, id = "cmp-lab") => ({ id, name: "lab", hello, driver: hello.version, labels: {}, pairingId: "p-1", createdAt: 0, seenAt: 0, revokedAt: null });
const SANDBOX = { kind: "sandbox", provider: "cmp-lab" };
const keys = { keysOf: async () => ({}) };

test("a headless Linux box pairs as a sandbox that takes the run's folder as a synced folder: Mode 2 holds it so, Mode 1 refuses it (only Docker's binds), a desktop or a phone named as a sandbox is refused naming what it is, and a browser driver is still refused at pairing", async () => {
  assert.equal(servesNoKind("lab", LINUX), undefined, "it pairs");
  assert.equal(servesNoKind("lab", { ...LINUX, groups: ["files", "processes"] }), "lab's driver serves no kind: it says linux but declares no exec: update the driver on lab");
  assert.equal(servesNoKind("ada-chrome", { ...LINUX, kind: "browser", groups: ["cdp"] }), "ada-chrome's driver is a browser: a paired computer can't serve browser sessions yet, so pair a desktop or phone driver");

  const entry = pairedEntry(rowOf(LINUX), KINDS);
  assert.deepEqual({ label: entry.label, kinds: entry.kinds, mounts: entry.mounts, network: entry.network, keys: entry.keys }, { label: "lab (linux)", kinds: ["sandbox"], mounts: ["sync"], network: ["open"], keys: [] });
  const registry = withPaired(KINDS, [rowOf(LINUX)]);
  const held = await resolveComputer(SANDBOX, 2, registry, keys);
  assert.equal(held.refused, undefined, held.refused);
  assert.deepEqual({ provider: held.provider, folder: held.folder, ports: held.ports }, { provider: "cmp-lab", folder: "sync", ports: ["files", "exec", "processes"] });
  assert.match((await resolveComputer(SANDBOX, 1, registry, keys)).refused, /^Mode 1 runs a sandbox only on Docker: a lab \(linux\) sandbox can't reach the run's folder on this machine\./);

  const mac = { ...rowOf({ ...LINUX, os: "macos", kind: "desktop", arch: "arm64", groups: ["screen", "input.pointer", "input.keys", "exec", "files"] }), name: "vesper-mac" };
  assert.deepEqual(pairedEntry(mac, KINDS).mounts, [], "a desktop takes no folder, granted exec and files or not");
  assert.match((await resolveComputer(SANDBOX, 2, withPaired(KINDS, [mac]), keys)).refused, /^vesper-mac \(macos\) gives no sandbox computer: it is a computer of your own, and only a Linux box paired with computerd and no display can be a sandbox computer; give this agent vesper-mac as a desktop computer\. Pick one of /);
});

test("a person's own box is on its own network: a run's start under AGENTRUN_BOX_ALLOW none is refused in the words every computer that needs a network gets, and a create asking another network than open is refused", async () => {
  const registry = withPaired(KINDS, [rowOf(LINUX)]);
  assert.deepEqual(await computerReadiness(SANDBOX, 2, registry, async () => undefined, undefined, "none"), { refused: noNetworkRefusal("lab (linux)", "sandbox") });
  assert.deepEqual(await computerReadiness(SANDBOX, 2, registry, async () => undefined, undefined, ["pypi.org"]), { ok: true });
  const provider = attachedProvider(pairedOf(rowOf(LINUX)), new AttachHub());
  const refused = await provider.create({ image: "attached", lifetimeMs: 60_000, network: { allow: ["pypi.org"] }, mount: { kind: "sync" }, labels: { "agentrun.run": "r1", "agentrun.epoch": "1" } }, { requestId: "r1#1" });
  assert.deepEqual(refused.error, { code: "refused", message: 'lab is a person\'s own machine on its own network, which a run cannot block or limit: network {"allow":["pypi.org"]} is refused; ask for network "open"' });
});

const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const DAEMON = fileURLToPath(new URL(`../../computer/dist/computerd-linux-${ARCH}`, import.meta.url));
const userns = spawnSync("unshare", ["-Ur", "true"]).status === 0;
const skip = !existsSync(DAEMON) ? `needs ${DAEMON}: npm run build:daemon -w @parcha/agentrun-computer` : !userns ? "needs a user namespace (unshare -Ur), which this host refuses" : false;

/** Two ends of one attach socket, delivering in order, closing both ends at once. */
function socketPair() {
  const ends = [{ text: [], closes: [] }, { text: [], closes: [] }];
  let closed;
  const side = (me, peer) => ({
    send(text) { if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text))); },
    close(code, reason) {
      if (closed) return;
      closed = { code, reason };
      queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
    },
    onText(listener) { me.text.push(listener); },
    onClose(listener) { me.closes.push(listener); },
    get closed() { return closed; },
  });
  return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}

/** The hub's end of an attach socket whose far end is computerd's unix socket at `socket`, a frame a line, as
 *  `computerd attach` carries it; every path in and every listed path out moved between /workspace and `root`, so the
 *  box's /workspace is that host folder. */
async function bridge(socket, root) {
  const inside = (path) => (path === "/workspace" ? root : path.startsWith("/workspace/") ? `${root}${path.slice("/workspace".length)}` : path);
  const outside = (path) => (path === root ? "/workspace" : path.startsWith(`${root}/`) ? `/workspace${path.slice(root.length)}` : path);
  const [serve, computer] = socketPair();
  const conn = connect(socket);
  await new Promise((resolve, reject) => conn.once("connect", resolve).once("error", reject));
  const methods = new Map();
  computer.onText((text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined && typeof message.method === "string") methods.set(message.id, message.method);
    const params = message.params;
    if (params && typeof params === "object") {
      if (typeof params.path === "string") params.path = inside(params.path);
      if (typeof params.cwd === "string") params.cwd = inside(params.cwd);
      if (Array.isArray(params.argv)) params.argv = params.argv.map((arg) => arg.replaceAll("/workspace", root));
    }
    conn.write(`${JSON.stringify(message)}\n`);
  });
  createInterface({ input: conn }).on("line", (line) => {
    const message = JSON.parse(line);
    const method = methods.get(message.id);
    methods.delete(message.id);
    if (method === "files.list" && message.result) message.result.entries = message.result.entries.map((entry) => ({ ...entry, path: outside(entry.path) }));
    computer.send(JSON.stringify(message));
  });
  computer.onClose(() => conn.destroy());
  conn.on("close", () => computer.close(1001, "computerd went away"));
  return serve;
}

describe("a paired Linux box's synced folder against computerd in a user namespace", { skip }, () => {
  const dirs = [];
  const scratch = (name) => {
    const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name)));
    dirs.push(dir);
    return dir;
  };
  const dir = scratch("agentrun-paired-box-");
  const socket = join(dir, "computerd.sock");
  let init;
  let stderr = "";
  let hello;

  before(async () => {
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    init = spawn("unshare", ["-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
    init.stderr.on("data", (chunk) => (stderr += chunk));
    for (let tries = 0; !existsSync(socket); tries++) {
      assert.ok(tries < 200 && init.exitCode === null, `computerd's init did not listen at ${socket}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stream = connect(socket);
    await new Promise((resolve, reject) => stream.once("connect", resolve).once("error", reject));
    const said = await new DaemonClient({ readable: stream, writable: stream }).call("hello", { protocol: PROTOCOL_VERSION });
    stream.destroy();
    assert.equal(said.ok, true, JSON.stringify(said));
    hello = said.value;
  });

  after(async () => {
    if (init && init.exitCode === null) {
      const ended = new Promise((resolve) => init.once("exit", resolve));
      init.kill("SIGTERM");
      await ended;
    }
    for (const one of dirs) rmSync(one, { recursive: true, force: true });
  });

  /** The box paired and attached (its /workspace `root`), and a claim of run-1 at `epoch` against `disk`'s folder. */
  const box = async (root) => {
    const row = rowOf(hello);
    const hub = new AttachHub();
    assert.equal((await hub.accept(pairedOf(row), await bridge(socket, root))).ok, true);
    const runs = { epoch: 1 };
    const claim = (disk, epoch) => {
      runs.epoch = epoch;
      const store = {
        runs: { get: async (id) => ({ id, state: "running", epoch: runs.epoch, runner: "runner-1" }) },
        agents: { revision: async () => undefined },
        sealedKeys: { get: async () => undefined, put: async () => {}, remove: async () => {}, all: async () => [] },
        computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
      };
      const workspace = archilWorkspace(disk, ROOT);
      const deps = { mode: 2, kinds: KINDS, sealKey: randomBytes(32), keyOf: async () => undefined, providers: {}, spec: () => ({ image: "attached", lifetimeMs: 60_000, network: "open" }), check: { readBackOf }, workspace, attached: { rows: async () => [row], hub } };
      return { workspace, held: computerForClaim({ runId: "run-1", epoch, computer: SANDBOX }, store, deps) };
    };
    return { hub, row, claim };
  };
  const ROOT = runKey("acme", "run-1");
  const text = (bytes) => (bytes === undefined ? undefined : Buffer.from(bytes).toString());
  const sh = async (client, script) => {
    const ran = await client.call("exec.run", { argv: ["sh", "-c", `cd /workspace && ${script}`], timeoutMs: 30_000 });
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.equal(ran.value.exitCode, 0, `${script}: ${Buffer.from(ran.value.stderr, "base64")}`);
    return Buffer.from(ran.value.stdout, "base64").toString();
  };

  it("a run's exec writes a file that is on the run's disk before the exec answers; reopened at the next claim, the run finds its folder pushed into an emptied /workspace, and a final delta lands at release", async () => {
    const root = scratch("agentrun-paired-workspace-");
    const disk = new FakeArchilDisk();
    const { hub, row, claim } = await box(root);
    const first = claim(disk, 1);
    const one = await first.held;
    assert.equal(one.computer.kind, "sandbox");
    await first.workspace.attach(one.computer.computer, one.computer.check);
    await sh(one.computer.computer.client, "mkdir -p notes && printf 'from run 1' > notes/a.txt");
    assert.equal(text(disk.files.get(`${ROOT}/notes/a.txt`)), "from run 1", "on the disk before the exec answered");
    // A background program's write after the last call: the final delta at release lands it.
    writeFileSync(join(root, "late.txt"), "late");
    await one.release();
    assert.equal(text(disk.files.get(`${ROOT}/late.txt`)), "late");
    assert.equal(hub.claimed(row.id), undefined, "the hold ended; the box stays attached");

    // What another run left on the box is not this run's: the next claim empties /workspace, then pushes the disk's folder.
    writeFileSync(join(root, "stray.txt"), "another run's");
    const second = claim(disk, 2);
    const two = await second.held;
    await second.workspace.attach(two.computer.computer, two.computer.check);
    assert.equal(await sh(two.computer.computer.client, "cat notes/a.txt late.txt"), "from run 1late");
    assert.deepEqual(readdirSync(root).sort(), ["late.txt", "notes"]);
    await two.release();
    hub.revoke(row.id, "the test is over");
  });

  it("the synced folder writes only under the box's /workspace, never through a link: a /workspace that is a link is refused before anything is pushed; a disk folder whose sync.json links a directory outside holding a file is pushed as a plain directory; a pushed link with a file under it is refused by computerd's extract, which opens each name with O_NOFOLLOW", async () => {
    const outside = scratch("agentrun-paired-outside-");
    // /workspace a link to a folder of the person's: refused, nothing written there.
    const linked = join(scratch("agentrun-paired-linked-"), "workspace");
    symlinkSync(outside, linked);
    const disk = new FakeArchilDisk();
    disk.files.set(`${ROOT}/a.txt`, Buffer.from("a"));
    const refusing = await box(linked);
    await assert.rejects(refusing.claim(disk, 1).held, (error) => error.code === "computer_unavailable" && /\/workspace on lab is a link, and a run's synced folder is never written through one: remove it, then make \/workspace a directory of computerd's user's own, mode 0700/.test(error.message));
    assert.deepEqual(readdirSync(outside), []);
    refusing.hub.revoke(refusing.row.id, "the test is over");

    // sync.json names "out" a link to the folder outside, and the disk holds out/x: a directory there, so no link.
    const root = scratch("agentrun-paired-workspace-");
    disk.files.set(`${ROOT}/out/x`, Buffer.from("x"));
    disk.files.set(ROOT.replace(/\/work$/, "/sync.json"), Buffer.from(JSON.stringify({ modes: {}, links: { out: outside } })));
    const { hub, row, claim } = await box(root);
    const one = await claim(disk, 1).held;
    assert.equal(lstatSync(join(root, "out")).isDirectory(), true);
    assert.equal(readFileSync(join(root, "out", "x"), "utf8"), "x");
    assert.deepEqual(readdirSync(outside), []);

    // The run's own connection to the box pushes a link to the folder outside, then a file under it: computerd refuses
    // the file, and the folder outside stays empty.
    const pushed = await pushTar(one.computer.computer.client, "/workspace", tarOf([
      { name: "escape", type: "symlink", mode: 0o777, link: outside },
      { name: "escape/x", type: "file", mode: 0o644, body: Buffer.from("outside") },
    ]));
    assert.equal(pushed.ok, false, JSON.stringify(pushed));
    assert.deepEqual(pushed.error, { code: "denied", message: 'entry "escape/x" is outside the target directory: a symlink or a file is on its way' });
    assert.equal(lstatSync(join(root, "escape")).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside /workspace");
    await one.release();
    hub.revoke(row.id, "the test is over");
  });
});
