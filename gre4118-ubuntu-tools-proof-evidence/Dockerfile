FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node_source
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
COPY --from=node_source /usr/local /usr/local
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git openssl python3 ghostscript poppler-utils ffmpeg procps ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts npm@11.21.0 >/dev/null
RUN if getent passwd ubuntu >/dev/null; then groupmod -n node ubuntu && usermod -l node -d /home/node -m ubuntu; else groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node; fi
USER node
WORKDIR /workspace
