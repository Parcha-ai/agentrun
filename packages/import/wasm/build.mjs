// Builds scan.rs into ../src/scan-wasm.ts with rustc 1.95.0 exactly and its wasm32-wasip1 target, the toolchain
// rust-toolchain.toml beside this file pins (rustup toolchain install 1.95.0 --profile minimal --target wasm32-wasip1).
// The module is small, so it travels in the source as base64 and no build step of the package needs Rust; CI rebuilds it
// and fails on any byte of difference. Its one path (a bounds check's panic location) is the source's own, wasm/scan.rs,
// never the machine's.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const RUSTC = "rustc 1.95.0 ";
// Run from here, so rustup takes the pinned toolchain; another rustc may write other bytes, so none other builds.
const version = execFileSync("rustc", ["--version"], { cwd: here, encoding: "utf8" });
if (!version.startsWith(RUSTC)) throw new Error(`wasm/build.mjs needs ${RUSTC.trim()}, found ${version.trim()}`);
const dir = mkdtempSync(join(tmpdir(), "scan-wasm-"));
try {
  const out = join(dir, "scan.wasm");
  execFileSync("rustc", ["--edition", "2021", "--target", "wasm32-wasip1", "--crate-type", "cdylib", "-C", "opt-level=3", "-C", "target-feature=+simd128", "-C", "panic=abort", "-C", "strip=symbols", `--remap-path-prefix=${here}=wasm`, "-o", out, join(here, "scan.rs")], { cwd: here, stdio: "inherit" });
  const wasm = readFileSync(out).toString("base64");
  writeFileSync(join(here, "../src/scan-wasm.ts"), `// Built by wasm/build.mjs from wasm/scan.rs: edit that and rebuild, never this.\nexport const SCAN_WASM = "${wasm}";\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
