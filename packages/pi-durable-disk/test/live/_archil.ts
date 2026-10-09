// Live-test helpers: mint short-lived mount tokens, mount and unmount scratch subdirectories, clean up.
// Only the scratch disk named by $PDA_LIVE_DISK is touched. No token is ever printed: it travels only on the wrapper's
// stdin and is scrubbed from captured output.
//   PDA_LIVE=1                 run the live suites (without it they skip)
//   ARCHIL_API_KEY             an Archil API key for the account that owns the scratch disk
//   PDA_LIVE_DISK              the scratch disk's id (dsk-...)
//   PDA_LIVE_REGION            its region (default aws-us-east-1)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { configure, getDisk } from "disk";
import { ARCHIL_SCOPED } from "../../src/claim.ts";

/** The variable that holds the API key. */
export const KEY_ENV = "ARCHIL_API_KEY";
export const LIVE = process.env.PDA_LIVE === "1" && Boolean(process.env[KEY_ENV]);
export const REGION = process.env.PDA_LIVE_REGION ?? "aws-us-east-1";
const ARCHIL = "/usr/bin/archil";

// A live run without a disk would otherwise skip every test and look green.
if (LIVE && !process.env.PDA_LIVE_DISK) throw new Error("PDA_LIVE=1 needs PDA_LIVE_DISK: the id (dsk-...) of the scratch disk the suites may use");

export function scratchDiskId(): string {
  const id = process.env.PDA_LIVE_DISK;
  if (!id) throw new Error("PDA_LIVE_DISK names the scratch disk (dsk-...)");
  return id;
}

export async function scratchDisk() {
  configure({ apiKey: process.env[KEY_ENV]!, region: REGION });
  return getDisk(scratchDiskId());
}

/** A mount token valid for two hours; the caller removes the token user when done. */
export async function mintToken(purpose: string): Promise<{ token: string; identifier: string }> {
  const disk = await scratchDisk();
  const nickname = `pda-${purpose}-${Date.now().toString(36)}`.slice(0, 60);
  const user = await disk.addUser({ type: "token", nickname, ttl: "2h" });
  if (!user.identifier || !user.token) throw new Error("addUser returned no identifier or token");
  return { token: user.token, identifier: user.identifier };
}

export async function removeToken(identifier: string): Promise<void> {
  const disk = await scratchDisk();
  await disk.removeUser("token", identifier);
}

function scrub(text: string | null | undefined, secret: string): string {
  return (text ?? "").split(secret).join("<token>");
}

const cleanEnv = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: process.env.HOME ?? "/",
  LANG: "C.UTF-8",
  ...extra,
});

/**
 * `sudo archil-scoped mount <disk>:<subpath> <mountpoint>` with explicit flags (pass the exclusive mode explicitly). The
 * token goes to the wrapper on stdin, never in an environment sudo would log.
 */
export function mount(opts: { subpath: string; mountpoint: string; token: string; flags: string[]; timeoutMs?: number }) {
  spawnSync("sudo", ["mkdir", "-p", opts.mountpoint]);
  spawnSync("sudo", ["chown", `${process.getuid!()}:${process.getgid!()}`, opts.mountpoint]);
  const target = `${scratchDiskId()}:${opts.subpath}`;
  const r = spawnSync("sudo", ["-n", ARCHIL_SCOPED, "mount", ...opts.flags, target, opts.mountpoint, "--region", REGION], {
    env: cleanEnv(),
    input: `${opts.token}\n`,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { status: r.status, stdout: scrub(r.stdout, opts.token), stderr: scrub(r.stderr, opts.token) };
}

/** True while `mountpoint` is in the kernel's mount table. Exit codes of unmount tools are not evidence. */
export function isMounted(mountpoint: string): boolean {
  return readFileSync("/proc/mounts", "utf8").split("\n").some((line) => line.split(" ")[1] === mountpoint);
}

/**
 * `archil unmount` (flushes and checks the delegation in); a dead mount falls back to `fusermount -u`. `status` is 0
 * only when the mount table no longer lists the mountpoint: a busy or dead mount can make either tool report success
 * and stay mounted.
 */
export function unmount(mountpoint: string) {
  const r = spawnSync("sudo", [ARCHIL, "unmount", mountpoint], { env: cleanEnv(), encoding: "utf8", timeout: 180_000 });
  if (!isMounted(mountpoint)) return { status: 0, via: "archil" as const };
  const f = spawnSync("sudo", ["fusermount", "-u", mountpoint], { encoding: "utf8" });
  if (!isMounted(mountpoint)) return { status: 0, via: "fusermount" as const };
  return { status: 1, via: "none" as const, stderr: `still mounted after archil unmount and fusermount -u\n${r.stderr}\n${f.stderr}` };
}
