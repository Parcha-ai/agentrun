// The owner's Archil disk, for the boxes on another machine (place.ts REMOTE_BOXES). They cannot bind this machine's
// folders, and nothing is copied in or out, so each keeps its run's work folder on the disk: the server reads and writes
// the disk through its own mount of it at <data>/disk (the operator's, with --conditional, so every client may write
// where no other holds a folder), and a box mounts exactly its run's work/ at /workspace, exclusively, through the root
// helper the box's image ships (box/agentrun-archil). Serve itself runs nothing as root, here or in a box: it checks the
// mount table, and asks the box's own user to run the helper through sudo.
//
// The disk token is the server's (a secret, like the boxes' keys: no run's process is handed it). It goes into a box
// only on the helper's fd 0: on a box that takes a program's stdin as a real descriptor (its facts' secretsVia `fd`), on
// the stdin of the helper's exec; on any other, whose stdin may travel as the arguments of commands, as a file in a new
// 0700 folder of the box's own user, opened as fd 0 and unlinked with its folder before the helper starts. The run's tools
// run as another user, which has no sudo and no way into that folder (tool-user.ts).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { DISK_DIR } from "@parcha/pi-durable-agent";
import type { Box } from "@parcha/pi-transport";

export const ARCHIL_DISK_ENV = "AGENTRUN_ARCHIL_DISK";
export const ARCHIL_REGION_ENV = "AGENTRUN_ARCHIL_REGION";
export const ARCHIL_TOKEN_ENV = "AGENTRUN_ARCHIL_TOKEN";
/** The group a box's tool user and this server's user share, which owns each run's work folder (0o2770): Archil keeps
 *  a file's uid and gid as they are, with no mapping between machines. */
export const ARCHIL_GID_ENV = "AGENTRUN_ARCHIL_GID";
export const DEFAULT_ARCHIL_GID = 2510;
/** The server's own secret, which no run's process gets (runs.ts SERVER_ONLY). */
export const ARCHIL_KEYS: readonly string[] = [ARCHIL_TOKEN_ENV];
/** Why a box on another machine is unavailable when the disk is not configured: what to do, in capabilities, at a save
 *  and at a run. */
export const NO_ARCHIL = `remote boxes keep their run folder on an Archil disk: configure ${ARCHIL_DISK_ENV}, ${ARCHIL_REGION_ENV} and ${ARCHIL_TOKEN_ENV}, or use the docker box`;
/** Why a remote box is unavailable with Archil but no image that ships the helper: its provider's words (`why`), with
 *  the setting that names one. */
export const noDiskImage = (why: string): string =>
  `remote boxes need an image that has the archil client, the helper and the agentrun-tool user (see the README): ${why}`;
/** Where a box's image has the root helper, and the user its tools run as. */
export const HELPER_PATH = "/usr/local/sbin/agentrun-archil";
/** What Archil answers a mount of a folder another client holds. */
const HELD = "has an outstanding delegation";
/** Why a box whose /proc does not hide each user's processes keeps no run folder (the helper's exit 4). */
export const NO_HIDEPID = "the box's /proc is not mounted with hidepid=2 (or invisible), so its tools could see the root archil client's processes: use an image or snapshot that mounts it so (see the README); this box keeps no run folder";
/** Why a box whose firewall could not be locked keeps no run folder (the helper's netlock, exit 4). */
export const NO_NETLOCK = "the box could not lock its tools' network: its image needs iptables, ip6tables and root with CAP_NET_ADMIN, and its rules must read back whole (see the README); this box keeps no run folder";
/** What capabilities say of a remote box's network, with how it is held. */
export const TOOLS_NO_NETWORK = "remote boxes on an Archil disk: tools have no network yet";
/** The setting naming Archil's IPv4 ranges: the whole network of a box whose provider holds its egress list itself
 *  (BoxTraits egress `allowlist`). */
