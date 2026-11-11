// The installed OpenCode checked against the pins (src/versions.ts) before anything runs, with the typed errors a host
// maps to a run's failure line. Written for AgentRun.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { type BinaryProbe, checkedOnce, checkedOnceAsync } from "@parcha/agentrun-kernel/host";
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
  // Hashed a chunk at a time, and checked once per binary in this process while it stays the same file, unchanged (the
  // kernel's checkedOnce): a host that checks it for each model it resolves, and a run's process that makes its adapter,
  // check it once. Its reads hold the event loop: a host checks with verifyOpenCodeBinaryAsync first.
  return at instanceof Error ? at : checkedOnce(at.path, at.key, () => checkBinary(at.path, pins.version, at.expected), passed);
}

/** verifyOpenCodeBinary without holding the event loop (the kernel's checkedOnceAsync), its pass kept for it too. */
export async function verifyOpenCodeBinaryAsync(found: { path: string; pkg?: string; packageVersion?: string } | undefined, pins: OpenCodePins = openCodePins()): Promise<{ path: string } | OpenCodePinMismatch | OpenCodeNotInstalled> {
  const at = located(found, pins);
  return at instanceof Error ? at : checkedOnceAsync(at.path, at.key, () => checkBinary(at.path, pins.version, at.expected), passed);
}

const passed = (result: { path: string } | Error): boolean => !(result instanceof Error);

/** The absolute path of `found`, there and of the pinned version, with the sha256 values it may have and the pins' key;
 *  or why not. */
function located(found: { path: string; pkg?: string; packageVersion?: string } | undefined, pins: OpenCodePins): { path: string; expected: string[]; key: string } | OpenCodePinMismatch | OpenCodeNotInstalled {
  if (!found) return new OpenCodeNotInstalled("no OpenCode binary found for this platform, and OPENCODE_BIN is not set");
  const path = resolve(found.path);
  if (!existsSync(path)) return new OpenCodeNotInstalled(`no file at ${path}`);
  if (found.packageVersion !== undefined && found.packageVersion !== pins.version) return new OpenCodePinMismatch("package_version", pins.version, found.packageVersion, path);
  // A binary from a platform package is checked against that package's pin; one named by OPENCODE_BIN (no package) against
  // the pins of every package this machine may run.
  const expected = (found.pkg ? [found.pkg] : openCodePackages()).map((pkg) => pins.sha256[pkg]).filter((sha): sha is string => typeof sha === "string");
  return { path, expected, key: JSON.stringify({ version: pins.version, expected }) };
}

/** The binary at `path` (absolute, there) against the sha256 values it may have and the version it must report, as the
 *  steps it reads (the kernel's BinaryCheck). */
function* checkBinary(path: string, version: string, expected: readonly string[]): Generator<BinaryProbe, { path: string } | OpenCodePinMismatch | OpenCodeNotInstalled, string> {
  if (expected.length) {
    let sha256: string;
    try {
      sha256 = yield { kind: "sha256", path };
    } catch (error) {
      return new OpenCodeNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
    if (!expected.includes(sha256)) return new OpenCodePinMismatch("binary_sha256", expected[0]!, sha256, path);
  }
  let reported: string;
  // A private home, removed after: `--version` makes OpenCode's directories, and reads no config and writes no state of
  // the host's.
  const home = mkdtempSync(join(tmpdir(), "agentrun-opencode-version-"));
  try {
    const dirs = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") };
    reported = (yield { kind: "run", path, args: ["--version"], env: { PATH: env.PATH ?? "/usr/bin:/bin", ...dirs, OPENCODE_DISABLE_AUTOUPDATE: "1" }, cwd: home, timeoutMs: 20_000 }).trim();
  } catch (error) {
    return new OpenCodeNotInstalled(`${path} could not be run: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const said = /^(\d+\.\d+\.\d+\S*)$/.exec(reported)?.[1] ?? JSON.stringify(reported.slice(0, 60));
  if (said !== version) return new OpenCodePinMismatch("version", version, said, path);
  return { path };
}

/** This machine's OpenCode checked against the pins: its path, or the typed error thrown. */
export function verifyOpenCode(found = findOpenCode(), pins: OpenCodePins = openCodePins()): { path: string } {
  const result = verifyOpenCodeBinary(found, pins);
  if (result instanceof Error) throw result;
  return result;
}

/** verifyOpenCode without holding the event loop: what a host awaits before it makes the adapter, whose own check then
 *  answers from what this kept. */
export async function verifyOpenCodeAsync(found = findOpenCode(), pins: OpenCodePins = openCodePins()): Promise<{ path: string }> {
  const result = await verifyOpenCodeBinaryAsync(found, pins);
  if (result instanceof Error) throw result;
  return result;
}
