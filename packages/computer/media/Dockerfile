# The media box image: the Docker box's default image (DOCKER_RECIPE in src/docker/image.ts, on the same base digest)
# plus what renders video in a box with no network: Node 24 from its official tarball (pinned by sha256; Debian's nodejs
# is older than HyperFrames' Node 22 floor), Chromium, FFmpeg and FFprobe, fonts for titles (Noto with CJK and colour
# emoji, Liberation, DejaVu), the HyperFrames CLI at an exact version, and on amd64 the chrome-headless-shell build that
# CLI pins (pinned here by sha256), which renders with its fast capture path and the pixels it was tuned on. `chrome` on
# PATH is Chromium, so a box's needs name plain programs: chrome, ffmpeg, ffprobe, hyperframes.
#
# It is built with no context and named to serve in AGENTRUN_DOCKER_IMAGE, the one setting that picks a Docker box's
# image. From the repository's root:
#
#   tag=agentrun-media:$(sha256sum packages/computer/media/Dockerfile | cut -c1-12)
#   docker build -t "$tag" - < packages/computer/media/Dockerfile
#   AGENTRUN_DOCKER_IMAGE=$tag AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
#
# The tag is the first 12 hex digits of this file's sha256, as a recipe's tag is: an edit here is a new tag. Nothing in it
# holds a key, and nothing in it is fetched when a box runs. A box's commands get PATH and HOME but not the image's
# environment, so `hyperframes` on PATH is a small script that names the browser to render with (the headless shell where
# the image has it, else Chromium) unless the caller names one in HYPERFRAMES_BROWSER_PATH: HyperFrames would otherwise
# try to download its pinned shell, which a box with no network cannot. The script also turns off HyperFrames' usage
# reports and its update check unless the caller turns them on: a box with a network sends nothing of its work home.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

# The default image's tools (but its nodejs and npm, which Node's tarball brings), then Chromium, FFmpeg and the fonts.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ca-certificates ripgrep socat unzip xz-utils \
    chromium ffmpeg fontconfig fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Node 24.22.3 from nodejs.org, checked against its sha256 for this machine's architecture before it is unpacked.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sum=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;; \
      arm64) arch=arm64; sum=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;; \
      *) echo "no Node build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    file="node-v24.22.3-linux-$arch.tar.xz"; \
    curl -fsSLo "/tmp/$file" "https://nodejs.org/dist/v24.22.3/$file"; \
    echo "$sum  /tmp/$file" | sha256sum -c -; \
    tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    rm "/tmp/$file"; \
    node --version; npm --version

# chrome-headless-shell 158.0.8127.36, the build HyperFrames 0.9.78 pins, from Chrome for Testing, checked against its
# sha256 (amd64 only: on arm64 HyperFrames renders with Chromium).
RUN set -eu; \
    if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      curl -fsSLo /tmp/shell.zip https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/linux64/chrome-headless-shell-linux64.zip; \
      echo "2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a  /tmp/shell.zip" | sha256sum -c -; \
      unzip -q /tmp/shell.zip -d /opt; \
      rm /tmp/shell.zip; \
      ln -s /opt/chrome-headless-shell-linux64/chrome-headless-shell /usr/local/bin/chrome-headless-shell; \
      chrome-headless-shell --version; \
    fi

# The HyperFrames CLI at an exact version, its dependencies as the registry had them when it was published (--before), no
# install script run, behind the script that names its browser and turns off its reports. Then `chrome`, the name a
# box's needs use, for Chromium.
RUN npm install --global --ignore-scripts --before=2026-11-21T20:42:00Z hyperframes@0.9.78 \
 && npm cache clean --force \
 && rm /usr/local/bin/hyperframes \
 && printf '%s\n' \
    '#!/bin/sh' \
    'if [ -z "${HYPERFRAMES_BROWSER_PATH:-}" ]; then' \
    '  HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium' \
    '  [ -x /usr/local/bin/chrome-headless-shell ] && HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell' \
    '  export HYPERFRAMES_BROWSER_PATH' \
    'fi' \
    'export HYPERFRAMES_NO_TELEMETRY="${HYPERFRAMES_NO_TELEMETRY:-1}"' \
    'export HYPERFRAMES_NO_UPDATE_CHECK="${HYPERFRAMES_NO_UPDATE_CHECK:-1}"' \
    'exec node /usr/local/lib/node_modules/hyperframes/bin/hyperframes.mjs "$@"' \
    > /usr/local/bin/hyperframes \
 && chmod 755 /usr/local/bin/hyperframes \
 && ln -s /usr/bin/chromium /usr/local/bin/chrome \
 && hyperframes --version
