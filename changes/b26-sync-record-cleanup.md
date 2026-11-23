---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
`@parcha/agentrun-computer` no longer exports `PUSHED_MTIME` or `MAX_TAR_MTIME`. A caller that pushed a folder into a synced computer and stamped each file with `PUSHED_MTIME` itself now calls the new `FolderSync.push(entries, options)`: it gives each file the pushed mtime, pushes the tar, and takes the baseline, and its failure says which of the two steps failed. `baseline()` stays for a folder pushed some other way.
- `GET /v2/computers`: a kind's `record` is now one of `{ available: true }` and `{ available: false, why }`, `why` always present when `available` is false (it was optional). A client that read `record.why` as possibly absent can drop its fallback, and the generated TypeScript and Python types narrow on `available`.
- The `path` option of `createComputerRoutes` is gone: a kind's `record` looks for ffmpeg on the PATH of the `env` option, the server's own when it has none.
