// A fake of the VM provider's SDK client, for the tests: no provider call runs. The server loads it in place of the SDK
// under `--faux` (startServe's `fauxVm`). Each sandbox is local processes in a directory of its own: a box path in a
// command or its working directory (/workspace/..., /run/agentrun/..., the spool under /tmp/pi-transport) is that directory's, so a box
// writes nothing else of this machine. Its shape is the part of the SDK's client pi-transport's VM provider calls (apps,
// images, sandboxes; a sandbox's exec, poll, terminate and tags), as pi-transport's own test fake has it. The test reads the
// same module instance as the server: `vm` is every client made, every sandbox and every create's parameters.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { sudoStandIn } from "./sudo-stand-in.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Named like the SDK's classes: the provider reads `constructor.name`. */
export class NotFoundError extends Error {}

const BOX_PATH = /(^|[\s'"=:])(\/run\/agentrun|\/workspace|\/tmp\/pi-transport)(?=[/'"\s]|$)/g;

/** What the tests read: the clients made (their token), the sandboxes, and how many are running. */
export const vm = {
  clients: [],
  sandboxes: [],
  root: join(process.env.TMPDIR ?? tmpdir(), `agentrun-fake-vm-${process.pid}`),
  running: () => vm.sandboxes.filter((sandbox) => sandbox.exitCode === null),
  /** How long each program's start takes, as a provider's round trip does (0: at once); or, given the command, how long
   *  that program's start takes. */
  execDelayMs: 0,
  /** How long a sandbox's lookup by id takes, as a provider's round trip does (0: at once). */
  lookupDelayMs: 0,
  /** Makes each program's stdout fail after its first chunk, as a broken stream from the provider does. */
  failStdout: false,
  /** Makes each program's exit fail to be read, as a provider that lost the program does. */
  failWait: false,
  /** An error each program's start throws, as the provider's would (its text can quote anything). */
  failExec: undefined,
  /** The bytes every `tar -c` in a box prints in place of its archive (a box whose copy back cannot be read). */
  hostileTar: undefined,
  /** A fake Archil disk (fake-archil.mjs) whose client, root helper and sudo each new sandbox has, as a box image that
   *  ships them; none, a sandbox has none. */
  archil: undefined,
  /** Ends sandbox `id` as the provider would at its lifetime: its programs killed, its directory gone. */
  end: (id) => vm.sandboxes.find((sandbox) => sandbox.sandboxId === id)?.terminate({ wait: true }),
  /** What the sudo stand-in first on every program's PATH was asked (fake-daytona.mjs sudoStandIn). */
  sudoCalls: () => sudoStandIn(vm.root).calls(),
  /** Back to its defaults, every sandbox ended; then it throws when a program ran sudo here (the stand-in refused it),
   *  so a test that trips the guard still leaves nothing for the next. */
  reset: () => {
    const sudo = vm.sudoCalls();
    rmSync(join(vm.root, "sudo.calls"), { force: true });
    vm.execDelayMs = 0;
    vm.failStdout = false;
    vm.failWait = false;
    vm.failExec = undefined;
    vm.hostileTar = undefined;
    vm.lookupDelayMs = 0;
    vm.archil = undefined;
    for (const sandbox of vm.sandboxes) sandbox.terminate({ wait: true });
    vm.clients.length = 0;
    vm.sandboxes.length = 0;
    if (sudo.length) throw new Error(`a box program ran sudo on this machine (the stand-in refused it): ${sudo.join("; ")}`);
  },
};

/** A `tar` first on PATH that prints vm.hostileTar for `-c` and runs the real one otherwise. */
function hostileBin() {
  const bin = join(vm.root, "hostile-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "archive"), vm.hostileTar);
  const real = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "tar"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = -c ] && exec cat '${join(bin, "archive")}'; done\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "tar"), 0o755);
  return bin;
}

/** How many sandboxes this process made, across every reset. */
let made = 0;

class FakeSandbox {
  constructor(sandboxId, params) {
    this.sandboxId = sandboxId;
    this.params = params;
    this.exitCode = null;
    this.execs = [];
    this.dir = join(vm.root, sandboxId);
    mkdirSync(join(this.dir, "tmp"), { recursive: true });
    this.children = new Set();
    this.archil = vm.archil?.box(sandboxId, this.dir, sudoStandIn(vm.root).bin);
  }

  inBox(text) {
    return String(text).replace(BOX_PATH, (_, before, path) => `${before}${this.dir}${path}`);
  }

