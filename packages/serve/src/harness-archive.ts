// An archive harness (Goose), installed by its owner: `agentrun harness install goose` (cli.ts install-harness), never on
// a first use and never on a run's path. The release is the one its pin names (the ACP registry's archive for this
// platform: its URL and sha256, and the sha256 of the binary it unpacks to), and it lands whole or not at all, as a
// first-use install does (harness-install.ts):
//   - the archive is downloaded with node's fetch into a fresh folder beside `<data>/harnesses/<harness>`, its sha256
//     (or the sha512 a release is pinned by, as Google's agy CLI manifest lists it) taken as it arrives, and refused
//     unless it is the pin's before anything reads it;
//   - the verified archive is unpacked there by the system's tar (`tar -xjf` for Goose's tar.bz2, `-xzf` for Cursor's
//     tar.gz; a fixed argument list, no shell, an environment of PATH alone): node has no bzip2 of its own, and the
//     repository carries none. A zip (Google Antigravity's) is unpacked by node itself (harness-zip.ts), no tool needed;
//   - the binary's sha256 is checked there against the pin, and where the pin holds one the digest of every file beside
//     it (Cursor's launcher runs its own node on a hundred files of code; Antigravity's server runs a sidecar), and only
//     then is the folder renamed into place and made read-only. A recipe's release pins neither: the first binary and
//     tree unpacked from its verified archive are recorded, and a later install that differs is refused. What was there
//     before goes aside first, then away;
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
import { unzipInto } from "./harness-zip.js";

/** The codes an archive install's failures carry (ArchiveInstallFailed). */
export const ARCHIVE_CODES = Object.freeze({
  /** The pin has no archive for this platform, or no binary digest to check what it unpacks to. */
  platform: "HARNESS_PLATFORM_UNSUPPORTED",
  /** The archive could not be downloaded: the network, a status other than 200, a size past the limit. */
  download: "HARNESS_DOWNLOAD_FAILED",
  /** The archive downloaded is not the pin's: its sha256 (or sha512) differs. */
  archive: "HARNESS_ARCHIVE_MISMATCH",
  /** tar could not unpack the verified archive, or it holds no binary at the pin's path. */
  unpack: "HARNESS_UNPACK_FAILED",
  /** The binary the archive unpacked to is not the pin's: its sha256 differs. */
  binary: "HARNESS_BINARY_MISMATCH",
  /** Another install into the same data directory is running. */
  busy: "HARNESS_INSTALL_BUSY",
} as const);
export type ArchiveCode = (typeof ARCHIVE_CODES)[keyof typeof ARCHIVE_CODES];

/** One platform's release, as a pin holds it (the ACP registry's: acp's AcpArchivePin). The archive is pinned by one
 *  digest: its `sha256`, else its `sha512` (Google's agy CLI manifest lists that one alone); a recipe's loader takes
 *  exactly one. `treeSha256`: the digest of every file it unpacks to (acp's treeDigest), for a binary that is a launcher
 *  of the code beside it (Cursor's). */
export type ArchiveRelease = { readonly url: string; readonly format: string; readonly sha256?: string; readonly sha512?: string; readonly cmd: string; readonly binarySha256?: string; readonly treeSha256?: string };
/** A harness installed from an archive: its id and name, its pin, and the command that installs it (said on every failure).
 *  `tree`: how a tree's digest is taken (acp's treeDigest), needed where a release pins one. */
export type ArchiveHarness = { readonly id: string; readonly label: string; readonly retry: string; readonly pin: { readonly version: string; readonly archives: Readonly<Partial<Record<string, ArchiveRelease>>> }; readonly tree?: (root: string) => Promise<string> };

/** How each format this installer takes is unpacked: tar's flag (node has neither bzip2 nor a tar of its own), or node's
 *  own zip reader. */
