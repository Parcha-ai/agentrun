// The claim directory: the mount table check when it opens, writes through the open directory whatever the root's path
// names now, and the checks that the root's path (and the owner lock's) are still the claim's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitCodeFor, FencedError } from "../src/errors.ts";
import { CLAIM_UNMOUNTED, deviceName, openClaimDir, persistRecord, readRunRecord, RUN_JSON, writeRunRecord, type RunRecord } from "../src/status.ts";
import { scratchRoot } from "./_run-support.ts";

const unmounted = (error: unknown) => error instanceof FencedError && error.code === CLAIM_UNMOUNTED && exitCodeFor(error) === 75;

/** glibc's makedev. */
const makedev = (major: bigint, minor: bigint) => (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);

const record: RunRecord = {
  run: "r1",
  status: "running",
  generation: 1,
  sealedSeq: null,
  wakeAt: null,
  holder: { driver: "local", host: "h", bootId: null, pid: 42, since: "2026-10-07T00:00:00.000Z" },
  heartbeatAt: "2026-10-07T00:00:01.000Z",
  updatedAt: "2026-10-07T00:00:01.000Z",
  detail: null,
};

/** A run root, and the place its directory is moved to when a test takes its path away. */
function swappable(prefix: string) {
  const dir = scratchRoot(prefix);
  const held = `${dir.root}.held`;
  return {
    root: dir.root,
    held,
    /** The root's path now names a new empty directory; the old one lives on at `held`, as a lazily unmounted mount does. */
    swap() {
      renameSync(dir.root, held);
      mkdirSync(dir.root);
    },
    remove() {
      dir.remove();
      rmSync(held, { recursive: true, force: true });
    },
  };
}

let tables = 0;

/** A mountinfo table (a file of its own) with one line for `mountpoint`. */
function mountinfo(dir: string, mountpoint: string, dev: string, fstype: string): string {
  const file = join(dir, `mountinfo-${++tables}`);
  const escaped = mountpoint.replace(/[ \t\n\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`);
  writeFileSync(file, `25 1 9:3 / / rw,relatime shared:1 - ext4 /dev/md3 rw\n36 25 ${dev} / ${escaped} rw,nosuid,nodev,relatime shared:9 - ${fstype} dsk-1:/runs/r1 rw,user_id=0,group_id=0,allow_other\n`);
  return file;
}

describe("the claim directory", () => {
  it("names devices as the mount table does", () => {
    for (const [major, minor] of [[9n, 3n], [0n, 61n], [259n, 1n], [4095n, 255n], [4096n, 256n], [0x12345n, 0x6789an]] as const) {
      assert.equal(deviceName(makedev(major, minor)), `${major}:${minor}`);
    }
    const fields = readFileSync("/proc/self/mountinfo", "utf8").split("\n").findLast((l) => l.split(" ")[4] === "/")!.split(" ");
    assert.equal(deviceName(statSync("/", { bigint: true }).dev), fields[2], "the root file system's device, as this kernel lists it");
  });

  it("opens only a root that is the mount point of a mount of its type on the directory's device", async () => {
    const dir = scratchRoot("claimdir-mount");
    try {
      const root = join(dir.root, "runs with space");
      mkdirSync(root);
      const dev = deviceName(statSync(root, { bigint: true }).dev);
      const ok = await openClaimDir(root, { mountinfo: mountinfo(dir.root, root, dev, "fuse.archil") });
      assert.match(ok.at, /^\/proc\/self\/fd\/\d+$/);
      await ok.close();
      for (const [why, table] of [
        ["another type", mountinfo(dir.root, root, dev, "ext4")],
        ["another device", mountinfo(dir.root, root, "0:999", "fuse.archil")],
        ["another mount point", mountinfo(dir.root, dir.root, dev, "fuse.archil")],
      ] as const) {
        await assert.rejects(openClaimDir(root, { mountinfo: table }), unmounted, why);
      }
      await assert.rejects(openClaimDir(root), unmounted, "a local directory is no Archil mount in this process's table");
      await assert.rejects(openClaimDir(join(dir.root, "missing"), { fstype: null }), unmounted, "a root that cannot be opened");
      const fstype = readFileSync("/proc/self/mountinfo", "utf8").split("\n").findLast((l) => l.split(" ")[4] === "/")!.split(" - ")[1]!.split(" ")[0]!;
      const slash = await openClaimDir("/", { fstype });
      await slash.close();
    } finally {
      dir.remove();
    }
  });

  it("writes land in the directory opened, whatever the root's path names now; run.json is refused once the path moved", async () => {
    const t = swappable("claimdir-at");
    try {
      const claim = await openClaimDir(t.root, { fstype: null });
      await writeRunRecord(claim, record);
      assert.deepEqual(await readRunRecord(claim), record, "run.json round-trips through the directory");
      t.swap();
      await persistRecord(claim.at, "{}\n");
      assert.equal(readFileSync(join(t.held, RUN_JSON), "utf8"), "{}\n", "the write went to the directory held open");
      assert.deepEqual(readdirSync(t.root), [], "and not to the root's path");
      await assert.rejects(claim.assertMounted(), unmounted);
      await assert.rejects(writeRunRecord(claim, { ...record, generation: 2 }), unmounted);
      assert.equal(readFileSync(join(t.held, RUN_JSON), "utf8"), "{}\n", "the check refused before the write");
      assert.deepEqual(readdirSync(t.root), [], "nothing under the root's path");
      await claim.close();
      assert.throws(() => claim.at, FencedError, "a closed directory has no path: its number may name another file");
      await assert.rejects(claim.assertMounted(), unmounted);
    } finally {
      t.remove();
    }
  });

  it("assertSame holds only while the file the path names is the directory's own", async () => {
    const t = swappable("claimdir-same");
    try {
      const claim = await openClaimDir(t.root, { fstype: null });
      writeFileSync(join(t.root, "owner.lock"), "");
      await claim.assertSame("owner.lock");
      t.swap();
      writeFileSync(join(t.root, "owner.lock"), "");
      await assert.rejects(claim.assertSame("owner.lock"), unmounted, "the path's file is another inode");
      rmSync(join(t.held, "owner.lock"));
      await assert.rejects(claim.assertSame("owner.lock"), unmounted, "the directory has no such file");
      await claim.close();
    } finally {
      t.remove();
    }
  });

  it("a write through a directory that is gone fails; the run's root path stays empty", async () => {
    const t = swappable("claimdir-gone");
    try {
      const claim = await openClaimDir(t.root, { fstype: null });
      t.swap();
      rmSync(t.held, { recursive: true });
      await assert.rejects(persistRecord(claim.at, "{}\n"), (error: unknown) => (error as { code?: string }).code === "ENOENT");
      assert.deepEqual(readdirSync(t.root), []);
      await claim.close();
    } finally {
      t.remove();
    }
  });
});
