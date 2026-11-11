---
packages: @parcha/agentrun-serve
kind: fix
---
A Mode 2 server with no exec image saved now runs its Archil execs in Docker's `buildpack-deps:trixie-scm`, pinned by digest (`buildpack-deps@sha256:4f34e1d6…`, git 2.47.3), instead of Archil's default exec image. Archil's image has git 2.34.1, and a shell under a bash policy runs git only at 2.43 or later, so a read-only agent on Archil got no git. An image saved through `PUT /v2/workspace/archil` (`image`) still replaces the default; it needs git 2.43 for a read-only agent, and GNU coreutils and perl for the exec line, as Debian-family images have. The console's image field says the new default.