  async exec(command, params) {
    if (this.exitCode !== null) throw Object.assign(new Error("the sandbox has been terminated"), { code: 9 });
    if (vm.failExec) throw vm.failExec;
    // A program that names a sudo by its absolute path would pass the stand-in by: refused, never run (sudo-stand-in.mjs).
    if (sudoStandIn(vm.root).refuses(command.join(" "))) throw Object.assign(new Error("the fake refuses a program that names an absolute sudo"), { code: 97 });
    const entry = { command, params };
    this.execs.push(entry);
    const failWait = vm.failWait;
    const delay = typeof vm.execDelayMs === "function" ? vm.execDelayMs(command) : vm.execDelayMs;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // The provider's probe of the box's disk, Yama setting and FUSE reads this machine's /proc: answered as a box would.
    const probed = command[0] === "sh" && command[2]?.includes("ptrace_scope");
    const [program, ...rest] = probed ? ["printf", "%s", "disk=104857600\nptrace=1\nfuse_dev=1\n"] : command.map((part) => this.inBox(part));
    const cwd = params.workdir ? this.inBox(params.workdir) : this.dir;
    mkdirSync(cwd, { recursive: true });
    const child = spawn(program ?? "", rest, { cwd, env: { ...this.params.env, PATH: `${this.archil ? `${this.archil.bin}:` : ""}${sudoStandIn(vm.root).bin}:${vm.hostileTar ? `${hostileBin()}:` : ""}${this.params.env?.PATH ?? process.env.PATH ?? ""}`, TMPDIR: join(this.dir, "tmp") }, stdio: ["pipe", "pipe", "pipe"] });
    // Whoever reads the program's output and lets it go before its end (return()) is noted, so a test sees it.
    entry.released = [];
    const noted = (name, stream) => ({
      [Symbol.asyncIterator]() {
        const it = stream[Symbol.asyncIterator]();
        return { next: () => it.next(), return: (value) => (entry.released.push(name), it.return(value)) };
      },
    });
    this.children.add(child);
    child.stdin.on("error", () => {});
    let closed = false;
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.children.delete(child);
        resolve(code ?? (signal === null ? 0 : 137));
      });
    });
    exited.catch(() => {});
    return {
      stdin: {
        writeBytes: (bytes) => new Promise((resolve, reject) => (closed ? reject(new TypeError("Invalid state: WritableStream is closed")) : child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())))),
        close: () => {
          if (closed) return Promise.reject(new TypeError("Invalid state: WritableStream is closed"));
          closed = true;
          // As the SDK's close does, it answers whether or not the program still runs: a pipe whose program exited is
          // closed already, and Node never calls an end's callback on it.
          if (child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
          return new Promise((resolve) => {
            child.stdin.once("close", resolve);
            child.stdin.end(resolve);
          });
        },
      },
      stdout: vm.failStdout
        ? (async function* () {
            for await (const chunk of child.stdout) {
              yield chunk;
              throw new Error("the output stream broke");
            }
          })()
        : noted("stdout", child.stdout),
      stderr: noted("stderr", child.stderr),
      wait: failWait ? () => Promise.reject(Object.assign(new Error("the program was lost"), { code: 14 })) : () => exited,
    };
  }

  async poll() {
    return this.exitCode;
  }

  async terminate() {
    for (const child of this.children) child.kill("SIGKILL");
    if (this.exitCode === null) rmSync(this.dir, { recursive: true, force: true });
    this.exitCode ??= 0;
    return this.exitCode;
  }

  async setTags(tags) {
    this.params.tags = { ...tags };
  }

  async getTags() {
    return { ...this.params.tags };
  }
}

/** The SDK's client: made by the server with its token, which it keeps for the tests to see where it went. */
class FakeClient {
  constructor(params) {
    this.params = params;
    vm.clients.push(this);
    this.apps = { fromName: async (name) => ({ appId: `ap-${name}` }) };
    this.images = { fromRegistry: (tag) => ({ registry: tag }), fromId: async (id) => ({ id }) };
    this.sandboxes = {
      create: async (_app, _image, params) => {
        // Never reused within the process: a server a test left still finishing its end-of-run work can never reach the
        // next test's sandbox, or its directory, by a stale id.
        const sandbox = new FakeSandbox(`sb-${process.pid}-${++made}`, params);
        // The image it was made from, as the SDK names it (images.fromRegistry's answer).
        sandbox.image = _image;
        vm.sandboxes.push(sandbox);
        return sandbox;
      },
      fromId: async (id) => {
        if (vm.lookupDelayMs) await new Promise((resolve) => setTimeout(resolve, vm.lookupDelayMs));
        const found = vm.sandboxes.find((sandbox) => sandbox.sandboxId === id);
        if (!found) throw new NotFoundError(`no sandbox ${id}`);
        return found;
      },
      list: ({ tags }) => {
        const matching = vm.sandboxes.filter((sandbox) => sandbox.exitCode === null && Object.entries(tags).every(([k, v]) => sandbox.params.tags[k] === v));
        return (async function* () {
          yield* matching;
        })();
      },
    };
  }
}

// Exported under the client's name in the SDK, as the server looks it up (boxes.ts VM_PROVIDER.client).
export { FakeClient as ModalClient };
