---
packages: @parcha/agentrun-computer
kind: fix
---
The docker CLI and the local browser's Chrome now start with only the environment names they read. Before, every docker child (list's inspect, create's run, connect's exec, the image pull and build), the local browser's supervisor and its Chrome, and the sandbox check's Chrome got the server's whole environment, so a key the server held reached them.

The package reads no environment: `DockerProvider`, `create()`, `dockerArch()`, `ensureImage()` and `checkChrome()` take an `env` option, as `LocalBrowserProvider` already did, and a child holds `DOCKER_ENV_NAMES` or `CHROME_ENV_NAMES` of it. The docker and local Chrome descriptors name these lists in `hostEnv`, so serve passes its own values of them and nothing else.

Docker keeps where the daemon and its config are, content trust (`DOCKER_CONTENT_TRUST`, `DOCKER_CONTENT_TRUST_SERVER`), PATH, HOME, TMPDIR, the locale, the proxy variables, and docker's own credential places (`DOCKER_CONFIG`, a cloud CLI's profile and config). No name shaped as a key reaches it. A credential helper that signs in from keys in the server's environment (ECR with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in env, for example) no longer gets them.

Chrome keeps PATH, HOME, TMPDIR, the locale, the display, the XDG directories, fontconfig's files, the session bus and `CHROME_DEVEL_SANDBOX`. Anything else it read from the server's environment, such as `GOOGLE_API_KEY` for Google's services, or a proxy setting (it is always given its own), no longer reaches it.
