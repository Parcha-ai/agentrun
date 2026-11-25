// Builds scan.rs into ../src/scan-wasm.ts: rustc 1.95 or later with the wasm32-wasip1 target
// (rustup target add wasm32-wasip1). The module is small, so it travels in the source as base64 and no build step of the
// package needs Rust. Its one path (a bounds check's panic location) is the source's own, wasm/scan.rs, never the
// machine's.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const dir = mkdtempSync(join(tmpdir(), "scan-wasm-"));
try {
  const out = join(dir, "scan.wasm");
  execFileSync("rustc", ["--edition", "2021", "--target", "wasm32-wasip1", "--crate-type", "cdylib", "-C", "opt-level=3", "-C", "target-feature=+simd128", "-C", "panic=abort", "-C", "strip=symbols", `--remap-path-prefix=${here}=wasm`, "-o", out, join(here, "scan.rs")], { stdio: "inherit" });
  const wasm = readFileSync(out).toString("base64");
  writeFileSync(join(here, "../src/scan-wasm.ts"), `// Built by wasm/build.mjs from wasm/scan.rs: edit that and rebuild, never this.\nexport const SCAN_WASM = "${wasm}";\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
