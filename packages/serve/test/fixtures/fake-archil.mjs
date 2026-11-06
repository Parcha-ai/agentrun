// A fake Archil for the tests: no Archil call runs. `fakeArchil(t, {data})` is one disk, `<data>/disk`, as the server's
// own conditional mount sees it (a mount table that lists it), and an archil client for each box a fake provider makes
// (fake-daytona.mjs, `archil`): the box gets a copy of the real root helper (box/agentrun-archil) whose three fixed paths
// are the box's own (its client, its /workspace and its mount table), a `sudo` first on its PATH that runs that helper
// for `sudo -n /usr/local/sbin/agentrun-archil` and a command for `sudo -n -u agentrun-tool --` (with no sudo of its own
// after that), and refuses any other. The client records every mount, revoke (a mount --force), sync and checkin, and
// holds a folder for the box that mounted it: a second box's mount of a held folder (or of one above or below it) is
// refused as Archil refuses it, until a checkin or a revoke. A mount is a link of the box's /workspace to the folder on
// the disk, so what the box writes there is the run's work/. While it mounts, it notes how many processes show the
// token in their arguments (`ps -eo args`) and which files of the box hold it.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch } from "../support.mjs";

export const DISK = "dsk-00000000000baf76";
export const REGION = "aws-us-east-1";
/** A disk token as the server holds it: planted, so a test finds it wherever it leaks. */
export const TOKEN = "planted-archil-mount-token-sentinel-0123456789";
export const HELPER_PATH = "/usr/local/sbin/agentrun-archil";
export const TOOL_USER = "agentrun-tool";
const HELPER = fileURLToPath(new URL("../../box/agentrun-archil", import.meta.url));
const CLI = fileURLToPath(new URL("./fake-archil-cli.mjs", import.meta.url));
/** What Archil prints for a mount of a folder another client holds (claim.ts HELD_MARKER). */
export const HELD = "has an outstanding delegation";

/** One disk at `<data>/disk`: the settings that name it, and the server's mount table that lists it. */
export async function fakeArchil(t, { data, token = TOKEN } = {}) {
  const root = realpathSync(await scratch(t));
  const disk = join(data, "disk");
  mkdirSync(disk, { recursive: true });
  const state = join(root, "state.json");
  writeFileSync(state, JSON.stringify({ holds: {}, calls: [] }));
  const serverMounts = join(root, "server-mounts");
  writeFileSync(serverMounts, `proc /proc proc rw 0 0\n${DISK} ${disk} fuse.archil rw,allow_other 0 0\n`);
  const read = () => JSON.parse(readFileSync(state, "utf8"));
  // A change of the state under the lock every box's client takes (fake-archil-cli.mjs): a client mid-call never loses it.
  const change = (fields) => {
    const lock = `${state}.lock`;
    for (let tries = 0; ; tries++) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || tries > 3000) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      writeFileSync(`${state}.next`, JSON.stringify({ ...read(), ...fields }));
      renameSync(`${state}.next`, state);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
  return {
    root,
    disk,
    serverMounts,
    env: { AGENTRUN_ARCHIL_DISK: DISK, AGENTRUN_ARCHIL_REGION: REGION, AGENTRUN_ARCHIL_TOKEN: token, AGENTRUN_ARCHIL_GID: String(process.getgid()) },
    /** Every call any box's client took, in order: {verb, box, folder, ...}. */
    calls: () => read().calls,
    /** The folders held now, each by the box that holds it. */
    holds: () => read().holds,
    /** Boxes made from now on have a /proc in which any user sees every process (no hidepid), as an image that does
     *  not mount it so. */
    noHidepid() {
      change({ noHidepid: true });
    },
    /** Every box's sync fails while `on`, as one whose writes cannot reach the disk: such a box cannot let go. */
    failSyncs(on) {
      change({ failSync: on });
    },
    /**
     * Sets up box `id`, whose box paths are below `dir`: its client, its helper and its `sudo`. Answers the directory to
     * put first on the box's PATH, and the PATH a command as the tool user gets (no sudo but the refusing stand-in,
     * `refusing`).
     */
    box(id, dir, refusing) {
      const bin = join(dir, ".fake-bin");
      mkdirSync(bin, { recursive: true });
      const mounts = join(dir, ".mounts");
      if (!existsSync(mounts)) writeFileSync(mounts, `proc /proc proc rw,nosuid,nodev,noexec,relatime${read().noHidepid ? "" : ",hidepid=invisible"} 0 0\n`);
      const client = join(dir, ".archil");
      writeFileSync(client, `#!/bin/sh\nFAKE_ARCHIL_STATE='${state}' FAKE_ARCHIL_BOX='${id}' FAKE_ARCHIL_BOX_DIR='${dir}' FAKE_ARCHIL_DISK_ROOT='${disk}' FAKE_ARCHIL_DISK='${DISK}' FAKE_ARCHIL_MOUNTS='${mounts}' exec '${process.execPath}' '${CLI}' "$@"\n`);
      chmodSync(client, 0o755);
      const helper = join(dir, ".agentrun-archil");
      const source = readFileSync(HELPER, "utf8")
        .replace("\nARCHIL=/usr/bin/archil\n", `\nARCHIL=${client}\n`)
        .replace("\nMP=/workspace\n", `\nMP=${join(dir, "workspace")}\n`)
        .replace("\nMOUNTS=/proc/self/mounts\n", `\nMOUNTS=${mounts}\n`);
      writeFileSync(helper, source);
      chmodSync(helper, 0o755);
      // The tool user's PATH: the refusing stand-in first, so a tool's sudo meets it (that user has no sudo).
      const asTool = join(dir, ".as-tool");
      writeFileSync(join(bin, "sudo"), [
        "#!/bin/sh",
        `if [ "$#" -ge 2 ] && [ "$1" = -n ] && [ "$2" = '${HELPER_PATH}' ]; then shift 2; exec '${helper}' "$@"; fi`,
        `if [ "$#" -ge 5 ] && [ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = '${TOOL_USER}' ] && [ "$4" = -- ]; then shift 4; printf '%s\\n' "$1" >> '${asTool}'; PATH='${refusing}:/usr/local/bin:/usr/bin:/bin' exec "$@"; fi`,
        `exec '${join(refusing, "sudo")}' "$@"`,
        "",
      ].join("\n"));
      chmodSync(join(bin, "sudo"), 0o755);
      return { bin, asTool: () => (existsSync(asTool) ? readFileSync(asTool, "utf8").split("\n").filter(Boolean) : []) };
    },
  };
}
