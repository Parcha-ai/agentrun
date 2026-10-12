// The VM's calls to its GPU boxes over the link: a loopback between the client (the VM's end) and the server's handler, with a fake box.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGpuClient, GPU_STDIN_MAX_BYTES, serveGpu, type GpuFrame, type GpuProcess, type GpuServer } from "../pipe/gpu-rpc.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
async function* chunks(parts: string[], gapMs = 0): AsyncGenerator<Uint8Array> {
  for (const p of parts) {
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    yield enc(p);
  }
}
const readAll = async (it: AsyncIterable<Uint8Array>) => {
  let out = "";
  for await (const c of it) out += dec(c);
  return out;
};

function loop(server: GpuServer) {
  let link = true;
  const toServer: GpuFrame[] = [];
  const serving = serveGpu(server, (frame) => queueMicrotask(() => client.handle(frame)));
  const client = createGpuClient((frame) => {
    if (!link) return false;
    toServer.push(frame);
    queueMicrotask(() => serving.handle(frame));
    return true;
  });
  return { client, serving, toServer, cut: () => ((link = false), client.lose("the link closed"), serving.close()) };
}

const proc = (over: Partial<GpuProcess> & { code?: number } = {}): GpuProcess => ({
  stdin: { writeBytes: async () => undefined, close: async () => undefined },
  stdout: chunks(["hello ", "world"]),
  stderr: chunks(["warn"]),
  wait: async () => over.code ?? 0,
  ...over,
});

