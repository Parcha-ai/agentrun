// The cluster's GPU boxes through pi-transport's modalBoxes: what each box is asked to be (the exact H100!, gVisor, the sizes, the lifetime, the labels a sweep and a check find it by), how a command runs
// in it (its own process group, killed by a second exec when the link that asked for it is gone) and how an error of the provider reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modalBoxes } from "@parcha/pi-transport/box/modal";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { boxLabels, clusterSpec, gpuProcess, runToEnd, unwrap } from "../transport-boxes.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: string[]) { for (const p of parts) yield enc(p); }

test("a cluster box is asked for exactly: the exact GPU type, gVisor, the sizes, a workspace, a lifetime, and the four labels", () => {
  const labels = boxLabels("walks-home", "fleet-1", 3);
  assert.deepEqual(labels, { "pda-fleet": "fleet-1", "pda-run": "walks-home", "pda-role": "gpu", "pda-slot": "3" });
  assert.deepEqual(clusterSpec({ image: "im-abc", ttlMinutes: 40, cpu: 8, memoryMiB: 65536 }, labels), {
    image: "im-abc", gpu: "H100!", isolation: "gvisor", cpus: 8, memoryMb: 65536, workspace: "/workspace", maxLifetimeMs: 40 * 60_000, labels,
  });
  assert.equal(clusterSpec({ image: "im-abc", type: "H100" }, labels).gpu, "H100", "an operator's type replaces the default");
});

test("an error of the provider reads as its code and message, and a value passes through", () => {
  assert.equal(unwrap({ ok: true, value: 7 } as never), 7);
  assert.throws(() => unwrap({ ok: false, error: { code: "capacity", message: "no H100 right now" } } as never), /capacity: no H100 right now/);
});

test("runToEnd runs a command to its end and returns its exit code and everything it printed; the timeout reaches the box", async () => {
  const seen: { argv: readonly string[]; timeoutMs: number | undefined }[] = [];
  const box = { exec: async (argv: readonly string[], o?: { timeoutMs?: number }) => (seen.push({ argv, timeoutMs: o?.timeoutMs }), { ok: true, value: { stdin: { write: async () => undefined, close: async () => undefined }, stdout: chunks("line 1\n", "line 2\n"), stderr: chunks("warn\n"), wait: async () => ({ ok: true, value: 0 }) } }) };
  const out = await runToEnd(box as never, ["sh", "-c", "echo hi"], 30_000, ctx);
  assert.equal(out.exitCode, 0);
  assert.match(out.result, /line 1\nline 2\n/);
  assert.match(out.result, /warn/);
  assert.deepEqual(seen, [{ argv: ["sh", "-c", "echo hi"], timeoutMs: 30_000 }]);
});

test("a thread's command runs in its own process group with the group's id in a file, and kill ends that group by a second command", async () => {
  const execs: (readonly string[])[] = [];
  const written: Uint8Array[] = [];
  let closed = false;
  const box = {
    exec: async (argv: readonly string[]) => {
      execs.push(argv);
      return { ok: true, value: { stdin: { write: async (b: Uint8Array) => void written.push(b), close: async () => void (closed = true) }, stdout: chunks("out"), stderr: chunks(), wait: async () => ({ ok: true, value: 3 }) } };
    },
  };
  const proc = await gpuProcess(box as never, ["python", "train.py"], {}, ctx);
  assert.equal(execs.length, 1);
  assert.deepEqual(execs[0]!.slice(0, 2), ["sh", "-c"]);
  assert.match(execs[0]![2]!, /setsid -w/);
  assert.match(execs[0]![3]!, /^\/tmp\/\.pda-rpc\/[0-9a-f]{12}$/, "the group's id goes to a file with a random name");
  assert.deepEqual(execs[0]!.slice(4), ["python", "train.py"]);
  await proc.stdin.writeBytes(enc("input"));
  await proc.stdin.close();
  assert.equal(new TextDecoder().decode(written[0]), "input");
  assert.ok(closed);
  assert.equal(await proc.wait(), 3);
  await proc.kill!();
  assert.equal(execs.length, 2, "kill is a second command");
  assert.match(execs[1]![2]!, /kill -TERM -- -\$p/);
  assert.equal(execs[1]![3], execs[0]![3], "it names the same file");
});

test("through modalBoxes, a cluster box reaches Modal as the exact type on gVisor with its sizes, its lifetime and its labels in tags", async () => {
  const created: Record<string, unknown>[] = [];
  const sandbox = { sandboxId: "sb-1", exec: async () => ({ stdin: { writeBytes: async () => undefined, close: async () => undefined }, stdout: chunks(), stderr: chunks(), wait: async () => 0 }), poll: async () => null, terminate: async () => 0, getTags: async () => ({}) };
  const sdk = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    images: { fromRegistry: (t: string) => ({ t }), fromId: async (id: string) => ({ id }) },
    sandboxes: { create: async (_a: unknown, _i: unknown, p: Record<string, unknown>) => (created.push(p), sandbox), fromId: async () => sandbox, list: async function* () { yield sandbox; } },
  };
  const provider = modalBoxes(sdk as never, { appName: "pda-demo-d4" });
  const made = await provider.create(clusterSpec({ image: "im-abc", ttlMinutes: 40, cpu: 8, memoryMiB: 65536 }, boxLabels("walks-home", "fleet-1", 0)), ctx);
  assert.equal(made.ok, true, JSON.stringify(made));
  const p = created[0]!;
  assert.equal(p.gpu, "H100!");
  assert.equal(p.runtime, "gvisor");
  assert.equal(p.cpu, 8);
  assert.equal(p.memoryMiB, 65536);
  assert.equal(p.timeoutMs, 40 * 60_000);
  assert.deepEqual({ run: (p.tags as Record<string, string>)["pda-run"], role: (p.tags as Record<string, string>)["pda-role"], slot: (p.tags as Record<string, string>)["pda-slot"], box: (p.tags as Record<string, string>)["pi-transport.box"] }, { run: "walks-home", role: "gpu", slot: "0", box: "1" });
});
