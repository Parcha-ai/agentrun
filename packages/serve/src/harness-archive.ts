// An archive harness (Goose), installed by its owner: `agentrun harness install goose` (cli.ts install-harness), never on
// a first use and never on a run's path. The release is the one its pin names (the ACP registry's archive for this
// platform: its URL and sha256, and the sha256 of the binary it unpacks to), and it lands whole or not at all, as a
// first-use install does (harness-install.ts):
//   - the archive is downloaded with node's fetch into a fresh folder beside `<data>/harnesses/<harness>`, its sha256
//     taken as it arrives, and refused unless it is the pin's before anything reads it;
//   - the verified archive is unpacked there by the system's tar (`tar -xjf`, a fixed argument list, no shell, an
//     environment of PATH alone): node has no bzip2 of its own, and the repository carries none;
//   - the binary's sha256 is checked there against the pin, and only then is the folder renamed into place and made
//     read-only. What was there before goes aside first, then away;
//   - a crash part way leaves that fresh folder (its name the sweep's) and never a half install: the next install removes it.
// One install at a time on a data directory, under the hold first-use installs take (takeHold). The installer is handed no
// key of the server's: fetch carries no header of ours, and tar's environment is PATH alone.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { leftoverPrefix, releaseHold, removeLeftover, sweepLeftovers, takeHold, writable } from "./harness-install.js";

/** The codes an archive install's failures carry (ArchiveInstallFailed). */
export const ARCHIVE_CODES = Object.freeze({
  /** The pin has no archive for this platform, or no binary digest to check what it unpacks to. */
  platform: "HARNESS_PLATFORM_UNSUPPORTED",
  /** The archive could not be downloaded: the network, a status other than 200, a size past the limit. */
  download: "HARNESS_DOWNLOAD_FAILED",
  /** The archive downloaded is not the pin's: its sha256 differs. */
  archive: "HARNESS_ARCHIVE_MISMATCH",
  /** tar could not unpack the verified archive, or it holds no binary at the pin's path. */
  unpack: "HARNESS_UNPACK_FAILED",
  /** The binary the archive unpacked to is not the pin's: its sha256 differs. */
  binary: "HARNESS_BINARY_MISMATCH",
  /** Another install into the same data directory is running. */
  busy: "HARNESS_INSTALL_BUSY",
} as const);
export type ArchiveCode = (typeof ARCHIVE_CODES)[keyof typeof ARCHIVE_CODES];

/** One platform's release, as a pin holds it (the ACP registry's: acp's AcpArchivePin). */
export type ArchiveRelease = { readonly url: string; readonly format: string; readonly sha256: string; readonly cmd: string; readonly binarySha256?: string };
/** A harness installed from an archive: its id and name, its pin, and the command that installs it (said on every failure). */
export type ArchiveHarness = { readonly id: string; readonly label: string; readonly retry: string; readonly pin: { readonly version: string; readonly archives: Readonly<Partial<Record<string, ArchiveRelease>>> } };

/** A failed install, by its code (ARCHIVE_CODES): its message says why, and the command that tries again. */
export class ArchiveInstallFailed extends Error {
  constructor(readonly code: ArchiveCode, why: string, retry: string) {
    super(`${code}: ${why}. Try again with: ${retry}`);
    this.name = "ArchiveInstallFailed";
  }
}

/** The largest archive an install takes: Goose's is about 60 MB. */
export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
/** The most the download, and then tar, may each take. */
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/** This host's platform as the ACP registry names it (`linux-x86_64`), or undefined for one it does not list. */
export function archivePlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return os && cpu ? `${os}-${cpu}` : undefined;
}

/** The sha256 of the file at `path`, read a chunk at a time. */
async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The binary's path under `root`, from the pin's `cmd` (`./goose`): refused when it would leave `root`. */
function binaryUnder(root: string, cmd: string): string | undefined {
  const path = resolve(root, cmd);
  const inside = relative(root, path);
  return inside && inside !== ".." && !inside.startsWith(`..${sep}`) ? path : undefined;
}

export interface ArchiveInstallOptions {
  /** The platform, as the registry names it. Default this host's (archivePlatform). */
  platform?: string;
  /** For tests: the fetch the archive is downloaded with. */
  fetch?: typeof fetch;
  /** The tar that unpacks it. Default `tar` on PATH. */
  tar?: string;
  /** The environment tar's PATH is read from. Default process.env. Nothing else of it reaches tar. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  /** Hears each step once it holds: `downloaded` (and its digest checked), `unpacked`, `verified` (the binary's digest). */
  onStep?: (step: "downloaded" | "unpacked" | "verified") => void | Promise<void>;
  /** For a release whose binary has no sha256 pinned (a recipe's, where the registry lists only the archive's): the record
   *  of the first one unpacked from its verified archive. With none recorded, this install records its binary's; with one,
   *  a binary that differs is refused (HARNESS_BINARY_MISMATCH). Without it, such a release is refused. */
  binaryRecord?: { read(): string | undefined; write(sha256: string): void };
}

/** Installs `harness` into `dir` (`<data>/harnesses/<id>`) from its pin's archive for this platform: downloaded, checked,
 *  unpacked beside `dir`, its binary checked, then renamed into place and made read-only. `already` when the pinned binary
 *  is in place (nothing is downloaded); `now` once this install put it there. Rejects with ArchiveInstallFailed, `dir` as it
 *  was. */
