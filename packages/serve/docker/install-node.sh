#!/bin/sh
# Installs one Node.js release from nodejs.org into <dest>, verified, for the image's build (Dockerfile, its `node` stage):
#   install-node.sh <version> <signer fingerprint> <nodejs/release-keys commit> <dest>
# It takes the linux tarball for the build's TARGETARCH (amd64 or arm64), the release's SHASUMS256.txt with both its
# signatures (.sig, detached, and .asc, clearsigned), and the signer's public key from nodejs/release-keys at the pinned
# commit. It fails, installing nothing, unless both signatures verify as made by that one fingerprint, the tarball's line
# is in both signed lists, and the tarball matches it. Needs curl, gpg and xz on PATH (the stage installs them).
set -eu
version=${1:?usage: install-node.sh <version> <signer fingerprint> <release-keys commit> <dest>}
signer=${2:?signer fingerprint}
keys=${3:?nodejs/release-keys commit}
dest=${4:?destination}
case "${TARGETARCH:-}" in
  amd64) arch=x64 ;;
  arm64) arch=arm64 ;;
  *) echo "install-node: no Node $version build for TARGETARCH '${TARGETARCH:-}' (build with BuildKit, for amd64 or arm64)" >&2; exit 1 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
base="https://nodejs.org/dist/v$version"
tarball="node-v$version-linux-$arch.tar.xz"
for file in "$tarball" SHASUMS256.txt SHASUMS256.txt.sig SHASUMS256.txt.asc; do curl -fsSLO "$base/$file"; done
curl -fsSL -o signer.asc "https://raw.githubusercontent.com/nodejs/release-keys/$keys/keys/$signer.asc"
export GNUPGHOME="$work/gnupg"
mkdir -m 0700 "$GNUPGHOME"
gpg -q --batch --import signer.asc
# VALIDSIG carries the signing key's full fingerprint: a signature by any other key, even a Node releaser's, fails here.
gpg --batch --status-fd 1 --verify SHASUMS256.txt.sig SHASUMS256.txt 2>/dev/null > sig.status \
  || { echo "install-node: SHASUMS256.txt.sig does not verify" >&2; exit 1; }
grep -q "^\[GNUPG:\] VALIDSIG $signer " sig.status || { echo "install-node: SHASUMS256.txt.sig is not by $signer" >&2; exit 1; }
gpg --batch --status-fd 1 --output SHASUMS256.clear --decrypt SHASUMS256.txt.asc 2>/dev/null > asc.status \
  || { echo "install-node: SHASUMS256.txt.asc does not verify" >&2; exit 1; }
grep -q "^\[GNUPG:\] VALIDSIG $signer " asc.status || { echo "install-node: SHASUMS256.txt.asc is not by $signer" >&2; exit 1; }
line=$(grep "  $tarball\$" SHASUMS256.txt) || { echo "install-node: SHASUMS256.txt has no $tarball" >&2; exit 1; }
grep -qxF "$line" SHASUMS256.clear || { echo "install-node: the two signed lists disagree on $tarball" >&2; exit 1; }
echo "$line" | sha256sum -c - >/dev/null || { echo "install-node: $tarball does not match its signed checksum" >&2; exit 1; }
mkdir -p "$dest"
tar -xJf "$tarball" -C "$dest" --strip-components=1 --no-same-owner
rm -f "$dest/CHANGELOG.md" "$dest/README.md" "$dest/LICENSE"
[ "$("$dest/bin/node" --version)" = "v$version" ] || { echo "install-node: $dest/bin/node is not v$version" >&2; exit 1; }
echo "install-node: Node v$version ($arch) verified against $signer and installed in $dest"
