# Ubuntu tools image readiness

**PASS.** The unchanged native frame-track case passes in an isolated Ubuntu 24.04 tools image with Node 22.23.2 and FFmpeg 6.1.1. This prepares the runtime for the final repository gate; it does not claim that the full gate has run.

- Runnable immutable image ID: `sha256:1a4c3cf64815a4660d7ca3f3a667baa8b9c1c9128ce422170cf50404cc8298f0`.
- Local tag: `gre4118-check-tools:ubuntu24-node22`.
- OS: Ubuntu 24.04.5 LTS, glibc 2.39; process identity UID/GID 1000 (`node`).
- Node `v22.23.2`; npm `11.21.0`.
- FFmpeg and ffprobe `6.1.1-3ubuntu5`; libvpx9 `1.14.0-1ubuntu2.3`.
- Available tools include git, OpenSSL, Python 3, Ghostscript, Poppler utilities and procps. Exact Debian package versions are recorded in [environment.json](gre4118-ubuntu-tools-proof-evidence/environment.json).

The [Dockerfile](gre4118-ubuntu-tools-proof-evidence/Dockerfile) copies `/usr/local` from the pinned public **bookworm** Node image into pinned Ubuntu 24.04. It uses no private build context, package, service or credential. Docker used a fresh configuration containing only `{"auths":{}}`; the context allowlist included only the Dockerfile. [Build log](gre4118-ubuntu-tools-proof-evidence/build.log) and [image metadata](gre4118-ubuntu-tools-proof-evidence/image.json) bind the result to the image ID. Public apt repositories supplied the package versions listed in the receipt; those repositories are mutable, so replaying the recipe later can resolve newer package builds.

## Focused unchanged test

Source HEAD was `23bf2743349e38461601fd6e959d6801b99df46e`. No repository source, test or built artifact was changed by this verification. The existing test was executed against the existing compiled package through a **read-only** checkout mount, as `node`, with `--init` and `--network none`:

```sh
mkdir -p "$TOOLS_CONTEXT" "$TOOLS_CONTEXT/docker-config"
printf '%s\n' '{"auths":{}}' > "$TOOLS_CONTEXT/docker-config/config.json"
DOCKER_CONFIG="$TOOLS_CONTEXT/docker-config" docker build --platform linux/amd64 \
  --tag gre4118-check-tools:ubuntu24-node22 "$TOOLS_CONTEXT"
DOCKER_CONFIG="$TOOLS_CONTEXT/docker-config" docker run --rm --init --network none \
  --name gre4118-ubuntu24-frame-proof \
  --mount "type=bind,source=$CHECKOUT,target=/workspace,readonly" \
  sha256:1a4c3cf64815a4660d7ca3f3a667baa8b9c1c9128ce422170cf50404cc8298f0 \
  node --test --test-name-pattern="a session's frames become a WebM" \
  packages/pi-browser/test/frame_track.test.mjs
```

Set `TOOLS_CONTEXT` to a new directory containing the linked Dockerfile and a `.dockerignore` that allows only that Dockerfile; set `CHECKOUT` to a public checkout with its normal dependencies/build already present. The actual run additionally mounted a synthetic evidence directory for the environment script, with no source write access. No full repository check or source build was run here.

[Focused TAP](gre4118-ubuntu-tools-proof-evidence/focused.tap): **1 passed, 0 failed, 0 skipped**, including the existing assertions of **40 decoded frames** and approximately **4 seconds**. Compiled exporter SHA-256 remained `35eacb13b3411fb8de5040296c54ef2f46a996088d13689e918fa9b530af4e4f`, matching the previously diagnosed FFmpeg 7 comparison. [Checkout identity](gre4118-ubuntu-tools-proof-evidence/checkout.json) records a clean working tree; source/test/build SHA-256 values are in the environment receipt.

Both exact test/environment containers were automatically removed; [absence readback](gre4118-ubuntu-tools-proof-evidence/cleanup.json) passed. The tools image is retained for the parent agent's gate. There were no host package installs, source edits, registry pushes, public routes or paid model calls.

The separate [FFmpeg 7 diagnosis](frame-track-diagnosis.md) remains a recorded failure in that environment. This Ubuntu result does not remediate or erase that compatibility defect, and does not establish parity with every GitHub-hosted runner image.
