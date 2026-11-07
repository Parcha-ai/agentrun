// The fake archil client of one box (fake-archil.mjs): `mount [--force] <disk>:/<folder> <mountpoint> --region <r>`,
// `sync <mountpoint>` and `checkin <mountpoint>`, as the root helper calls them. The disk's state (who holds which
// folder, every call) is one JSON file every box's client shares; the calls of one test are one after another.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const STATE = env.FAKE_ARCHIL_STATE;
const BOX = env.FAKE_ARCHIL_BOX;
const BOX_DIR = env.FAKE_ARCHIL_BOX_DIR;
const DISK_ROOT = env.FAKE_ARCHIL_DISK_ROOT;
const DISK = env.FAKE_ARCHIL_DISK;
const MOUNTS = env.FAKE_ARCHIL_MOUNTS;
const EXPECTED_TOKEN = "planted-archil-mount-token-sentinel-0123456789";

// One client at a time: boxes of two runs mount at once, and the state is one file every client reads and writes.
const LOCK = `${STATE}.lock`;
for (let tries = 0; ; tries++) {
  try {
    mkdirSync(LOCK);
    break;
  } catch (error) {
    if (error.code !== "EEXIST" || tries > 3000) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
process.on("exit", () => rmSync(LOCK, { recursive: true, force: true }));
const state = JSON.parse(readFileSync(STATE, "utf8"));
const save = () => {
  writeFileSync(`${STATE}.next`, JSON.stringify(state));
  renameSync(`${STATE}.next`, STATE);
};
const fail = (message, code = 1) => {
  process.stderr.write(`✗ ${message}\n`);
  save();
  process.exit(code);
};
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** The files below `dir` (no link followed) whose bytes hold `needle`. */
function holding(dir, needle) {
  const found = [];
  const walk = (at) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          if (readFileSync(path).includes(needle)) found.push(path);
        } catch {}
      }
    }
  };
  walk(dir);
  return found;
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "mount") {
  const force = rest[0] === "--force";
  const [source, mountpoint, flag, region] = force ? rest.slice(1) : rest;
  const at = source.indexOf(":/");
  const disk = source.slice(0, at);
  const folder = source.slice(at + 2);
  const token = env.ARCHIL_MOUNT_TOKEN ?? "";
  const call = { verb: force ? "revoke" : "mount", box: BOX, folder, region, flag, argv: process.argv.slice(2), tokenInEnv: token === EXPECTED_TOKEN, netlocked: existsSync(join(env.FAKE_ARCHIL_NET, "iptables.chain.AGENTRUN-NET")) && existsSync(join(env.FAKE_ARCHIL_NET, "ip6tables.chain.AGENTRUN-NET")) };
  // While the mount runs: how many processes show the token in their arguments, and which files of the box hold it.
  const ps = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
  call.psWithToken = token ? ps.split("\n").filter((line) => line.includes(token)).length : 0;
  call.filesWithToken = token ? holding(BOX_DIR, token) : [];
  state.calls.push(call);
  if (disk !== DISK) fail(`no disk ${disk}`);
  if (token !== EXPECTED_TOKEN) fail("unauthorized: the disk refused the token");
  const other = Object.entries(state.holds).find(([path, box]) => box !== BOX && overlaps(path, folder));
  if (other && !force) call.refused = "held";
  if (other && !force) fail(`mount failed: ${other[0]} ${"has an outstanding delegation"} held by another client`);
  if (other) {
    delete state.holds[other[0]];
    call.revoked = other[1];
  }
  state.holds[folder] = BOX;
  // The mount: the box's mountpoint is the folder on the disk.
  if (lstatSync(mountpoint).isDirectory()) rmdirSync(mountpoint);
  symlinkSync(join(DISK_ROOT, folder), mountpoint);
  appendFileSync(MOUNTS, `${DISK}:/${folder}[${region}] ${mountpoint} fuse.archil rw 0 0\n`);
  save();
} else if (verb === "sync" || verb === "checkin") {
  const mountpoint = rest[0];
  const line = readFileSync(MOUNTS, "utf8").split("\n").find((entry) => entry.split(" ")[1] === mountpoint && entry.split(" ")[2] === "fuse.archil");
  const folder = line?.split(" ")[0].replace(/^[^:]*:\//, "").replace(/\[[^\]]*\]$/, "");
  state.calls.push({ verb, box: BOX, folder });
  if (!line) fail(`${mountpoint} is not mounted`);
  if (verb === "sync" && state.failSync) fail("sync failed: the disk did not answer");
  // A checkin by a client that holds no delegation on the folder (it checked in already, or another forced its hold
  // off) fails as Archil's does, measured on client 0.10.1: EROFS, "Unexpected error (30)".
  if (verb === "checkin") {
    if (state.holds[folder] !== BOX) fail(`'checkin' operation failed while 'running command ArchilCheckinInode' on '${mountpoint}': Unexpected error (30)`);
    delete state.holds[folder];
  }
  save();
} else fail(`the fake archil takes no ${verb}`, 2);