const UNPACK: Readonly<Record<ArchiveFormat, string>> = Object.freeze({ "tar.bz2": "-xjf", "tar.gz": "-xzf", zip: "node" });
/** An archive format this installer unpacks. */
export type ArchiveFormat = "tar.bz2" | "tar.gz" | "zip";
/** The formats this installer unpacks, the one list a recipe's loader checks a release against (harness-recipe.ts). */
export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = Object.freeze(Object.keys(UNPACK) as ArchiveFormat[]);

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
export async function digestOf(path: string): Promise<string> {
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
  /** For a release with no tree digest pinned (a recipe's): the record of the first tree (every file beside the binary,
   *  harness.tree's digest) unpacked from its verified archive, kept as binaryRecord keeps the binary's, so a sidecar
   *  that differs is refused (HARNESS_BINARY_MISMATCH) as the binary is. Needs harness.tree. */
  treeRecord?: { read(): string | undefined; write(sha256: string): void };
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
  // The archive's one digest, by the algorithm its pin names: sha256, else sha512.
  const algorithm = release.sha256 !== undefined ? "sha256" : "sha512";
  const want = release.sha256 ?? release.sha512;
  if (!want) throw fail(ARCHIVE_CODES.platform, `${named}'s archive on ${platform} has no sha256 or sha512 pinned, so it cannot be checked`);
  if (!release.binarySha256 && !options.binaryRecord) throw fail(ARCHIVE_CODES.platform, `${named}'s binary on ${platform} has no sha256 pinned, so what its archive unpacks to cannot be checked`);
  const flag = (UNPACK as Readonly<Record<string, string>>)[release.format];
  if (!flag || !Object.hasOwn(UNPACK, release.format)) throw fail(ARCHIVE_CODES.platform, `${named}'s archive on ${platform} is ${release.format}, and this installer unpacks ${ARCHIVE_FORMATS.slice(0, -1).join(", ")} and ${ARCHIVE_FORMATS.at(-1)} alone`);
  const treeRecord = release.treeSha256 ? undefined : options.treeRecord;
  if ((release.treeSha256 || treeRecord) && !harness.tree) throw fail(ARCHIVE_CODES.platform, `${named}'s files on ${platform} are ${release.treeSha256 ? "pinned" : "recorded"} by a tree digest, and this install was given no way to take one`);
  const binary = binaryUnder(dir, release.cmd);
  if (!binary) throw fail(ARCHIVE_CODES.platform, `${named}'s pinned path ${release.cmd} is not inside its folder`);
  // The pin's digests, else the first ones recorded (none before the first install).
  const pinned = release.binarySha256 ?? options.binaryRecord?.read();
  const pinnedTree = release.treeSha256 ?? treeRecord?.read();
  /** Whether the pinned binary is in place: a file whose sha256 is the pin's, in a folder whose tree is the pin's (or the
   *  one recorded) where it pins or records one. A recipe's install from before trees were recorded is not: it is
   *  installed again, and its tree recorded. */
  const inPlace = async (): Promise<boolean> =>
    pinned !== undefined &&
    (!treeRecord || pinnedTree !== undefined) &&
    (await lstat(binary).catch(() => undefined)) !== undefined &&
    (await digestOf(binary).catch(() => undefined)) === pinned &&
    (pinnedTree === undefined || (await harness.tree!(dir).catch(() => undefined)) === pinnedTree);
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
    const archive = join(work, `archive.${release.format}`);
    const timeoutMs = options.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? ARCHIVE_MAX_BYTES;

    // The download, hashed as it is written by its pin's algorithm; refused past its limit.
    const hash = createHash(algorithm);
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
    if (got !== want) throw fail(ARCHIVE_CODES.archive, `${named}'s archive from ${release.url} has ${algorithm} ${got}, and the pin is ${want}; it was not unpacked`);
    await options.onStep?.("downloaded");

    // Unpacked, verified archive only, into a folder of its own inside the fresh one: a zip by node, a tarball by tar.
    const tree = join(work, "tree");
    await mkdir(tree);
    if (release.format === "zip") {
      try {
        await unzipInto(archive, tree);
      } catch (error) {
        throw fail(ARCHIVE_CODES.unpack, `${named}'s zip was not unpacked: ${(error as Error).message}`);
      }
    } else {
      const PATH = (options.env ?? process.env).PATH ?? "/usr/bin:/bin";
      await new Promise<void>((done, reject) => {
        execFile(options.tar ?? "tar", [flag, archive, "-C", tree, "--no-same-owner", "--no-same-permissions"], { env: { PATH, LC_ALL: "C" }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
          if (error) reject(fail(ARCHIVE_CODES.unpack, `tar could not unpack ${named}'s archive: ${String(stderr).trim() || error.message}`));
          else done();
        });
      });
    }
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
    // Every file beside it, where the pin holds their digest or a record keeps the first: a launcher's code, or a server's
    // sidecar, is as much the harness as the binary.
    if (release.treeSha256 || treeRecord) {
      const treeSha = await harness.tree!(tree);
      let first = pinnedTree;
      if (first === undefined) {
        try {
          treeRecord!.write(treeSha);
          first = treeSha;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
          first = treeRecord!.read();
        }
      }
      if (treeSha !== first) throw fail(ARCHIVE_CODES.binary, `${named}'s files from its archive have the tree sha256 ${treeSha}, and the ${release.treeSha256 ? "pin" : "first one recorded"} is ${first}; they were not put in place`);
    }
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
