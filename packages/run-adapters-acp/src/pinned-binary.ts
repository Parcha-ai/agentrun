// An ACP agent's binary, checked against what the adapter was tested with, before it is ever started. Written for
// AgentRun.
//  - A pin is a release as the public ACP registry lists it (https://cdn.agentclientprotocol.com/registry/v1/latest/
//    registry.json): its version and, per platform, its archive's URL and sha256, and the sha256 of the binary the archive
//    unpacks to where it was measured. An installer verifies the archive, then the binary; a host checks the binary
//    again at each start (`verifyPinnedBinary`).
//  - An agent the registry lists with no digest (Cursor) is pinned here by what its first download held; a binary no
//    pin names has its first digest recorded by the server's installer alone (agentrun-serve, harness-archive.ts
//    installArchive's binaryRecord), the one first-seen path.
// Every check reads the file's bytes (the kernel's chunked sha256, kept once per file identity) and never executes it.
import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { checkedOnce, checkedOnceAsync, type BinaryCheck } from "@parcha/agentrun-kernel/host";
import { ACP_CODES } from "./facts.js";

/** A platform as the ACP registry names it (`distribution.binary.<platform>`). */
export type AcpPlatform = "darwin-aarch64" | "darwin-x86_64" | "linux-aarch64" | "linux-x86_64" | "windows-aarch64" | "windows-x86_64";

/** One platform's release of a pinned agent. */
export interface AcpArchivePin {
  /** The archive's URL, as the registry lists it. */
  readonly url: string;
  /** How it is packed. */
  readonly format: "tar.bz2" | "tar.gz" | "zip";
  /** The archive's sha256, as the registry lists it. */
  readonly sha256: string;
  /** The binary's path inside the archive (the registry's `cmd`). */
  readonly cmd: string;
  /** The sha256 of the binary the archive unpacks to, where it was measured. Absent: unmeasured on this platform, so an
   *  installer records the first one it unpacks from the verified archive (agentrun-serve's binaryRecord). */
  readonly binarySha256?: string;
  /** The digest of every file the archive unpacks to (treeDigest), for an agent whose binary is a launcher of the code
   *  beside it (Cursor's `cursor-agent` runs its own `node` on `index.js` and a hundred chunks): checked by the installer
   *  and again before every start, so no file of it changes unseen. */
  readonly treeSha256?: string;
}

/** A pinned release of an ACP agent. */
export interface AcpBinaryPin {
  /** The agent's id in the registry. */
  readonly id: string;
  readonly version: string;
  /** Where its digests were read, and when (ISO 8601). */
  readonly source: { readonly url: string; readonly readAt: string };
  readonly archives: Readonly<Partial<Record<AcpPlatform, AcpArchivePin>>>;
}

/** Goose 1.59.2, as the registry listed it when read (`source`). The linux-x86_64 binary's digest was measured on the
 *  binary its verified archive unpacked to; the darwin-aarch64 archive is pinned by the registry's digest alone. */