export const ARCHIL_ALLOW_ENV = "AGENTRUN_ARCHIL_ALLOW";
/** Why such a box is unavailable with Archil but no ranges for it. */
export const NO_ARCHIL_ALLOW = `this box reaches Archil only through its provider's CIDR allowlist: set ${ARCHIL_ALLOW_ENV} to Archil's IPv4 ranges`;
const CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:3[0-2]|[12]?\d)$/;
/** Archil's IPv4 ranges from `env` (a comma list of CIDRs), undefined when unset, or why the value is not one. */
export function archilAllowOf(env: NodeJS.ProcessEnv): readonly string[] | undefined | { reason: string } {
  const value = env[ARCHIL_ALLOW_ENV]?.trim();
  if (!value) return undefined;
  const cidrs = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const bad = cidrs.find((entry) => !CIDR.test(entry));
  if (bad !== undefined || !cidrs.length) return { reason: `${ARCHIL_ALLOW_ENV} is a comma list of IPv4 ranges, such as 192.0.2.0/24; ${JSON.stringify(bad ?? value)} is not one` };
  return Object.freeze(cidrs);
}
/** What Archil answers a checkin by a client that holds no delegation there: EROFS (30). */
const CHECKED_IN = /'checkin' operation failed .*Unexpected error \(30\)/;
const DISK_ID = /^(?:dsk-[0-9a-f]{16}|[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

/** The disk this server keeps remote runs' folders on: its id, its region, its token, and the shared group. */
export type Archil = { readonly disk: string; readonly region: string; readonly token: string; readonly gid: number };

/** What archilOf reads besides the settings: the mount table (tests give their own), and this process's groups. */
export type ArchilCheck = { mounts?: string; groups?: readonly number[] };

/** The disk `env` names, once the server's own mount of it is at `<data>/disk`; else why remote boxes are unavailable,
 *  saying what to do. */
export async function archilOf(env: NodeJS.ProcessEnv, data: string, check: ArchilCheck = {}): Promise<{ archil: Archil } | { reason: string }> {
  const [disk, region, token] = [ARCHIL_DISK_ENV, ARCHIL_REGION_ENV, ARCHIL_TOKEN_ENV].map((name) => env[name]?.trim() ?? "");
  const missing = [[ARCHIL_DISK_ENV, disk], [ARCHIL_REGION_ENV, region], [ARCHIL_TOKEN_ENV, token]].filter(([, value]) => !value).map(([name]) => name!);
  if (missing.length === 3) return { reason: NO_ARCHIL };
  if (missing.length) return { reason: `${NO_ARCHIL} (${new Intl.ListFormat("en", { type: "conjunction" }).format(missing)} ${missing.length === 1 ? "is" : "are"} not set)` };
  if (!DISK_ID.test(disk!)) return { reason: `${NO_ARCHIL} (${ARCHIL_DISK_ENV} is a disk id, dsk- and 16 hex digits, or owner/name)` };
  if (!REGION.test(region!)) return { reason: `${NO_ARCHIL} (${ARCHIL_REGION_ENV} is a region such as aws-us-east-1)` };
  if (!TOKEN.test(token!)) return { reason: `${NO_ARCHIL} (${ARCHIL_TOKEN_ENV} is not a disk token)` };
  const gidText = env[ARCHIL_GID_ENV]?.trim() || String(DEFAULT_ARCHIL_GID);
  const gid = /^\d{1,9}$/.test(gidText) ? Number(gidText) : Number.NaN;
  if (!Number.isSafeInteger(gid) || gid === 0) return { reason: `${ARCHIL_GID_ENV} is a group id other than 0, such as ${DEFAULT_ARCHIL_GID}` };
  const groups = check.groups ?? [...(process.getgroups?.() ?? []), ...(process.getgid ? [process.getgid()] : [])];
  if (!groups.includes(gid)) return { reason: `this server's user is not in group ${gid}, which a box's tool user shares each run's folder through: add it to that group (or set ${ARCHIL_GID_ENV} to the image's), then restart` };
  const at = join(data, DISK_DIR);
  if (!(await mountedHere(check.mounts ?? "/proc/self/mounts", at, disk!))) return { reason: `${ARCHIL_DISK_ENV} is ${disk}, but the disk is not mounted at ${at}: mount it there with --conditional (see the README), then restart` };
  return { archil: { disk: disk!, region: region!, token: token!, gid } };
}

/** Whether the mount table `table` lists disk `disk` as an Archil mount at `at`. */
async function mountedHere(table: string, at: string, disk: string): Promise<boolean> {
  const text = await readFile(table, "utf8").catch(() => "");
  const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  return text.split("\n").some((line) => {
    const [source = "", mountpoint = "", type = ""] = line.split(" ").map(unescape);
    return mountpoint === at && type === "fuse.archil" && (source === disk || source.startsWith(`${disk}:`) || source.startsWith(`${disk}[`));
  });
}

/** A mount the helper refused because another client holds the folder: a box gone without letting it go, or another
 *  still alive. */
export class FolderHeld extends Error {}

/** One program in `box`, its stdin `input` when given: its exit code and what it printed (both streams, cut). */
async function ran(box: Box, command: readonly string[], context: Context, input?: string): Promise<{ code: number; said: string }> {
  const started = await box.exec(command, { timeoutMs: 120_000 }, context);
  if (!started.ok) throw new Error(started.error.message);
  const program = started.value;
  let said = "";
  const drain = async (stream: AsyncIterable<Uint8Array>) => {
    for await (const chunk of stream) if (said.length < 2000) said += new TextDecoder().decode(chunk);
  };
  const reading = Promise.all([drain(program.stdout), drain(program.stderr)]);
  if (input !== undefined) {
    await program.stdin.write(new TextEncoder().encode(input));
    await program.stdin.close();
  }
  const [ended] = await Promise.all([program.wait(), reading]);
  if (!ended.ok) throw new Error(ended.error.message);
  return { code: ended.value, said: said.trim() };
}

/** The helper's verbs, run in `box` as its own user through sudo: `mount` or `revoke` run `folder` (below the disk) to
 *  /workspace with the token on fd 0; `sync` and `checkin` act on that mount. */
export async function helper(box: Box, archil: Archil, verb: "netlock" | "mount" | "revoke" | "sync" | "checkin", context: Context, folder?: string): Promise<void> {
  const args = verb === "mount" || verb === "revoke" ? [verb, archil.disk, archil.region, folder!] : verb === "netlock" ? [verb, archil.region] : [verb];
  const answer = verb === "mount" || verb === "revoke" ? await withToken(box, archil.token, args, context) : await ran(box, ["sudo", "-n", HELPER_PATH, ...args], context);
  // A sync or checkin with nothing mounted (exit 3): nothing is held, so nothing is lost.
  if (answer.code === 0 || (answer.code === 3 && (verb === "sync" || verb === "checkin"))) return;
  // A checkin by a client that holds no delegation on the folder (it checked in already, or a revoke forced its hold
  // off): archil exits 1 with its checkin operation's EROFS, measured on client 0.10.1 (it has no exit code of its own
  // for this). It holds nothing, so it has let go.
  if (verb === "checkin" && answer.code === 1 && CHECKED_IN.test(answer.said)) return;
  // The box's /proc lets a user see another's processes (no hidepid=2 or invisible): its tools could see the root
  // archil client's, so it keeps no run folder.
  if (answer.code === 4 && (verb === "mount" || verb === "revoke")) throw new Error(NO_HIDEPID);
  // The box could not lock its tools' network (no CAP_NET_ADMIN, no iptables or ip6tables, a read-back that differs).
  if (answer.code === 4 && verb === "netlock") throw new Error(`${NO_NETLOCK} (${answer.said.replace(/^agentrun-archil: /, "").slice(0, 200)})`);
  if (answer.said.includes(HELD)) throw new FolderHeld(`another client holds the run's folder: ${answer.said.slice(0, 300)}`);
  // sudo's own refusal (a password asked, the command not allowed) or no helper at all: the image lacks it.
  if (answer.code === 127 || answer.code === 126 || /a password is required|not allowed to execute|command not found|No such file/i.test(answer.said)) {
    throw new Error(`the box has no Archil helper its user may run as root at ${HELPER_PATH}: use an image or snapshot that ships it, with the archil client and its sudoers line (see the README)`);
  }
  throw new Error(`archil ${verb} in the box failed (exit ${answer.code}): ${answer.said.slice(0, 300)}`);
}

/** The helper with the token on its fd 0: a real stdin where the box has one, else a file of a new 0700 folder of the
 *  box's own user, opened as fd 0 and removed, folder and all, before the helper starts. */
async function withToken(box: Box, token: string, args: readonly string[], context: Context): Promise<{ code: number; said: string }> {
  if (box.facts().secretsVia === "fd") return ran(box, ["sudo", "-n", HELPER_PATH, ...args], context, `${token}\n`);
  const dir = `/tmp/agentrun-archil.${randomBytes(12).toString("hex")}`;
  // mkdir fails on a name that exists, so the folder is this user's own, new, and 0700 (umask): no other user enters it.
  const made = await ran(box, ["sh", "-c", 'umask 077 && mkdir -- "$1"', "sh", dir], context);
  if (made.code !== 0) throw new Error(`the box could not make a folder for the disk token: ${made.said.slice(0, 300)}`);
  try {
    const sent = await box.upload([{ path: `${dir}/token`, bytes: new TextEncoder().encode(`${token}\n`), mode: 0o600 }], context);
    if (!sent.ok) throw new Error(`the disk token could not be sent to the box: ${sent.error.message}`);
    // fd 3 holds the file; the file and its folder are gone before sudo starts, and the helper reads fd 0.
    return await ran(box, ["sh", "-c", 'exec 3<"$1/token" && rm -f -- "$1/token" && rmdir -- "$1" && shift && exec sudo -n "$0" "$@" <&3 3<&-', HELPER_PATH, dir, ...args], context);
  } finally {
    await ran(box, ["rm", "-rf", "--", dir], context).catch(() => undefined);
  }
}
