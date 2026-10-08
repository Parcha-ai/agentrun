#!/usr/bin/env bash
# The Docker quickstart: kill a host in the middle of a paid charge and watch the run resume on another, with nothing on
# this machine but Docker, Node and an Archil account. Works on macOS (Docker Desktop, OrbStack, Colima) and Linux; no
# sudo, no FUSE or archil client on this machine. Every instance runs in a container of the package's image.
#
#   export ARCHIL_API_KEY=...            # Archil console, API keys
#   export ARCHIL_DISK=dsk-...           # a disk for scratch runs (the free plan allows 5)
#   export ARCHIL_REGION=aws-us-east-1   # the disk's region
#   packages/pi-durable-archil/examples/docker-quickstart.sh   # from a clone of the repository; extra arguments go to the
#                                                             # demo (e.g. freeze, --keep)
#
# Steps, each printed before it runs and timed: check the tools, install the workspace's dependencies (npm ci at the
# repository root) and build this package's dist/, build the image (docker build; PDA_IMAGE names another tag, and the
# build is skipped when an image by that tag was built from this checkout's package version),
# run example 02 (`kill`) with the instances in containers, and clean up: the demo removes its containers, the run's
# directory on the disk and its token users; this script removes the tarball it packed. The image stays (one command to
# remove it is printed at the end).
#
# Environment: PDA_IMAGE (default pi-durable-archil:local), PDA_FLEET (container label and name prefix, default demo),
# PDA_REBUILD=1 to rebuild an image that exists.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
# The package lives in an npm workspace: dependencies are installed once, at the repository root.
WORKSPACE=$(cd ../.. && pwd)
grep -q '"workspaces"' "$WORKSPACE/package.json" 2>/dev/null || { printf 'quickstart: %s is not the workspace root of this package\n' "$WORKSPACE" >&2; exit 1; }
IMAGE=${PDA_IMAGE:-pi-durable-archil:local}
FLEET=${PDA_FLEET:-demo}
SCENARIO=kill
if [ "${1:-}" = kill ] || [ "${1:-}" = freeze ]; then SCENARIO=$1; shift; fi
T0=$(date +%s)
STEPS=()

step() { printf '\n==> %s\n' "$*"; STEP_START=$(date +%s); }
done_step() { local s=$(( $(date +%s) - STEP_START )); STEPS+=("$1: ${s}s"); printf '    (%s s)\n' "$s"; }
show() { printf '    $ %s\n' "$*"; }
die() { printf '\nquickstart: %s\n' "$*" >&2; exit 1; }

