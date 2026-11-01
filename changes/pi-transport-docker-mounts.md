---
packages: @parcha/pi-transport
kind: feature
---
A Docker box binds paths of this machine that the spec names in `BoxSpec.mounts` (`{ source, target, readOnly? }`), read-only where asked, with `--mount type=bind`, never `-v`. A source this machine does not have is refused with `not_found` before Docker is asked. Paths go to Docker as given, so pass canonical ones. Every provider refuses a malformed list as `invalid`: a path that is not absolute and in normal form, a `..` segment, a comma, quote or control character, a target of `/`, a target named twice, or more than 8 mounts. Every provider but Docker refuses any mount as `unsupported` before it makes anything. `BoxProvider.mounts` is `true` only on a provider that binds them, so a caller can ask before it chooses one; the box receipts ledger keeps it on the providers it wraps.
