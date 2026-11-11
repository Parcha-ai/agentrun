// The installed OpenCode checked against the pins (src/versions.ts) before anything runs, with the typed errors a host
// maps to a run's failure line. Written for AgentRun.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { promisify } from "node:util";
import { checkedOnce, checkedOnceAsync, sha256OfFile, sha256OfFileAsync } from "@parcha/agentrun-kernel/host";
import { findOpenCode, openCodePackages } from "./binary.js";
import { OPENCODE_BINARY_SHA256, OPENCODE_VERSION, OpenCodeNotInstalled, OpenCodePinMismatch } from "./versions.js";

export interface OpenCodePins {
  /** The release `opencode --version` must report. */
  version: string;
  /** The binary's sha256 for each platform package the pins list; a package not listed is unchecked here. */
  sha256: Readonly<Record<string, string>>;
}

/** The pins this package holds. */
export const openCodePins = (): OpenCodePins => ({ version: OPENCODE_VERSION, sha256: OPENCODE_BINARY_SHA256 });

/**
 * The binary at `found.path` checked against `pins`, in order: its platform package's version, the binary's sha256 (its
 * package's pin, or for a binary named by OPENCODE_BIN the pin of any package this machine may run, when the pins list
 * one), then the version it reports. Returns the path, or the typed error (not thrown) naming the
 * pin, what was expected and what was found. No path, or a binary that cannot be read or run, is `OpenCodeNotInstalled`.
 * The path is made absolute first, from this process's working directory: a session starts the binary from its own
 * directory, where a relative `OPENCODE_BIN` names nothing.
 */
export function verifyOpenCodeBinary(found: { path: string; pkg?: string; packageVersion?: string } | undefined, pins: OpenCodePins = openCodePins()): { path: string } | OpenCodePinMismatch | OpenCodeNotInstalled {
  const at = located(found, pins);
  if (!("expected" in at)) return at;
  // Hashed a chunk at a time, and checked once per binary in this process while it stays the same file, unchanged (the
  // kernel's checkedOnce): a host that checks it for each model it resolves, and a run's process that makes its adapter,
  // check it once.
  return checkedOnce(at.path, JSON.stringify({ version: pins.version, expected: at.expected }), () => checkBinary(at.path, pins.version, at.expected), (result) => !(result instanceof Error));
}

/** verifyOpenCodeBinary's answer, with the event loop handed back while the binary is hashed and answers --version, kept
 *  on the same record: a check that passed here makes verifyOpenCodeBinary (the adapter's own) answer at once. */
export async function verifyOpenCodeBinaryAsync(found: { path: string; pkg?: string; packageVersion?: string } | undefined, pins: OpenCodePins = openCodePins()): Promise<{ path: string } | OpenCodePinMismatch | OpenCodeNotInstalled> {
  const at = located(found, pins);
  if (!("expected" in at)) return at;
  return checkedOnceAsync(at.path, JSON.stringify({ version: pins.version, expected: at.expected }), () => checkBinaryAsync(at.path, pins.version, at.expected), (result) => !(result instanceof Error));
}

/** The binary's absolute path and the sha256 values it may have, or why there is none to check. A binary from a platform
 *  package is checked against that package's pin; one named by OPENCODE_BIN (no package) against the pins of every
 *  package this machine may run. */
function located(found: { path: string; pkg?: string; packageVersion?: string } | undefined, pins: OpenCodePins): { path: string; expected: string[] } | OpenCodePinMismatch | OpenCodeNotInstalled {
  if (!found) return new OpenCodeNotInstalled("no OpenCode binary found for this platform, and OPENCODE_BIN is not set");
  const path = resolve(found.path);
  if (!existsSync(path)) return new OpenCodeNotInstalled(`no file at ${path}`);
  if (found.packageVersion !== undefined && found.packageVersion !== pins.version) return new OpenCodePinMismatch("package_version", pins.version, found.packageVersion, path);
  return { path, expected: (found.pkg ? [found.pkg] : openCodePackages()).map((pkg) => pins.sha256[pkg]).filter((sha): sha is string => typeof sha === "string") };
}

/** How the binary is asked its version, in `home`: a private home, so `--version` reads no config and writes no state of
 *  the host's; no environment but PATH; 20 s at most. */
const versionRun = (home: string) => ({
  env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_AUTOUPDATE: "1" },
  cwd: home, encoding: "utf8" as const, timeout: 20_000,
});
const unreadable = (path: string, error: unknown) => new OpenCodeNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
const unrunnable = (path: string, error: unknown) => new OpenCodeNotInstalled(`${path} could not be run: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
/** What `--version` reported, against the version it must report. */
const versionVerdict = (path: string, version: string, reported: string): { path: string } | OpenCodePinMismatch => {
  const said = /^(\d+\.\d+\.\d+\S*)$/.exec(reported.trim())?.[1] ?? JSON.stringify(reported.trim().slice(0, 60));
  return said !== version ? new OpenCodePinMismatch("version", version, said, path) : { path };
};

/** The binary at `path` (absolute, there) against the sha256 values it may have and the version it must report. */
function checkBinary(path: string, version: string, expected: readonly string[]): { path: string } | OpenCodePinMismatch | OpenCodeNotInstalled {
  if (expected.length) {
    let sha256: string;
    try {
      sha256 = sha256OfFile(path);
    } catch (error) {
      return unreadable(path, error);
    }
    if (!expected.includes(sha256)) return new OpenCodePinMismatch("binary_sha256", expected[0]!, sha256, path);
  }
  let reported: string;
  const home = mkdtempSync(join(tmpdir(), "agentrun-opencode-version-"));
  try {
    reported = execFileSync(path, ["--version"], versionRun(home));
  } catch (error) {
    return unrunnable(path, error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return versionVerdict(path, version, reported);
}

/** checkBinary, its read and its run of the binary asynchronous. */
async function checkBinaryAsync(path: string, version: string, expected: readonly string[]): Promise<{ path: string } | OpenCodePinMismatch | OpenCodeNotInstalled> {
  if (expected.length) {
    let sha256: string;
    try {
      sha256 = await sha256OfFileAsync(path);
    } catch (error) {
      return unreadable(path, error);
    }
    if (!expected.includes(sha256)) return new OpenCodePinMismatch("binary_sha256", expected[0]!, sha256, path);
  }
  let reported: string;
  const home = await mkdtemp(join(tmpdir(), "agentrun-opencode-version-"));
  try {
    reported = (await promisify(execFile)(path, ["--version"], versionRun(home))).stdout;
  } catch (error) {
    return unrunnable(path, error);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return versionVerdict(path, version, reported);
}

/** This machine's OpenCode checked against the pins: its path, or the typed error thrown. */
export function verifyOpenCode(found = findOpenCode(), pins: OpenCodePins = openCodePins()): { path: string } {
  const result = verifyOpenCodeBinary(found, pins);
  if (result instanceof Error) throw result;
  return result;
}

/** verifyOpenCode, checked with the event loop free (verifyOpenCodeBinaryAsync): its path, or the typed error thrown. */
export async function verifyOpenCodeAsync(found = findOpenCode(), pins: OpenCodePins = openCodePins()): Promise<{ path: string }> {
  const result = await verifyOpenCodeBinaryAsync(found, pins);
  if (result instanceof Error) throw result;
  return result;
}
