// `diskControl` (src/supervise.ts), no Archil: the one control API the CLI and the acceptance rig build over a disk. A
// shared disk lists delegations with no path (a dead client's private directories), and the supervisor must still start
// a run. Without `exec` it cannot tell such a delegation from the run's own and refuses every pass (CONTROL_API_FAILED):
// the acceptance rig, which kept its own copy without `exec`, started nothing on a disk other clients had died on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diskControl, ensureRunning, type ControlDisk, type HostDriver, type HostHandle, type HostStatus } from "../src/supervise.ts";

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "accept-r1" };

/** A disk the run has never been started on, where a dead client's private directory is listed without a path. */
class FakeDisk {
  objects = new Map<string, string>();
  delegations = [{ clientId: "c-dead", inodeId: 70, isPending: false, isOrphaned: true }];
  /** `Disk.exec` answers by inode: the dead client's private directory, and no run directory. */
  inodes = new Map<string, number>([[".archil/client-c-dead", 70]]);
  ops: string[] = [];
  async getObject(key: string) {
    this.ops.push("getObject");
    const v = this.objects.get(key);
    if (v === undefined) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
    return new TextEncoder().encode(v);
  }
  async headObject(key: string) {
    this.ops.push("headObject");
    return this.objects.has(key) ? { size: 0 } : null;
  }
  async putObject(key: string, body: string | Uint8Array) {
    this.ops.push("putObject");
    this.objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
  }
  async addUser() {
    this.ops.push("addUser");
    return { identifier: "id-1", token: `tok-${"9".repeat(20)}` };
  }
  async removeUser() {
    this.ops.push("removeUser");
  }
  async listDelegations() {
    this.ops.push("listDelegations");
    return this.delegations.map((d) => ({ ...d }));
  }
  async revokeDelegation(d: { clientId: string; inodeId: number }) {
    this.ops.push("revokeDelegation");
    this.delegations = this.delegations.filter((x) => !(x.clientId === d.clientId && x.inodeId === d.inodeId));
  }
  async exec(command: string) {
    this.ops.push("exec");
    const asked = new Set([...command.matchAll(/-inum (\d+)/g)].map((m) => Number(m[1])));
    const runs = [...this.inodes].filter(([path, inode]) => path.startsWith("runs/") && asked.has(inode));
    return { exitCode: 0, stdout: runs.map(([path, inode]) => `${inode} ${path.slice("runs/".length)}\n`).join("") };
  }
}

class FakeHost implements HostDriver {
  started = 0;
  async start(): Promise<HostHandle> {
    this.started++;
    return { driver: "fake", n: this.started };
  }
  async status(): Promise<HostStatus> {
    return "running";
  }
  async stop(): Promise<void> {}
}

test("a dead client's pathless delegation on the disk: the supervisor attributes it through exec and still starts the run", async () => {
  const disk = new FakeDisk();
  const host = new FakeHost();
  const decision = await ensureRunning(REF, host, { control: diskControl(disk as unknown as ControlDisk), now: () => Date.parse("2026-10-10T08:00:00Z") });
  assert.equal(decision.action, "started", `the pass decided ${JSON.stringify(decision)}`);
  assert.equal(host.started, 1);
  assert.ok(disk.ops.includes("exec"), "the pathless delegation was attributed through exec");
  assert.deepEqual(disk.delegations.map((d) => d.clientId), ["c-dead"], "another client's private directory is not the run's: left alone");
});