export const GOOSE_PIN: AcpBinaryPin = Object.freeze({
  id: "goose",
  version: "1.59.2",
  source: Object.freeze({ url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json", readAt: "2026-11-17T22:28:02Z" }),
  archives: Object.freeze({
    "linux-x86_64": Object.freeze({
      url: "https://github.com/block/goose/releases/download/v1.59.2/goose-x86_64-unknown-linux-gnu.tar.bz2",
      format: "tar.bz2" as const,
      sha256: "36efe207ae4f8de3030ed8fdcfe3b7c5d13f23d6cb73d6fde747543f022ce218",
      cmd: "./goose",
      binarySha256: "b90833d7f1e8f9aa36e163a8f3d27fdd69d462ac9b4a68105a091e1a2da56993",
    }),
    "darwin-aarch64": Object.freeze({
      url: "https://github.com/block/goose/releases/download/v1.59.2/goose-aarch64-apple-darwin.tar.bz2",
      format: "tar.bz2" as const,
      sha256: "a4eac98999639741ee5a4cc7a3043952a4a22fc2004b7340e34ec927df0e8257",
      cmd: "./goose",
    }),
  }),
});

/** Cursor's CLI 2026.11.13 (build eacade1), the release its ACP registry entry pointed to when read (`source`). The
 *  registry lists no digest for Cursor, so the archive is pinned by the first sha256 seen for it (2026-11-16, harness S0;
 *  downloaded again 2026-11-19 and the same), its launcher and its whole tree by what that archive unpacked to. A drift
 *  of any of them is refused. A new pin takes the key walk on it (test/cursor-key-walk.test.mjs, on the real binary and
 *  the owner's key, AGENTRUN_RECORD_CURSOR_WALK=1): Cursor's credential design rests on Cursor tolerating a failed save,
 *  and CI refuses a pin cursor-walk.json does not name. */
export const CURSOR_PIN: AcpBinaryPin = Object.freeze({
  id: "cursor",
  version: "2026.11.13-eacade1",
  source: Object.freeze({ url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json", readAt: "2026-11-16T21:22:32Z" }),
  archives: Object.freeze({
    "linux-x86_64": Object.freeze({
      url: "https://downloads.cursor.com/lab/2026.11.13-eacade1/linux/x64/agent-cli-package.tar.gz",
      format: "tar.gz" as const,
      sha256: "c02e4321f20d691ee03af94d29948dc3a81c6c34e7328da7bb1afade4c75812f",
      cmd: "./dist-package/cursor-agent",
      binarySha256: "2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233",
      treeSha256: "b224cfc7d2aa702ae4c9335fba6a4fc4b04250584bf615a8dcefa946ac5e64f6",
    }),
  }),
});

/** This host's platform as the registry names it, or undefined for one it does not list. */
export function acpPlatform(platform: string = process.platform, arch: string = process.arch): AcpPlatform | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return os && cpu ? (`${os}-${cpu}` as AcpPlatform) : undefined;
}

/** A binary the adapter will not start: its code says why (ACP_CODES.binaryMismatch, binaryUnreadable). */
export class AcpBinaryRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AcpBinaryRefused";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
/** The check's one step: the file's sha256. */
const digestOf = (path: string): BinaryCheck<string> =>
  function* () {
    return yield { kind: "sha256", path };
  };

/** Why reading `path` failed, as a refusal. */
const unreadable = (path: string, error: unknown) => new AcpBinaryRefused(ACP_CODES.binaryUnreadable, `the binary at ${path} cannot be read (${String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error)})`);

/** Refuses the binary at `path` unless its sha256 is `sha256`. Reads it (once per file identity in this process),
 *  never runs it. */
export function verifyPinnedBinary(path: string, sha256: string): void {
  if (!SHA256.test(sha256)) throw new Error(`acp: the pinned sha256 ${JSON.stringify(sha256)} is not 64 lowercase hex digits`);
  let found: string;
  try {
    found = checkedOnce(path, sha256, digestOf(path), (d) => d === sha256);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (found !== sha256) throw new AcpBinaryRefused(ACP_CODES.binaryMismatch, `the binary at ${path} has sha256 ${found}, and the pin is ${sha256}`);
}

/** verifyPinnedBinary without holding the event loop: the host's own check, while it goes on answering. */
export async function verifyPinnedBinaryAsync(path: string, sha256: string): Promise<void> {
  if (!SHA256.test(sha256)) throw new Error(`acp: the pinned sha256 ${JSON.stringify(sha256)} is not 64 lowercase hex digits`);
  let found: string;
  try {
    found = await checkedOnceAsync(path, sha256, digestOf(path), (d) => d === sha256);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (found !== sha256) throw new AcpBinaryRefused(ACP_CODES.binaryMismatch, `the binary at ${path} has sha256 ${found}, and the pin is ${sha256}`);
}

/** The digest of the tree at `root`: the sha256 of one line per entry under it, in byte order of its path from `root`
 *  (`/`-separated): `<path>\0file\0<sha256>\n` for a file, `<path>\0link\0<target>\n` for a symbolic link, and
 *  `<path>\0dir\n` for a directory. Modes and times are not in it. Each file's sha256 is the kernel's, kept once per
 *  file identity in this process, so a tree checked before is read again only where a file changed. Off the event loop;
 *  rejects on anything else under `root` (a socket, a device). */
export async function treeDigest(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) lines.push(`${rel}\0link\0${await readlink(path)}\n`);
      else if (entry.isDirectory()) {
        lines.push(`${rel}\0dir\n`);
        await walk(path, rel);
      } else if (entry.isFile()) lines.push(`${rel}\0file\0${await checkedOnceAsync(path, "tree", digestOf(path), () => true)}\n`);
      else throw new Error(`${path} is neither a file, a directory nor a link`);
    }
  };
  await walk(root, "");
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/** Refuses the tree at `root` unless its digest (treeDigest) is `sha256`: ACP_CODES.binaryMismatch, or binaryUnreadable
 *  when it cannot be read. Never runs anything in it. */
export async function verifyPinnedTree(root: string, sha256: string): Promise<void> {
  if (!SHA256.test(sha256)) throw new Error(`acp: the pinned tree sha256 ${JSON.stringify(sha256)} is not 64 lowercase hex digits`);
  let found: string;
  try {
    found = await treeDigest(root);
  } catch (error) {
    throw new AcpBinaryRefused(ACP_CODES.binaryUnreadable, `the files at ${root} cannot be read (${String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error)})`);
  }
  if (found !== sha256) throw new AcpBinaryRefused(ACP_CODES.binaryMismatch, `the files at ${root} have the tree sha256 ${found}, and the pin is ${sha256}: one of them changed since it was installed`);
}
