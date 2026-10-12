#!/usr/bin/env bash
# wllama 3.6.1's compat build (wasm32 + Asyncify: the build every iPhone browser runs, which has neither JSPI nor wasm memory64) with this directory's patch:
#   - llama-server's slot save/restore/erase, reached through wllama's existing rerank message (so wllama's JS and its glue stay npm's 3.6.1), and
#   - large file reads in pieces of at most 8 MiB (a model's token embedding is one 208 MB tensor; WebKit failed such a read with NotReadableError).
# And the same patch as a wasm32 build with JSPI and no Asyncify ($OUT/jspi32/), for a browser with JSPI but no memory64 (Safari 27): half the size, loads faster.
# Needs git, docker (wllama's own build runs in emscripten/emsdk:4.0.20) and npm. Writes $OUT/wllama.{js,wasm} and $OUT/jspi32/wllama.{js,wasm} and prints their sha256.
#   ./build.sh            OUT defaults to ./dist, WORK (the clone) to ./work; both are git-ignored
set -euo pipefail
WLLAMA_TAG=3.6.1
WLLAMA_COMMIT=e3972797f9d508887440e9d3fa87dc296f2dec44
LLAMA_CPP_COMMIT=83d855c5a6d70487121edbf4020b25c96b7a04e7 # wllama 3.6.1's llama.cpp submodule
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# absolute before any cd: a relative WORK or OUT names a place beside the caller
mkdir -p "${WORK:-$here/work}" "${OUT:-$here/dist}"
work=$(cd "${WORK:-$here/work}" && pwd)
out=$(cd "${OUT:-$here/dist}" && pwd)

rm -rf "$work/wllama"
git clone --quiet --depth 1 --branch "$WLLAMA_TAG" https://github.com/ngxson/wllama.git "$work/wllama"
cd "$work/wllama"
[ "$(git rev-parse HEAD)" = "$WLLAMA_COMMIT" ] || { echo "wllama $WLLAMA_TAG is not $WLLAMA_COMMIT" >&2; exit 1; }
git submodule update --init --depth 1 llama.cpp
[ "$(git -C llama.cpp rev-parse HEAD)" = "$LLAMA_CPP_COMMIT" ] || { echo "llama.cpp is not $LLAMA_CPP_COMMIT" >&2; exit 1; }
git apply "$here/wllama-3.6.1-d0.patch.txt" # a unified diff; .txt so the source export (which reviews file types) carries it

(cd scripts && SKIP_DEFAULT=1 BUILD_JSPI32=1 ./build_wasm.sh)
cp compat/wasm/wllama.js compat/wasm/wllama.wasm "$out/"
mkdir -p "$out/jspi32" && cp jspi32/wasm/wllama.js jspi32/wasm/wllama.wasm "$out/jspi32/"

# The patch changes C++ only: the emscripten glue must be byte for byte npm's compat build, or the npm JS that loads it is not its match.
npm pack --silent --pack-destination "$work" "@wllama/wllama-compat@$WLLAMA_TAG" >/dev/null
mkdir -p "$work/npm" && tar -xzf "$work/wllama-wllama-compat-$WLLAMA_TAG.tgz" -C "$work/npm"
cmp "$out/wllama.js" "$work/npm/package/wasm/wllama.js" || { echo "the rebuilt glue differs from npm's @wllama/wllama-compat@$WLLAMA_TAG" >&2; exit 1; }
sha256sum "$out/wllama.js" "$out/wllama.wasm" "$out/jspi32/wllama.js" "$out/jspi32/wllama.wasm"
