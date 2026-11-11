// The installed Codex checked against the pins (src/versions.ts) before anything runs, with the typed errors a host maps
// to a run's failure line. Written for AgentRun.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "node:process";
import { type BinaryProbe, checkedOnce, checkedOnceAsync } from "@parcha/agentrun-kernel/host";
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
 * adapter, check it once. Its reads hold the event loop: a host checks with verifyCodexBinaryAsync first.
 */
export function verifyCodexBinary(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): { path: string } | CodexPinMismatch | CodexNotInstalled {
  const at = located(found, pins);
  return at instanceof Error ? at : checkedOnce(at.path, JSON.stringify(pins), () => checkBinary(at.path, pins), passed);
}

/** verifyCodexBinary without holding the event loop (the kernel's checkedOnceAsync), its pass kept for it too. */
export async function verifyCodexBinaryAsync(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): Promise<{ path: string } | CodexPinMismatch | CodexNotInstalled> {
  const at = located(found, pins);
  return at instanceof Error ? at : checkedOnceAsync(at.path, JSON.stringify(pins), () => checkBinary(at.path, pins), passed);
}

const passed = (result: { path: string } | Error): boolean => !(result instanceof Error);

/** The absolute path of `found`, there and of the pinned package's version; or why not. */
function located(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins): { path: string } | CodexPinMismatch | CodexNotInstalled {
  if (!found) return new CodexNotInstalled("no Codex binary found for this platform, and CODEX_BIN is not set");
  const path = resolve(found.path);
  if (!existsSync(path)) return new CodexNotInstalled(`no file at ${path}`);
  if (pins.packageVersion && found.packageVersion !== undefined && found.packageVersion !== pins.packageVersion) {
    return new CodexPinMismatch("package_version", pins.packageVersion, found.packageVersion, path);
  }
  return { path };
}

/** The binary at `path` (absolute, there) against `pins`' sha256 and version, as the steps it reads (the kernel's
 *  BinaryCheck). */
function* checkBinary(path: string, pins: CodexPins): Generator<BinaryProbe, { path: string } | CodexPinMismatch | CodexNotInstalled, string> {
  if (pins.sha256) {
    let sha256: string;
    try {
      sha256 = yield { kind: "sha256", path };
    } catch (error) {
      return new CodexNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
    if (sha256 !== pins.sha256) return new CodexPinMismatch("binary_sha256", pins.sha256, sha256, path);
  }
  let reported: string;
  try {
    reported = (yield { kind: "run", path, args: ["--version"], env: { PATH: env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 10_000 }).trim();
  } catch (error) {
    return new CodexNotInstalled(`${path} could not be run: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  }
  const version = /^codex-cli (\S+)$/.exec(reported)?.[1] ?? JSON.stringify(reported.slice(0, 60));
  if (version !== pins.version) return new CodexPinMismatch("version", pins.version, version, path);
  return { path };
}

/** This machine's Codex checked against the pins: its path, or the typed error thrown. */
export function verifyCodex(found = findCodex(), pins: CodexPins = codexPins()): { path: string } {
  const result = verifyCodexBinary(found, pins);
  if (result instanceof Error) throw result;
  return result;
}

/** verifyCodex without holding the event loop: what a host awaits before it makes the adapter, whose own check then
 *  answers from what this kept. */
export async function verifyCodexAsync(found = findCodex(), pins: CodexPins = codexPins()): Promise<{ path: string }> {
  const result = await verifyCodexBinaryAsync(found, pins);
  if (result instanceof Error) throw result;
  return result;
}
