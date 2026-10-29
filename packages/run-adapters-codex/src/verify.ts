// The installed Codex checked against the pins (src/versions.ts) before anything runs, with the typed errors a host maps
// to a run's failure line. Written for AgentRun.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "node:process";
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
 * from its own directory, where a relative `CODEX_BIN` names nothing.
 */
export function verifyCodexBinary(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): { path: string } | CodexPinMismatch | CodexNotInstalled {
  if (!found) return new CodexNotInstalled("no Codex binary found for this platform, and CODEX_BIN is not set");
  const path = resolve(found.path);
  if (!existsSync(path)) return new CodexNotInstalled(`no file at ${path}`);
  if (pins.packageVersion && found.packageVersion !== undefined && found.packageVersion !== pins.packageVersion) {
    return new CodexPinMismatch("package_version", pins.packageVersion, found.packageVersion, path);
  }
  if (pins.sha256) {
    let sha256: string;
    try {
      sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch (error) {
      return new CodexNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
    if (sha256 !== pins.sha256) return new CodexPinMismatch("binary_sha256", pins.sha256, sha256, path);
  }
  let reported: string;
  try {
    reported = execFileSync(path, ["--version"], { env: { PATH: env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000 }).trim();
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
