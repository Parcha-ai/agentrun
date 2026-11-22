# The documents box image: the Docker box's default image (DOCKER_RECIPE in src/docker/image.ts, on the same base digest
# and with the same programs) plus the libraries that write decks, documents and sheets, which a box with no network
# can't install: python-pptx, python-docx and openpyxl for python3, pptxgenjs, docx and exceljs for node. The libraries
# are documents.sh's, beside this file, the one layer Daytona's documents snapshot runs on the box image too
# (box/build-daytona.py --documents); its comment says how each is pinned and where it goes.
#
# It is built from this folder and named to serve in AGENTRUN_DOCKER_IMAGE, the one setting that picks a Docker box's
# image. From the repository's root:
#
#   tag=agentrun-documents:$(cat packages/computer/documents/Dockerfile packages/computer/documents/documents.sh | sha256sum | cut -c1-12)
#   docker build -t "$tag" packages/computer/documents
#   AGENTRUN_DOCKER_IMAGE=$tag AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
#
# The tag is the first 12 hex digits of the sha256 of this file and documents.sh, as a recipe's tag is: an edit to
# either is a new tag. The base is pinned by digest, the Debian packages by a snapshot.debian.org instant, the Python
# libraries by version and sha256, and the Node libraries by version and npm's --before at that same instant (by date,
# not by content). Nothing in it holds a key, and nothing in it is fetched when a box runs. An agent that needs them says
# so in computer.needs (["python-pptx", "pptxgenjs"], say), which each run checks in its box before its first model
# request.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

# The default image's programs, from Debian's archive and its security archive as snapshot.debian.org held them at one
# instant (the step fails if a source still names the live mirror). apt checks each package against that snapshot's
# signed index; a snapshot's index is past its Valid-Until date, so apt is told not to refuse it for that.
RUN sed -i -E 's#^URIs: http://deb\.debian\.org/(debian|debian-security)$#URIs: http://snapshot.debian.org/archive/\1/20261121T204200Z#' /etc/apt/sources.list.d/debian.sources \
 && ! grep -q 'deb\.debian\.org' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ca-certificates nodejs npm ripgrep socat \
 && rm -rf /var/lib/apt/lists/*

# The libraries.
COPY documents.sh /tmp/agentrun-documents/documents.sh
RUN sh /tmp/agentrun-documents/documents.sh && rm -rf /tmp/agentrun-documents
