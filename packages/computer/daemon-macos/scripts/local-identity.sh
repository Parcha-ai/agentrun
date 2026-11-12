#!/usr/bin/env bash
# This Mac's own code signing identity for Computerd (MINI.md), made the first time and unlocked every time after.
# Prints the identity's SHA-1, for COMPUTERD_SIGN_IDENTITY; everything else goes to stderr.
#
#   COMPUTERD_SIGN_IDENTITY="$(scripts/local-identity.sh)" scripts/bundle.sh
#
# The identity is a self-signed code signing certificate, "Computerd Local Signing", in a keychain of its own whose
# password sits in ~/.computerd-signing (0600), so signing works over SSH with no dialog. A build signed with it has a
# designated requirement that names the certificate, not the build, so macOS keeps its grants across rebuilds. The
# certificate is not trusted system-wide and need not be: codesign, the socket's peer check and TCC compare hashes.
set -euo pipefail

cn="Computerd Local Signing"
signing="$HOME/.computerd-signing"
# security makes NAME.keychain as NAME.keychain-db, the name the search list then shows.
keychain="$HOME/Library/Keychains/computerd-signing.keychain"
file="$keychain-db"

mkdir -p "$signing"
chmod 700 "$signing"
if [[ ! -f "$signing/keychain-password" ]]; then
	(umask 077 && openssl rand -hex 24 >"$signing/keychain-password")
fi
password="$(cat "$signing/keychain-password")"
if [[ ! -f "$file" ]]; then
	security create-keychain -p "$password" "$keychain"
	echo "made $file" >&2
fi
security unlock-keychain -p "$password" "$file"
security set-keychain-settings "$file" # no auto-lock, and no lock on sleep: signing over SSH must not find it locked

if ! security find-certificate -c "$cn" "$file" >/dev/null 2>&1; then
	work="$(mktemp -d)"
	openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$cn" \
		-keyout "$work/key.pem" -out "$work/cert.pem" \
		-addext "basicConstraints=critical,CA:false" \
		-addext "keyUsage=critical,digitalSignature" \
		-addext "extendedKeyUsage=critical,codeSigning" >&2
	# The legacy PKCS#12 ciphers, which security import reads.
	openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$cn" -out "$work/identity.p12" \
		-passout "pass:$password" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
	security import "$work/identity.p12" -k "$file" -P "$password" -T /usr/bin/codesign >&2
	rm -rf "${work:?}"
	# Lets codesign use the key with no "allow" dialog, which SSH could not answer.
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$file" >/dev/null
	echo "made the identity '$cn'" >&2
fi

# codesign looks for identities in the user's keychain search list.
searched="$(security list-keychains -d user | tr -d '" ' | tr '\n' ' ')"
if [[ " $searched " != *" $file "* ]]; then
	# shellcheck disable=SC2086 # the list is paths without spaces, one word each
	security list-keychains -d user -s "$file" $searched
fi

hash="$(security find-certificate -c "$cn" -Z "$file" | awk '/SHA-1 hash:/ { print $NF; exit }')"
[[ -n "$hash" ]] || { echo "the identity '$cn' is not in $file" >&2; exit 1; }
echo "identity '$cn', SHA-1 $hash, in $file" >&2
echo "$hash"
