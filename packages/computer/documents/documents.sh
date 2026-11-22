#!/bin/sh
# The documents layer, as POSIX shell run as root: the libraries that write decks, documents and sheets, on a Debian
# with python3 (and its pip) and Debian's node and npm. The Docker box's documents image runs it on the default recipe's
# base (this folder's Dockerfile), and Daytona's documents snapshot runs it on the box image (box/build-daytona.py
# --documents), so both hold the same libraries at the same versions.
#
#   Python: python-pptx, python-docx and openpyxl, and every package they need, each at an exact version and checked
#           against its sha256 (a wheel for amd64 and one for arm64 where the package is built per machine), wheels
#           only, nothing pip picks itself. Into the system's site-packages, so any user's python3 imports them.
#   Node:   pptxgenjs, docx and exceljs at exact versions, their dependencies as the registry had them at the instant
#           npm's --before names (the instant the documents image's Debian snapshot names), no install script run.
#           Into a folder of their own, linked as /node_modules: Node looks for a package in node_modules of every
#           folder above a script, up to /, so a script anywhere requires or imports them, with no NODE_PATH (a box's
#           commands get PATH and HOME, not the image's environment).
#
# It reads the network only through pip (PyPI) and npm (the registry), and ends by loading each library as an agent
# would, so a build that is missing one fails here.
set -eu

requirements=$(mktemp)
cat > "$requirements" <<'REQUIREMENTS'
python-pptx==1.0.2 --hash=sha256:160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba
python-docx==1.2.0 --hash=sha256:3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7
openpyxl==3.1.5 --hash=sha256:5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2
et-xmlfile==2.0.0 --hash=sha256:7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa
lxml==6.1.3 \
  --hash=sha256:379f8a75cf6eb7eef0af074b55f49ab73b868388a98de14646abcdfa4564bb11 \
  --hash=sha256:909f4e927bb051f7740d6367285fc60cdcfdaf0258c2dba4ff5ba7eadadc250c \
  --hash=sha256:f683dc6300317700025e41d89a43e0276692ded16113a3c43eab704d605c58e5 \
  --hash=sha256:b37772102d44bb6628186accca3a121b1fa3a6b3d97518a8c29a5229ca4c0d0a
pillow==13.0.0 \
  --hash=sha256:42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca \
  --hash=sha256:8bf295fe459343bc6093c8e5e0df60bfa189e0fcb775a22e2c2488fdeccc6c0d
xlsxwriter==3.3.3 --hash=sha256:2b83c5e184d872275e87718ebc88688acc258a50fc84dcad965b3d10be6e345f
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
REQUIREMENTS
python3 -m pip install --require-hashes --no-deps --only-binary=:all: --no-cache-dir --disable-pip-version-check --root-user-action=ignore -r "$requirements"
rm "$requirements"

mkdir -p /usr/local/lib/agentrun-documents
npm install --prefix /usr/local/lib/agentrun-documents --no-audit --no-fund --ignore-scripts --before=2026-11-21T20:42:00Z pptxgenjs@4.0.1 docx@9.16.0 exceljs@4.4.0
npm cache clean --force
chmod -R a+rX /usr/local/lib/agentrun-documents
[ -e /node_modules ] || ln -s /usr/local/lib/agentrun-documents/node_modules /node_modules

# Each library as an agent loads it: Python's by import, Node's required from a folder that is not theirs.
python3 -c "import pptx, docx, openpyxl"
cd /tmp && node -e 'for (const name of ["pptxgenjs", "docx", "exceljs"]) require(name)'
