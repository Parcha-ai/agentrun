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
import { userInfo } from "node:os";
import { join } from "node:path";
import { fakeConnect, fakeGetent, fakeInet6, fakeIptables, fakeStatus } from "./fake-iptables.mjs";
import { fileURLToPath } from "node:url";
import { scratch } from "../support.mjs";

export const DISK = "dsk-00000000000baf76";
export const REGION = "aws-us-east-1";
/** A disk token as the server holds it: planted, so a test finds it wherever it leaks. */
export const TOKEN = "planted-archil-mount-token-sentinel-0123456789";
export const HELPER_PATH = "/usr/local/sbin/agentrun-archil";
/** The Daytona snapshot and the VM box's image that ship the archil client, the helper and the tool user. */
export const SNAPSHOT = "agentrun-archil-box";
/** Archil's IPv4 ranges, the VM box's whole network. */
export const ARCHIL_ALLOW = "192.0.2.0/24,198.51.100.0/24";
export const VM_IMAGE = "registry.example/agentrun-archil-box:1";
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
    env: { AGENTRUN_ARCHIL_DISK: DISK, AGENTRUN_ARCHIL_REGION: REGION, AGENTRUN_ARCHIL_TOKEN: token, AGENTRUN_ARCHIL_GID: String(process.getgid()), AGENTRUN_DAYTONA_SNAPSHOT: SNAPSHOT, AGENTRUN_VM_IMAGE: VM_IMAGE, AGENTRUN_ARCHIL_ALLOW: ARCHIL_ALLOW },
    /** Every call any box's client took, in order: {verb, box, folder, ...}. */
    calls: () => read().calls,
    /** The folders held now, each by the box that holds it. */
    holds: () => read().holds,
    /** Boxes made from now on have a /proc in which any user sees every process (no hidepid), as an image that does
     *  not mount it so. */
    noHidepid() {
      change({ noHidepid: true });
    },
    /** Boxes made from now on have no CAP_NET_ADMIN for root: their firewall cannot be locked. */
    noNetAdmin() {
      change({ noNetAdmin: true });
    },
    /** Boxes made from now on read back one firewall rule fewer than they were given. */
    tamperIptables() {
      change({ tamperIptables: true });
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
      writeFileSync(client, `#!/bin/sh\nFAKE_ARCHIL_NET='${join(dir, ".net")}' FAKE_ARCHIL_STATE='${state}' FAKE_ARCHIL_BOX='${id}' FAKE_ARCHIL_BOX_DIR='${dir}' FAKE_ARCHIL_DISK_ROOT='${disk}' FAKE_ARCHIL_DISK='${DISK}' FAKE_ARCHIL_MOUNTS='${mounts}' exec '${process.execPath}' '${CLI}' "$@"\n`);
      chmodSync(client, 0o755);
      // The box's firewall: its iptables and ip6tables, its getent, its root's capabilities, and the `connect` its
      // tools reach a host with, as that firewall lets them (fake-iptables.mjs).
      const net = join(dir, ".net");
      mkdirSync(net, { recursive: true });
      const flags = read();
      const iptables = fakeIptables(net, "iptables");
      const ip6tables = fakeIptables(net, "ip6tables");
      if (flags.tamperIptables) writeFileSync(join(net, "iptables.tamper"), "");
      const toolBin = join(dir, ".tool-bin");
      mkdirSync(toolBin, { recursive: true });
      fakeConnect(toolBin, join(net, "iptables.chain.AGENTRUN-NET"), process.getuid(), join(net, "ip6tables.chain.AGENTRUN-NET"));
      const helper = join(dir, ".agentrun-archil");
      const source = readFileSync(HELPER, "utf8")
        .replace("\nARCHIL=/usr/bin/archil\n", `\nARCHIL=${client}\n`)
        .replace("\nMP=/workspace\n", `\nMP=${join(dir, "workspace")}\n`)
        .replace("\nMOUNTS=/proc/self/mounts\n", `\nMOUNTS=${mounts}\n`)
        .replace("\nIPTABLES=/usr/sbin/iptables\n", `\nIPTABLES=${iptables}\n`)
        .replace("\nIP6TABLES=/usr/sbin/ip6tables\n", `\nIP6TABLES=${ip6tables}\n`)
        .replace("\nGETENT=/usr/bin/getent\n", `\nGETENT=${fakeGetent(net)}\n`)
        .replace("\nSTATUS=/proc/self/status\n", `\nSTATUS=${fakeStatus(net, !flags.noNetAdmin)}\n`)
        .replace("\nIF_INET6=/proc/net/if_inet6\n", `\nIF_INET6=${fakeInet6(net)}\n`)
        .replace("\nTOOL=agentrun-tool\n", `\nTOOL=${userInfo().username}\n`);
      writeFileSync(helper, source);
      chmodSync(helper, 0o755);
      // The tool user's PATH: the refusing stand-in first, so a tool's sudo meets it (that user has no sudo). Its
      // environment is reset, as sudo's env_reset does: only what the command line passes on reaches the program.
      const asTool = join(dir, ".as-tool");
      writeFileSync(join(bin, "sudo"), [
        "#!/bin/sh",
        `if [ "$#" -ge 2 ] && [ "$1" = -n ] && [ "$2" = '${HELPER_PATH}' ]; then shift 2; exec '${helper}' "$@"; fi`,
        `if [ "$#" -ge 5 ] && [ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = '${TOOL_USER}' ] && [ "$4" = -- ]; then shift 4; printf '%s\\n' "$1" >> '${asTool}'; exec env -i PATH='${refusing}:${toolBin}:/usr/local/bin:/usr/bin:/bin' "$@"; fi`,
        `exec '${join(refusing, "sudo")}' "$@"`,
        "",
      ].join("\n"));
      chmodSync(join(bin, "sudo"), 0o755);
      return { bin, asTool: () => (existsSync(asTool) ? readFileSync(asTool, "utf8").split("\n").filter(Boolean) : []) };
    },
  };
}