# ---- 1. tools --------------------------------------------------------------------------------------------------------
step "check: Node 22.19 or later, a Docker daemon that answers, the Archil key, disk and region"
command -v node >/dev/null || die "node is not installed (https://nodejs.org, 22.19 or later)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "Node $(node --version) is too old: install 22.19 or later"
command -v docker >/dev/null || die "docker is not installed (Docker Desktop, OrbStack, Colima or Docker Engine)"
docker info --format '{{.ID}}' >/dev/null 2>&1 || die "docker does not answer: start Docker Desktop, OrbStack or Colima (or the docker service)"
[ -n "${ARCHIL_API_KEY:-}" ] || die "ARCHIL_API_KEY is empty: create an API key in the Archil console and export it"
[ -n "${ARCHIL_DISK:-}" ] || die "ARCHIL_DISK is empty: export the id of a disk for scratch runs (dsk-...)"
[ -n "${ARCHIL_REGION:-}" ] || die "ARCHIL_REGION is empty: export the disk's region (e.g. aws-us-east-1)"
case "$ROOT" in
  "$HOME"/*) ;;
  *) printf '    note: %s is outside your home directory; Colima shares only $HOME with its VM by default\n' "$ROOT" ;;
esac
printf '    node %s, docker %s (%s), disk %s in %s; the key is read from $ARCHIL_API_KEY and never printed\n' \
  "$(node --version)" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)" \
  "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)" "$ARCHIL_DISK" "$ARCHIL_REGION"
if docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=apparmor'; then
  echo "    the docker daemon applies AppArmor, whose default profile denies the mount archil needs:"
  echo "    the driver starts each container with --security-opt apparmor=unconfined"
else
  echo "    the docker daemon applies no AppArmor profile: the driver passes no AppArmor option"
fi
done_step check

# ---- 2. dependencies -------------------------------------------------------------------------------------------------
step "install the workspace's dependencies and build this package's dist/"
if [ -d "$WORKSPACE/node_modules" ] && [ -f dist/cli.js ]; then
  echo "    node_modules/ and dist/ exist; skipped (rm -rf $WORKSPACE/node_modules dist to redo)"
else
  show "(cd $WORKSPACE && npm ci --ignore-scripts)"
  (cd "$WORKSPACE" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
  show npm run build
  npm run build --silent
fi
done_step npm

# ---- 3. the image ----------------------------------------------------------------------------------------------------
step "build the image $IMAGE (Node 24, the archil client checked by sha256, FUSE, the package)"
packed=""
# The image's package has to be this checkout's: the host side of the demo runs from this checkout.
version=$(node -p 'require("./package.json").version')
have=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)
[ "$have" = "<no value>" ] && have=""
if [ "$have" = "$version" ] && [ "${PDA_REBUILD:-}" != 1 ]; then
  echo "    $IMAGE exists, built from version $version; skipped (PDA_REBUILD=1 rebuilds it)"
else
  if [ "${PDA_REBUILD:-}" != 1 ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "    $IMAGE holds version ${have:-unknown}; this checkout is $version: rebuilding"
  fi
  rm -f docker/package/parcha-pi-durable-archil-*.tgz
  show npm pack --pack-destination docker/package
  packed=$(npm pack --pack-destination docker/package --loglevel=error | tail -1)
  show docker build -f docker/Dockerfile --label "org.opencontainers.image.version=$version" -t "$IMAGE" .
  docker build -f docker/Dockerfile --label "org.opencontainers.image.version=$version" -t "$IMAGE" . | sed 's/^/    /'
fi
printf '    image %s: %s, %s\n' "$IMAGE" "$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')" "$(docker image ls "$IMAGE" --format '{{.Size}}' | head -1)"
done_step image

# ---- 4. the demo -----------------------------------------------------------------------------------------------------
step "run example 02 ($SCENARIO): six paid charges, host A taken away during the third, host B finishes"
echo "    every instance is a container started with --device /dev/fuse --cap-add SYS_ADMIN --security-opt"
echo "    no-new-privileges (and the AppArmor option above, where it applies); the agent's commands run as uid 1500"
echo "    with no capabilities; the mount token is copied into the container as a root-only file and never appears"
echo "    in its configuration; the API key stays in this shell"
show node examples/02-paid-effect/demo.ts "$SCENARIO" --host docker --image "$IMAGE" --fleet "$FLEET" "$@"
set +e
# NODE_NO_WARNINGS: Node calls node:sqlite (pi's store) experimental on every start; it is harmless.
NODE_NO_WARNINGS=1 node examples/02-paid-effect/demo.ts "$SCENARIO" --host docker --image "$IMAGE" --fleet "$FLEET" "$@"
demo=$?
set -e
done_step demo

# ---- 5. cleanup ------------------------------------------------------------------------------------------------------
step "clean up"
[ -n "$packed" ] && rm -f "docker/package/$packed" && echo "    removed docker/package/$packed"
left=$(docker ps -a --filter "label=pda.fleet=$FLEET" --format '{{.Names}}' | tr '\n' ' ')
echo "    containers labeled pda.fleet=$FLEET left: ${left:-none}"
echo "    the image stays; remove it with: docker image rm $IMAGE"
done_step cleanup

printf '\nquickstart: %s in %s s (%s)\n' "$([ $demo -eq 0 ] && echo passed || echo FAILED)" "$(( $(date +%s) - T0 ))" "$(IFS=,; echo "${STEPS[*]}")"
exit $demo
