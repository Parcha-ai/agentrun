// An ACP agent's binary, checked against what the adapter was tested with, before it is ever started. Written for
// AgentRun.
//  - A pin is a release as the public ACP registry lists it (https://cdn.agentclientprotocol.com/registry/v1/latest/
//    registry.json): its version and, per platform, its archive's URL and sha256, and the sha256 of the binary the archive
//    unpacks to where it was measured. An installer verifies the archive, then the binary; a host checks the binary
//    again at each start (`verifyPinnedBinary`).
//  - An agent the registry lists with no digest (Cursor) has no pin to meet: its first verified digest is recorded, and a
//    later binary that differs from it is refused (`verifyFirstSeen`), so a binary that changed under the host is seen
//    before it runs.
// Every check reads the file's bytes (the kernel's chunked sha256, kept once per file identity) and never executes it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
   *  installer records the first one it unpacks from the verified archive (`verifyFirstSeen`). */
  readonly binarySha256?: string;
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

/** This host's platform as the registry names it, or undefined for one it does not list. */
export function acpPlatform(platform: string = process.platform, arch: string = process.arch): AcpPlatform | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return os && cpu ? (`${os}-${cpu}` as AcpPlatform) : undefined;
}

/** A binary the adapter will not start: its code says why (ACP_CODES.binaryMismatch, binaryDrift, binaryUnreadable). */
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

/** Where an agent with no registry digest keeps the first digest verified for it. */
export interface DigestRecord {
  /** The digest recorded, or undefined before the first. */
  read(): string | undefined;
  /** Records the first digest. */
  write(sha256: string): void;
}

/** A DigestRecord in a file of its own: one line, the sha256. */
export function fileDigestRecord(file: string): DigestRecord {
  return {
    read() {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
      const recorded = text.trim();
      if (!SHA256.test(recorded)) throw new Error(`acp: the recorded digest in ${file} is not a sha256`);
      return recorded;
    },
    write(sha256) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // `wx`: a record another process wrote first is never overwritten; its digest is the one that holds.
      writeFileSync(file, `${sha256}\n`, { mode: 0o600, flag: "wx" });
    },
  };
}

/** The binary at `path`, against the first digest `record` holds: with none, its digest is recorded and it passes; with
 *  one, a binary that differs is refused (ACP_CODES.binaryDrift). Answers its digest. */
export function verifyFirstSeen(path: string, record: DigestRecord): string {
  const recorded = record.read();
  if (recorded) {
    try {
      verifyPinnedBinary(path, recorded);
    } catch (error) {
      if (error instanceof AcpBinaryRefused && error.code === ACP_CODES.binaryMismatch) throw new AcpBinaryRefused(ACP_CODES.binaryDrift, `the binary at ${path} differs from the first one recorded for it (${recorded})`);
      throw error;
    }
    return recorded;
  }
  let found: string;
  try {
    found = checkedOnce(path, "first-seen", digestOf(path), () => false);
  } catch (error) {
    throw unreadable(path, error);
  }
  try {
    record.write(found);
  } catch (error) {
    // Another process recorded one first: that one holds.
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    const first = record.read();
    if (first !== found) throw new AcpBinaryRefused(ACP_CODES.binaryDrift, `the binary at ${path} has sha256 ${found}, and the first one recorded is ${first}`);
  }
  return found;
}