describe("the GPU calls over the link", () => {
  it("acquires a box for a thread, runs a command there with streamed stdout and stderr and an exit code, and releases", async () => {
    const calls: string[] = [];
    const server: GpuServer = {
      acquire: async (thread) => (calls.push(`acquire ${thread}`), "box-1"),
      release: (thread) => void calls.push(`release ${thread}`),
      holds: (box) => box === "box-1",
      exec: async (box, argv, o) => (calls.push(`exec ${box} ${argv.join(" ")} ${o.timeoutMs}`), proc({ code: 3 })),
      poll: async () => null,
    };
    const { client } = loop(server);
    const box = await client.acquire("thread-a");
    assert.equal(box, "box-1");
    const p = await client.linkBox(box).exec(["sh", "-c", "echo hi"], { mode: "binary", timeoutMs: 5000 });
    const [out, err, code] = await Promise.all([readAll(p.stdout), readAll(p.stderr), p.wait()]);
    assert.equal(out, "hello world");
    assert.equal(err, "warn");
    assert.equal(code, 3);
    assert.equal(await client.linkBox(box).poll(), null);
    await client.release("thread-a");
    assert.deepEqual(calls, ["acquire thread-a", "exec box-1 sh -c echo hi 5000", "release thread-a"]);
  });

  it("carries stdin to the command, byte for byte (binary included), and its end", async () => {
    const got: Uint8Array[] = [];
    let closed = false;
    const server: GpuServer = {
      acquire: async () => "b",
      release: () => undefined,
      holds: () => true,
      exec: async () => proc({ stdin: { writeBytes: async (b) => void got.push(b), close: async () => void (closed = true) }, stdout: chunks([]), stderr: chunks([]) }),
      poll: async () => null,
    };
    const { client } = loop(server);
    const p = await client.linkBox("b").exec(["cat"], { mode: "binary" });
    await p.stdin.writeBytes(enc("first "));
    await p.stdin.writeBytes(new Uint8Array([0xff, 0x00, 0x41]));
    await p.stdin.close();
    await p.wait();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got.map((b) => [...b]), [[...enc("first ")], [0xff, 0x00, 0x41]], "the exact bytes, in order");
    assert.equal(closed, true);
  });

  it("input written and closed before the box has started the command is held and delivered once it starts, in order", async () => {
    const got: number[][] = [];
    const events: string[] = [];
    let start!: () => void;
    const started = new Promise<void>((r) => (start = r));
    const server: GpuServer = {
      acquire: async () => "b",
      release: () => undefined,
      holds: () => true,
      exec: async () => {
        await started; // the box is slow to start the command
        return proc({ stdin: { writeBytes: async (b) => void (got.push([...b]), events.push("write")), close: async () => void events.push("end") }, stdout: chunks([]), stderr: chunks([]) });
      },
      poll: async () => null,
    };
    const { client } = loop(server);
    const p = await client.linkBox("b").exec(["cat"], { mode: "binary" });
    await p.stdin.writeBytes(new Uint8Array([1, 2]));
    await p.stdin.writeBytes(new Uint8Array([3]));
    await p.stdin.close();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, [], "nothing is lost, nothing is written before the command exists");
    start();
    await p.wait();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, [[1, 2], [3]]);
    assert.deepEqual(events, ["write", "write", "end"], "the end comes after the writes");
  });

  it("a command is killed when the link goes: one running, and one the box was still starting", async () => {
    const killed: string[] = [];
    let startSlow!: () => void;
    const slow = new Promise<void>((r) => (startSlow = r));
    const hang = (name: string): GpuProcess => ({
      stdin: { writeBytes: async () => undefined, close: async () => undefined },
      stdout: (async function* () { await new Promise(() => undefined); yield enc("x"); })(),
      stderr: chunks([]),
      wait: () => new Promise(() => undefined),
      kill: async () => void killed.push(name),
    });
    const server: GpuServer = {
      acquire: async () => "b",
      release: () => undefined,
      holds: () => true,
      exec: async (_b, argv) => {
        if (argv[0] === "slow") await slow;
        return hang(argv[0]!);
      },
      poll: async () => null,
    };
    const l = loop(server);
    void l.client.linkBox("b").exec(["running"], { mode: "binary" });
    void l.client.linkBox("b").exec(["slow"], { mode: "binary" });
    await new Promise((r) => setTimeout(r, 60));
    l.cut();
    startSlow(); // the slow start finishes after the link went
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(killed.sort(), ["running", "slow"], "neither is left running for nobody");
  });

  it("a box the thread does not hold is refused, and a box that is gone rejects at once", async () => {
    const server: GpuServer = {
      acquire: async () => "mine",
      release: () => undefined,
      holds: (box) => box === "mine",
      exec: async () => Promise.reject(new Error("box mine is gone")),
      poll: async () => Promise.reject(new Error("box mine is gone")),
    };
    const { client } = loop(server);
    await assert.rejects(client.linkBox("someone-elses").poll(), /no thread of this run holds that box/);
    await assert.rejects(client.linkBox("someone-elses").exec(["id"], { mode: "binary" }).then((p) => p.wait()), /no thread of this run holds that box/);
    await assert.rejects(client.linkBox("mine").exec(["id"], { mode: "binary" }).then((p) => p.wait()), /gone/);
    await assert.rejects(client.linkBox("mine").poll(), /gone/);
  });

  it("every call in flight rejects when the link goes, and a call with no link rejects at once", async () => {
    const server: GpuServer = {
      acquire: () => new Promise(() => undefined), // waits for a box that never comes
      release: () => undefined,
      holds: () => true,
      exec: async () => proc({ stdout: (async function* () { await new Promise((r) => setTimeout(r, 10_000)); yield enc("never"); })(), stderr: chunks([]), wait: () => new Promise(() => undefined) }),
      poll: async () => null,
    };
    const l = loop(server);
    const waiting = l.client.acquire("t");
    const p = await l.client.linkBox("b").exec(["sleep", "99"], { mode: "binary" });
    const exited = p.wait();
    const outDone = readAll(p.stdout);
    await new Promise((r) => setTimeout(r, 30));
    l.cut();
    await assert.rejects(waiting, /link closed/);
    await assert.rejects(exited, /link closed/);
    assert.equal(await outDone, "", "the streams end");
    await assert.rejects(l.client.acquire("again"), /no link to the server/);
    await assert.rejects(l.client.linkBox("b").exec(["x"], { mode: "binary" }), /no link to the server/);
  });

  it("refuses an exec with no argv or non-string argv", async () => {
    const server: GpuServer = { acquire: async () => "b", release: () => undefined, holds: () => true, exec: async () => proc(), poll: async () => null };
    const l = loop(server);
    await assert.rejects(l.client.linkBox("b").exec([], { mode: "binary" }).then((p) => p.wait()), /argv/);
  });

  it("input over the byte bound is refused, whether the command has started or not, and the command is ended", async () => {
    const killed: string[] = [];
    const written: number[] = [];
    let start!: () => void;
    const started = new Promise<void>((r) => (start = r));
    const server: GpuServer = {
      acquire: async () => "b",
      release: () => undefined,
      holds: () => true,
      exec: async (_b, argv) => {
        if (argv[0] === "slow-start") await started;
        return proc({ stdin: { writeBytes: async (b) => void (written.push(b.length), await new Promise((r) => setTimeout(r, 200))), close: async () => undefined }, stdout: (async function* () { await new Promise(() => undefined); yield enc(""); })(), stderr: chunks([]), wait: () => new Promise(() => undefined), kill: async () => void killed.push(argv[0]!) });
      },
      poll: async () => null,
    };
    const { client } = loop(server);
    // Before the command starts: held input past the bound is refused.
    const a = await client.linkBox("b").exec(["slow-start"], { mode: "binary" });
    const failed = a.wait().then(() => "exited", (e: Error) => e.message);
    await a.stdin.writeBytes(new Uint8Array(GPU_STDIN_MAX_BYTES - 10));
    await a.stdin.writeBytes(new Uint8Array(100));
    assert.match(await failed, /over 16777216 bytes/);
    start();
    await new Promise((r) => setTimeout(r, 50));
    // After it started: writes that pile up faster than the box takes them (each takes 200 ms here) are refused at the bound.
    const b = await client.linkBox("b").exec(["running"], { mode: "binary" });
    const failedB = b.wait().then(() => "exited", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 20; i++) await b.stdin.writeBytes(new Uint8Array(1024 * 1024));
    assert.match(await failedB, /over 16777216 bytes/);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(killed.includes("running"), "the command that was overrun is ended");
  });

  it("when the link goes, a wait for a box is cancelled, and a box that arrives after the waiter is gone is released at once", async () => {
    const released: string[] = [];
    let cancelled = false;
    let lateResolve!: (box: string) => void;
    const server: GpuServer = {
      acquire: (thread, signal) =>
        thread === "late"
          ? new Promise<string>((resolve) => (lateResolve = resolve))
          : new Promise<string>((_, reject) => signal?.addEventListener("abort", () => ((cancelled = true), reject(new Error("the wait was cancelled"))), { once: true })),
      release: (thread) => void released.push(thread),
      holds: () => true,
      exec: async () => proc(),
      poll: async () => null,
    };
    const l = loop(server);
    void l.client.acquire("waiting").catch(() => undefined);
    void l.client.acquire("late").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    l.cut();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cancelled, true, "the wait the link was in was cancelled");
    lateResolve("box-7"); // the box was granted just as the link went
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(released, ["late"], "it goes straight back");
  });
});
