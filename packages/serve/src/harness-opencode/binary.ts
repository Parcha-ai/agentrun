// Where this machine's pinned OpenCode binary is. Written for AgentRun.
//
// `opencode-ai` is a small launcher plus one optional npm package per platform (`opencode-<platform>-<arch>`, with
// `-baseline` builds for x64 CPUs without AVX2 and `-musl` builds for musl Linux), each carrying the native binary at
// `bin/opencode` (`bin/opencode.exe` on Windows). The launcher's own postinstall links one of them to its `bin`, but an
// install with scripts off (`npm ci --ignore-scripts`) leaves that link a stub, so the platform package is found here
// directly, in the order the launcher's postinstall tries them.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { env } from "node:process";

/** The OpenCode version this package is built and tested against (`opencode --version` prints it). */
export const OPENCODE_VERSION = "1.19.5";

const PLATFORMS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };

/** Whether this x64 CPU has AVX2 (the non-baseline builds need it); true where it cannot be read. */
function avx2(): boolean {
  if (process.platform !== "linux") return true;
  try {
    return /\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return true;
  }
}

/** Whether this Linux runs on musl rather than glibc. */
function musl(): boolean {
  const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return process.platform === "linux" && !header?.glibcVersionRuntime;
}

/** The platform packages that may carry this machine's binary, most fitting first; none on a platform OpenCode does not
 *  ship. */
export function openCodePackages(platform = process.platform, arch = process.arch): string[] {
  const os = PLATFORMS[platform];
  if (!os || (arch !== "x64" && arch !== "arm64")) return [];
  const base = `opencode-${os}-${arch}`;
  if (os === "linux") {
    const libc = musl() ? [`${base}-musl`, ...(arch === "x64" ? [`${base}-baseline-musl`] : [])] : [base, ...(arch === "x64" ? [`${base}-baseline`] : [])];
    return arch === "x64" && !avx2() ? [...libc].reverse() : libc;
  }
  if (arch === "x64") return avx2() ? [base, `${base}-baseline`] : [`${base}-baseline`, base];
  return [base];
}

/** The binary's name inside a platform package. */
const binName = (platform = process.platform) => (platform === "win32" ? "opencode.exe" : "opencode");

/**
 * The binary to run, the platform package it came from and that package's version, or `undefined` if none is installed:
 *
 * 1. `OPENCODE_BIN`;
 * 2. the first platform package (`openCodePackages`) installed next to the `opencode-ai` this package depends on.
 */
export function findOpenCode(): { path: string; pkg?: string; packageVersion?: string } | undefined {
  if (env.OPENCODE_BIN) return { path: env.OPENCODE_BIN };
  let launcher: string;
  try {
    launcher = dirname(createRequire(import.meta.url).resolve("opencode-ai/package.json"));
  } catch {
    return undefined;
  }
  const from = createRequire(join(launcher, "package.json"));
  for (const pkg of openCodePackages()) {
    try {
      const dir = dirname(from.resolve(`${pkg}/package.json`));
      const bin = join(dir, "bin", binName());
      if (existsSync(bin)) return { path: bin, pkg, packageVersion: packageVersion(dir) };
    } catch {}
  }
  return undefined;
}

/** The binary to run, or `undefined` if none is installed (see `findOpenCode`). */
export function openCodeBinary(): string | undefined {
  return findOpenCode()?.path;
}

function packageVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
