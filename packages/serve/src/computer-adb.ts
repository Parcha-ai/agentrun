// The phone provider's adb, wherever serve builds that provider (the claim's computerForClaim and Settings → Computers'
// test): one helper both use. The computer library spawns adb from the env it is given, so adb is given a fixed, minimal
// env (PATH, HOME, TMPDIR), never this process's: no vendor key and no seal key reaches adb, as none reaches the host's
// bash (workspace/hands.ts shellEnv).
import { homedir, tmpdir } from "node:os";
import { shellEnv } from "./workspace/hands.js";

/** adb's env: the host bash's PATH, and a HOME and a TMPDIR (paths only). Nothing else, whatever this process holds. */
export function adbEnv(dirs: { readonly home?: string; readonly tmpdir?: string } = {}): Readonly<Record<string, string>> {
  return Object.freeze({ PATH: shellEnv().PATH!, HOME: dirs.home ?? homedir(), TMPDIR: dirs.tmpdir ?? tmpdir() });
}

/** The phone provider's adb: the computer library's adbCli at `path`, spawned from adbEnv() alone. */
export function phoneAdb<A>(adbCli: (path: string, options: { readonly env: Readonly<Record<string, string>> }) => A, path: string, dirs: { readonly home?: string; readonly tmpdir?: string } = {}): A {
  return adbCli(path, { env: adbEnv(dirs) });
}
