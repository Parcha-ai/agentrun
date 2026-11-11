// The installed Codex checked against the pins (src/versions.ts) before anything runs, with the typed errors a host maps
// to a run's failure line. Written for AgentRun.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "node:process";
import { promisify } from "node:util";
import { checkedOnce, checkedOnceAsync, sha256OfFile, sha256OfFileAsync } from "@parcha/agentrun-kernel/host";
import { codexTarget, findCodex } from "./binary.js";
import { CODEX_BINARY_SHA256, CODEX_VERSION, CodexNotInstalled, CodexPinMismatch } from "./versions.js";

export interface CodexPins {
  /** The release `codex --version` must report. */
  version: string;
  /** The binary's sha256; unchecked when undefined (a target the pins do not list). */
  sha256?: string;
  /** The platform package's version (`<version>-<platform>`), when the binary came from one. */
  packageVersion?: string;
}

/** The pins for this platform's binary. */
export function codexPins(target = codexTarget()): CodexPins {
  return { version: CODEX_VERSION, sha256: target ? CODEX_BINARY_SHA256[target.target] : undefined, packageVersion: target ? `${CODEX_VERSION}-${target.pkg}` : undefined };
}

/**
 * The binary at `found.path` checked against `pins`, in order: the platform package's version, the binary's sha256,
 * then the version it reports. Returns the path, or the typed error (not thrown) naming the pin, what was expected and
 * what was found. No path, or a binary that cannot be read or run, is `CodexNotInstalled`. The path is made absolute
 * first, from this process's working directory, and that is the one checked and returned: a session starts the binary
 * from its own directory, where a relative `CODEX_BIN` names nothing. The sha256 is read a chunk at a time, never the
 * whole binary in memory, and a check that passed holds for this process while the binary stays the same file, unchanged
 * (the kernel's checkedOnce): a host that checks it for each model it resolves, and a run's process that makes its
 * adapter, check it once.
 */
export function verifyCodexBinary(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): { path: string } | CodexPinMismatch | CodexNotInstalled {
  const at = located(found, pins);
  if (typeof at !== "string") return at;
  // Hashed a chunk at a time, and once per binary in this process while it stays the same file.
  return checkedOnce(at, JSON.stringify(pins), () => checkBinary(at, pins), (result) => !(result instanceof Error));
}

/** verifyCodexBinary's answer, with the event loop handed back while the binary is hashed and answers --version, kept on
 *  the same record: a check that passed here makes verifyCodexBinary (the adapter's own) answer at once. */
export async function verifyCodexBinaryAsync(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): Promise<{ path: string } | CodexPinMismatch | CodexNotInstalled> {
  const at = located(found, pins);
  if (typeof at !== "string") return at;
  return checkedOnceAsync(at, JSON.stringify(pins), () => checkBinaryAsync(at, pins), (result) => !(result instanceof Error));
}

/** The binary's absolute path, or why there is none to check: no binary, no file there, or its package's version. */
function located(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins): string | CodexPinMismatch | CodexNotInstalled {
  if (!found) return new CodexNotInstalled("no Codex binary found for this platform, and CODEX_BIN is not set");
  const path = resolve(found.path);
  if (!existsSync(path)) return new CodexNotInstalled(`no file at ${path}`);
  if (pins.packageVersion && found.packageVersion !== undefined && found.packageVersion !== pins.packageVersion) {
    return new CodexPinMismatch("package_version", pins.packageVersion, found.packageVersion, path);
  }
  return path;
}

/** How the binary is asked its version: no environment but PATH, 10 s at most. */
const VERSION_RUN = () => ({ env: { PATH: env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" as const, timeout: 10_000 });
const unreadable = (path: string, error: unknown) => new CodexNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
const unrunnable = (path: string, error: unknown) => new CodexNotInstalled(`${path} could not be run: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
/** What `--version` reported, against the pins. */
const versionVerdict = (path: string, pins: CodexPins, reported: string): { path: string } | CodexPinMismatch => {
  const version = /^codex-cli (\S+)$/.exec(reported.trim())?.[1] ?? JSON.stringify(reported.trim().slice(0, 60));
  return version !== pins.version ? new CodexPinMismatch("version", pins.version, version, path) : { path };
};

/** The binary at `path` (absolute, there) against `pins`' sha256 and version. */
function checkBinary(path: string, pins: CodexPins): { path: string } | CodexPinMismatch | CodexNotInstalled {
  if (pins.sha256) {
    let sha256: string;
    try {
      sha256 = sha256OfFile(path);
    } catch (error) {
      return unreadable(path, error);
    }
    if (sha256 !== pins.sha256) return new CodexPinMismatch("binary_sha256", pins.sha256, sha256, path);
  }
  let reported: string;
  try {
    reported = execFileSync(path, ["--version"], VERSION_RUN());
  } catch (error) {
    return unrunnable(path, error);
  }
  return versionVerdict(path, pins, reported);
}

/** checkBinary, its read and its run of the binary asynchronous. */
async function checkBinaryAsync(path: string, pins: CodexPins): Promise<{ path: string } | CodexPinMismatch | CodexNotInstalled> {
  if (pins.sha256) {
    let sha256: string;
    try {
      sha256 = await sha256OfFileAsync(path);
    } catch (error) {
      return unreadable(path, error);
    }
    if (sha256 !== pins.sha256) return new CodexPinMismatch("binary_sha256", pins.sha256, sha256, path);
  }
  let reported: string;
  try {
    reported = (await promisify(execFile)(path, ["--version"], VERSION_RUN())).stdout;
  } catch (error) {
    return unrunnable(path, error);
  }
  return versionVerdict(path, pins, reported);
}

/** This machine's Codex checked against the pins: its path, or the typed error thrown. */
export function verifyCodex(found = findCodex(), pins: CodexPins = codexPins()): { path: string } {
  const result = verifyCodexBinary(found, pins);
  if (result instanceof Error) throw result;
  return result;
}

/** verifyCodex, checked with the event loop free (verifyCodexBinaryAsync): its path, or the typed error thrown. */
export async function verifyCodexAsync(found = findCodex(), pins: CodexPins = codexPins()): Promise<{ path: string }> {
  const result = await verifyCodexBinaryAsync(found, pins);
  if (result instanceof Error) throw result;
  return result;
}
