---
packages: @parcha/agentrun-computer
kind: breaking
---
A library caller of `DockerProvider`, `create()`, `dockerArch()`, `ensureImage()` or `checkChrome()` must now pass `env` (serve does). Without it, docker and Chrome start with no environment at all: a bare `docker` is found only on the default path (`/usr/bin:/bin`), so a docker in `/usr/local/bin` or a snap is no longer found, and neither is a credential helper on PATH. Pass `env`, or name the CLI by its absolute path with the `docker` option.

An operator's docker credential helper no longer gets `AWS_SHARED_CREDENTIALS_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `GOOGLE_APPLICATION_CREDENTIALS` or `PASSWORD_STORE_DIR`. On ECS (Fargate) or EKS with IRSA, an ECR helper that signed in through the task's or the pod's role this way stops finding credentials: give it a profile in `AWS_CONFIG_FILE`, or the default credentials file, instead.
