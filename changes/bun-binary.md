---
packages: repo
kind: ci
---
CI compiles the session-counts entry (`scripts/session-counts.mjs`, a stand-in for the importer's own CLI) into a single binary with Bun, on Linux x64, Linux arm64 and macOS arm64, runs each on a made-up home, and keeps it as an artifact. Node stays the runtime the packages ship on.
`node scripts/build-binary.mjs [--entry FILE] [--target bun-<os>-<arch>]...` builds it locally with the Bun `.bun-version` pins. It refuses an entry that imports `node:sqlite` where it loads (Bun has none; import `bun:sqlite` in a branch for Bun), and the binary reads no `.env` or `bunfig.toml` from the directory it runs in.
