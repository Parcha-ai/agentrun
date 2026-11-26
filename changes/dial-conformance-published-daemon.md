---
packages: repo
kind: fix
---
`dial-conformance`'s `drift.version` case runs against a published computerd: it writes over only the version the build stamped, and leaves the two copies in the daemon's Go build info (`v<version>`) alone. Before, it refused every daemon built at a release tag, so a checkout without Go, which takes the daemon from npm, failed the case.
