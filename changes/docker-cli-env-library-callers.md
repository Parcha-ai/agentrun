---
packages: @parcha/agentrun-computer
kind: breaking
---
A library caller of `DockerProvider`, `create()`, `dockerArch()`, `ensureImage()` or `checkChrome()` must now pass `env` (serve does). Without it, docker and Chrome start with no environment at all: a bare `docker` is found only on the default path (`/usr/bin:/bin`), so a docker in `/usr/local/bin` or a snap is no longer found, and neither is a credential helper on PATH. Pass `env`, or name the CLI by its absolute path with the `docker` option.
