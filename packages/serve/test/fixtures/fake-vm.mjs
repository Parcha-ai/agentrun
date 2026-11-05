// A fake of the VM provider's SDK client, for the tests: no provider call runs. The server loads it in place of the SDK
// under `--faux` (startServe's `fauxVm`). Each sandbox is local processes in a directory of its own: a box path in a
// command or its working directory (/run/agentrun/..., the spool under /tmp/pi-transport) is that directory's, so a box
// writes nothing else of this machine. Its shape is the part of the SDK's client pi-transport's VM provider calls (apps,
// images, sandboxes; a sandbox's exec, poll, terminate and tags), as pi-transport's own test fake has it. The test reads the
// same module instance as the server: `vm` is every client made, every sandbox and every create's parameters.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Named like the SDK's classes: the provider reads `constructor.name`. */
export class NotFoundError extends Error {}

const BOX_PATH = /(^|[\s'"=:])(\/run\/agentrun|\/tmp\/pi-transport)(?=[/'"\s]|$)/g;

/** What the tests read: the clients made (their token), the sandboxes, and how many are running. */
export const vm = {
  clients: [],
  sandboxes: [],
  root: join(process.env.TMPDIR ?? tmpdir(), `agentrun-fake-vm-${process.pid}`),
  running: () => vm.sandboxes.filter((sandbox) => sandbox.exitCode === null),
  /** How long each program's start takes, as a provider's round trip does (0: at once). */
  execDelayMs: 0,
  /** Makes each program's stdout fail after its first chunk, as a broken stream from the provider does. */
  failStdout: false,
  /** Makes each program's exit fail to be read, as a provider that lost the program does. */
  failWait: false,
  /** An error each program's start throws, as the provider's would (its text can quote anything). */
  failExec: undefined,
  /** Ends sandbox `id` as the provider would at its lifetime: its programs killed, its directory gone. */
  end: (id) => vm.sandboxes.find((sandbox) => sandbox.sandboxId === id)?.terminate({ wait: true }),
  reset: () => {
    vm.execDelayMs = 0;
    vm.failStdout = false;
    vm.failWait = false;
    vm.failExec = undefined;
    for (const sandbox of vm.sandboxes) sandbox.terminate({ wait: true });
    vm.clients.length = 0;
    vm.sandboxes.length = 0;
  },
};

class FakeSandbox {
  constructor(sandboxId, params) {
    this.sandboxId = sandboxId;
    this.params = params;
    this.exitCode = null;
    this.execs = [];
    this.dir = join(vm.root, sandboxId);
    mkdirSync(join(this.dir, "tmp"), { recursive: true });
    this.children = new Set();
  }

  inBox(text) {
    return String(text).replace(BOX_PATH, (_, before, path) => `${before}${this.dir}${path}`);
  }

  async exec(command, params) {
    if (this.exitCode !== null) throw Object.assign(new Error("the sandbox has been terminated"), { code: 9 });
    if (vm.failExec) throw vm.failExec;
    this.execs.push({ command, params });
    const failWait = vm.failWait;
    if (vm.execDelayMs) await new Promise((resolve) => setTimeout(resolve, vm.execDelayMs));
    // The provider's probe of the box's disk, Yama setting and FUSE reads this machine's /proc: answered as a box would.
    const probed = command[0] === "sh" && command[2]?.includes("ptrace_scope");
    const [program, ...rest] = probed ? ["printf", "%s", "disk=104857600\nptrace=1\nfuse_dev=1\n"] : command.map((part) => this.inBox(part));
    const cwd = params.workdir ? this.inBox(params.workdir) : this.dir;
    mkdirSync(cwd, { recursive: true });
    const child = spawn(program ?? "", rest, { cwd, env: { PATH: process.env.PATH ?? "", ...this.params.env, TMPDIR: join(this.dir, "tmp") }, stdio: ["pipe", "pipe", "pipe"] });
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
        : child.stdout,
      stderr: child.stderr,
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
        const sandbox = new FakeSandbox(`sb-${process.pid}-${vm.sandboxes.length + 1}`, params);
        vm.sandboxes.push(sandbox);
        return sandbox;
      },
      fromId: async (id) => {
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
