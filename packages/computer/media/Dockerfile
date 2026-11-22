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
# The tag is the first 12 hex digits of this file's sha256, as a recipe's tag is: an edit here is a new tag. The base is
# pinned by digest, Node and the headless shell by sha256, and the Debian packages by a snapshot.debian.org instant, so
# two builds of one tag install the same packages. The HyperFrames CLI's dependencies are pinned by npm's --before, the
# same instant: by date, not by content. Nothing in it holds a key, and nothing in it is fetched when a box runs.
#
# A box's commands get PATH and HOME but not the image's environment, so `hyperframes` on PATH is a small script that
# names the browser to render with (the headless shell where the image has it, else Chromium) unless the caller names
# one in HYPERFRAMES_BROWSER_PATH: HyperFrames would otherwise try to download its pinned shell, which a box with no
# network cannot. The script also turns off HyperFrames' usage
# reports and its update check unless the caller turns them on: a box with a network sends nothing of its work home.
# And it gives HyperFrames a font cache in HOME holding a link to each folder of fonts compressed at build (below).
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

# The default image's tools (but its nodejs and npm, which Node's tarball brings), then Chromium, FFmpeg and the fonts,
# from Debian's archive and its security archive as snapshot.debian.org held them at one instant (the step fails if a
# source still names the live mirror). apt checks each package against that snapshot's signed index; a snapshot's index
# is past its Valid-Until date, so apt is told not to refuse it for that.
RUN sed -i -E 's#^URIs: http://deb\.debian\.org/(debian|debian-security)$#URIs: http://snapshot.debian.org/archive/\1/20261121T204200Z#' /etc/apt/sources.list.d/debian.sources \
 && ! grep -q 'deb\.debian\.org' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
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
    'if [ -z "${HYPERFRAMES_FONT_CACHE_DIR:-}" ]; then' \
    '  HYPERFRAMES_FONT_CACHE_DIR="${HOME:-/tmp}/.cache/hyperframes/fonts"' \
    '  if mkdir -p "$HYPERFRAMES_FONT_CACHE_DIR" 2>/dev/null; then' \
    '    for baked in /usr/local/share/hyperframes/fonts/*/; do' \
    '      baked="${baked%/}"; name="${baked##*/}"' \
    '      [ -d "$baked" ] && [ ! -e "$HYPERFRAMES_FONT_CACHE_DIR/$name" ] && ln -s "$baked" "$HYPERFRAMES_FONT_CACHE_DIR/$name" 2>/dev/null' \
    '    done' \
    '  fi' \
    '  export HYPERFRAMES_FONT_CACHE_DIR' \
    'fi' \
    'exec node /usr/local/lib/node_modules/hyperframes/bin/hyperframes.mjs "$@"' \
    > /usr/local/bin/hyperframes \
 && chmod 755 /usr/local/bin/hyperframes \
 && ln -s /usr/bin/chromium /usr/local/bin/chrome \
 && hyperframes --version

# Each of the image's fonts compressed once, here, as HyperFrames compresses a system font it embeds when it can't fetch
# the family from Google Fonts: with no network that is every render, and Noto Color Emoji alone takes about a minute of
# CPU, since a box's own cache starts empty. HyperFrames' own fontToDataUri writes each under this cache root, in the
# folder and under the key HyperFrames picks, and the script links each folder here into the font cache it names in HOME,
# so a render finds them while its Google Fonts cache stays writable; a font it can't compress is said and left, as a
# render would embed it raw. The CJK collections are not compressed: a render naming Noto Sans CJK SC, JP or KR embeds
# none of them (HyperFrames maps no CJK family), and Chrome draws those titles from these system fonts directly.
RUN set -eu; \
    chunk="$(grep -l 'async function fontToDataUri' /usr/local/lib/node_modules/hyperframes/dist/*.js)"; \
    test "$(printf '%s\n' "$chunk" | wc -l)" -eq 1; \
    find /usr/share/fonts -type f \( -name '*.ttf' -o -name '*.otf' \) -print0 | sort -z \
    | HF_CHUNK="$chunk" HYPERFRAMES_FONT_CACHE_DIR=/usr/local/share/hyperframes/fonts xargs -0 -P "$(nproc)" -n 4 node --input-type=module -e 'const { fontToDataUri } = await import(process.env.HF_CHUNK); const { readFileSync } = await import("node:fs"); for (const path of process.argv.slice(1)) { const uri = await fontToDataUri(readFileSync(path), path.endsWith(".otf") ? "otf" : "ttf"); if (!uri.startsWith("data:font/woff2;")) console.log(`left raw: ${path}`); }'; \
    test "$(find /usr/local/share/hyperframes/fonts -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1; \
    echo "$(find /usr/local/share/hyperframes/fonts -name '*.woff2' | wc -l) fonts compressed into $(ls /usr/local/share/hyperframes/fonts)"; \
    chmod -R a+rX /usr/local/share/hyperframes