export async function installArchive(harness: ArchiveHarness, dir: string, options: ArchiveInstallOptions = {}): Promise<{ installed: "already" | "now"; binary: string }> {
  const fail = (code: ArchiveCode, why: string) => new ArchiveInstallFailed(code, why, harness.retry);
  const named = `${harness.label} ${harness.pin.version}`;
  const platform = options.platform ?? archivePlatform();
  const release = platform ? harness.pin.archives[platform] : undefined;
  if (!platform || !release) throw fail(ARCHIVE_CODES.platform, `${named} has no release pinned for ${platform ?? `${process.platform}-${process.arch}`}`);
  if (!release.binarySha256 && !options.binaryRecord) throw fail(ARCHIVE_CODES.platform, `${named}'s binary on ${platform} has no sha256 pinned, so what its archive unpacks to cannot be checked`);
  if (release.format !== "tar.bz2") throw fail(ARCHIVE_CODES.platform, `${named}'s archive on ${platform} is ${release.format}, and this installer unpacks tar.bz2 alone`);
  const binary = binaryUnder(dir, release.cmd);
  if (!binary) throw fail(ARCHIVE_CODES.platform, `${named}'s pinned path ${release.cmd} is not inside its folder`);
  // The pin's digest, else the first one recorded (none before the first install).
  const pinned = release.binarySha256 ?? options.binaryRecord?.read();
  /** Whether the pinned binary is in place: a file whose sha256 is the pin's. */
  const inPlace = async (): Promise<boolean> => pinned !== undefined && (await lstat(binary).catch(() => undefined)) !== undefined && (await digestOf(binary).catch(() => undefined)) === pinned;
  if (await inPlace()) return { installed: "already", binary };

  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const token = await takeHold(dir);
  if (!token) throw fail(ARCHIVE_CODES.busy, `another install into ${parent} is running; wait for it to end`);
  let work: string | undefined;
  try {
    // Installed by another while this one waited for the hold: nothing to do.
    if (await inPlace()) return { installed: "already", binary };
    // What an earlier install left part way (a crash between the unpack and the rename): never read, removed now.
    await sweepLeftovers(dir);
    work = await mkdtemp(join(parent, leftoverPrefix(dir)));
    const archive = join(work, "archive.tar.bz2");
    const timeoutMs = options.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? ARCHIVE_MAX_BYTES;

    // The download, hashed as it is written; refused past its limit.
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      const response = await (options.fetch ?? fetch)(release.url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${release.url} answered ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBytes) throw new Error(`${release.url} is ${length} bytes, past the ${maxBytes} an archive may be`);
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > maxBytes) return done(new Error(`${release.url} ran past the ${maxBytes} bytes an archive may be`));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counted, createWriteStream(archive, { mode: 0o600 }));
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw fail(ARCHIVE_CODES.download, `${named}'s archive could not be downloaded from ${release.url}: ${(error as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ""}`);
    }
    const got = hash.digest("hex");
    if (got !== release.sha256) throw fail(ARCHIVE_CODES.archive, `${named}'s archive from ${release.url} has sha256 ${got}, and the pin is ${release.sha256}; it was not unpacked`);
    await options.onStep?.("downloaded");

    // Unpacked by tar, verified archive only, into a folder of its own inside the fresh one.
    const tree = join(work, "tree");
    await mkdir(tree);
    const PATH = (options.env ?? process.env).PATH ?? "/usr/bin:/bin";
    await new Promise<void>((done, reject) => {
      execFile(options.tar ?? "tar", ["-xjf", archive, "-C", tree, "--no-same-owner", "--no-same-permissions"], { env: { PATH, LC_ALL: "C" }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(fail(ARCHIVE_CODES.unpack, `tar could not unpack ${named}'s archive: ${String(stderr).trim() || error.message}`));
        else done();
      });
    });
    await options.onStep?.("unpacked");

    // The binary, a regular file at the pin's path, checked before anything puts it in place.
    const unpacked = binaryUnder(tree, release.cmd)!;
    const found = await lstat(unpacked).catch(() => undefined);
    if (!found?.isFile()) throw fail(ARCHIVE_CODES.unpack, `${named}'s archive holds no file at ${release.cmd}`);
    const binarySha = await digestOf(unpacked);
    if (pinned === undefined) {
      // The first binary unpacked from the verified archive: recorded, so a later one that differs is refused. A record
      // another install wrote first holds.
      try {
        options.binaryRecord!.write(binarySha);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        const first = options.binaryRecord!.read();
        if (first !== binarySha) throw fail(ARCHIVE_CODES.binary, `${named}'s binary from its archive has sha256 ${binarySha}, and the first one recorded is ${first}; it was not put in place`);
      }
    } else if (binarySha !== pinned) throw fail(ARCHIVE_CODES.binary, `${named}'s binary from its archive has sha256 ${binarySha}, and the ${release.binarySha256 ? "pin" : "first one recorded"} is ${pinned}; it was not put in place`);
    await options.onStep?.("verified");

    // Into place whole: what was there (a binary that is not the pin's, a folder by hand) goes aside first, then away.
    const old = existsSync(dir) ? `${work}-old` : undefined;
    if (old) await rename(dir, old);
    await rename(tree, dir);
    // Read-only once in place; the binary is checked against the pin again before each run (gooseAdapter).
    await writable(dir, false);
    if (old) await removeLeftover(old);
    return { installed: "now", binary };
  } finally {
    // The fresh folder (the archive, and the tree when it never went into place) goes either way.
    if (work) await removeLeftover(work);
    await releaseHold(dir, token).catch(() => undefined);
  }
}
