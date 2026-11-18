#!/bin/sh
# AgentRun's installer, for macOS and Linux (x64, arm64):
#
#   curl -fsSL https://agentrun.ai/install | sh
#   curl -fsSL https://agentrun.ai/install | sh -s -- --version 0.4.11 --no-start
#
# It brings its own Node.js: the newest release on the major line of the launcher's engines floor (`>=X.Y.Z`, the
# security release it needs) that is at least that floor, as nodejs.org/dist/index.json lists them, so later security
# releases come with the next install. It is downloaded from nodejs.org and checked against that release's
# SHASUMS256.txt, into ~/.agentrun/node/vX.Y.Z. It installs @parcha/agentrun, and the server it depends on, with that Node
# into ~/.agentrun/lib/<version>, and writes ~/.agentrun/bin/agentrun, which always runs that Node. The node, nvm,
# Homebrew or global npm on this machine are never used or changed. ~/.agentrun is also the server's data directory: the
# installer keeps to bin, lib, node, logs and agentrun.pid, names the server never uses. No sudo. Running it again
# installs the version asked for (the latest by default) and removes the others, except one a running server still uses.
#
# Then it starts AgentRun as a service of this user (`agentrun service install`: launchd on macOS, systemd --user on
# Linux), so it keeps running after the terminal closes and starts again at login. Where this user has no service
# manager (a container, say), it starts AgentRun in the background until the machine stops (`agentrun stop` stops it).
# Either way it returns once AgentRun answers, and prints its address. With --tailscale it is also served over HTTPS on
# the person's own tailnet (lib/tailscale.mjs), on port 7340. Options: --help.
#
# With --vps it sets up a Linux server someone rents (Ubuntu or Debian, as root) in place of this user's install: Docker
# Engine and its compose plugin from Docker's apt repository when Docker is missing (an existing Docker is never
# changed), then /opt/agentrun with a compose file and an .env (mode 600) holding the API token and the seal key, made
# once and kept. Docker Compose runs the release's published server image with this machine's Docker socket, so a run's
# computer can be a Docker sandbox. It is private: on the person's tailnet when Tailscale is logged in (the same
# lib/tailscale.mjs, run in that image with this machine's tailscale and its socket), else on loopback with the steps to
# add Tailscale; on every address only with --public. Running it again upgrades to the release it names.
#
# The whole script is one function, called on its last line, so a download cut short runs nothing.

set -eu

main() {
  registry=https://registry.npmjs.org
  package=@parcha/agentrun
  version=latest
  tarball=
  node_version=
  start=default
  ts_flag=
  vps=
  vps_public=
  image=
  this_computer=

  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || fail "--version takes a version or npm tag"; version=$2; shift ;;
      --version=*) version=${1#--version=} ;;
      --package) [ $# -ge 2 ] || fail "--package takes a tarball"; tarball=$2; this_computer=--package; shift ;;
      --package=*) tarball=${1#--package=}; this_computer=--package ;;
      --node-version) [ $# -ge 2 ] || fail "--node-version takes a Node.js version"; node_version=${2#v}; this_computer=--node-version; shift ;;
      --node-version=*) node_version=${1#--node-version=}; node_version=${node_version#v}; this_computer=--node-version ;;
      --no-start) start=none; this_computer=$1 ;;
      --service) start=service; this_computer=$1 ;;
      --tailscale | --no-tailscale) ts_flag=$1; this_computer=$1 ;;
      --vps) vps=1 ;;
      --public) vps_public=1 ;;
      --image) [ $# -ge 2 ] || fail "--image takes an image"; image=$2; shift ;;
      --image=*) image=${1#--image=} ;;
      -h | --help) usage; return 0 ;;
      *) fail "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  if [ -n "$vps" ]; then
    [ -z "$this_computer" ] || fail "$this_computer is for an install on this computer; --vps runs AgentRun in Docker (see --help)"
    vps_install
    return 0
  fi
  [ -z "$vps_public$image" ] || fail "--public and --image go with --vps (see --help)"
  if [ -n "$node_version" ] && ! printf '%s\n' "$node_version" | grep -qx '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'; then
    fail "--node-version $node_version is not a Node.js version (X.Y.Z)"
  fi

  [ -n "${HOME:-}" ] || fail "HOME is not set"
  case $HOME in *"'"*) fail "HOME ($HOME) has a single quote in it, and the command this writes quotes paths with one" ;; esac
  [ "$(id -u)" != 0 ] || say "Note: installing as root, into $HOME/.agentrun. AgentRun runs as the user who installs it."

  detect_platform
  need tar
  need gzip
  root=$HOME/.agentrun

  # The launcher's version and its Node floor: from the tarball given, or from the registry's document for that version.
  if [ -n "$tarball" ]; then
    [ -f "$tarball" ] || fail "--package $tarball: no such file"
    case $tarball in /*) ;; *) tarball=$(pwd)/$tarball ;; esac
    manifest=$(tar -xzOf "$tarball" package/package.json | tr -d '\n\r\t ') || fail "--package $tarball is not an npm package tarball"
    spec=$tarball
  else
    case $version in *[!A-Za-z0-9.+-]*) fail "--version $version is not a version or npm tag" ;; esac
    manifest=$(download "$registry/@parcha%2fagentrun/$version") || fail "$package has no version or tag $version on $registry"
  fi
  # The manifest, one JSON member a line: enough to read its own name, version and engines.node without a JSON parser.
  members=$(printf '%s' "$manifest" | tr ',{}' '\n\n\n')
  printf '%s\n' "$members" | grep -qx "\"name\":\"$package\"" || fail "the package to install is not $package"
  version=$(printf '%s\n' "$members" | sed -n 's/^"version":"\([^"]*\)"$/\1/p' | sort -u)
  case $version in "" | *[!A-Za-z0-9.+-]*) fail "$package names no single version" ;; esac
  floor=$(printf '%s\n' "$members" | awk 'engines && /^"node":/ { print; exit } { engines = ($0 == "\"engines\":") }' |
    sed -n 's/^"node":">=\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"$/\1/p')
  [ -n "$floor" ] || fail "$package $version names no Node.js floor (engines.node \">=X.Y.Z\")"
  [ -n "$tarball" ] || spec=$package@$version
  if [ -n "$node_version" ] && ! at_least "$node_version" "$floor"; then
    fail "--node-version $node_version is below the Node.js $package $version needs, $floor"
  fi

  mkdir -p "$root"
  chmod 700 "$root"
  # Every download and build lands in a folder beside its final place, so each one moves in whole, in one rename.
  work=$(mktemp -d "$root/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -n "$node_version" ]; then
    say "Node.js $node_version, as --node-version asks"
  else
    resolve_node
    say "Node.js $node_version, the newest ${floor%%.*}.x at or above $floor"
  fi
  node_dir=$root/node/v$node_version
  if [ -x "$node_dir/bin/node" ] && [ "$("$node_dir/bin/node" --version 2>/dev/null)" = "v$node_version" ]; then
    say "Node.js $node_version is already in $node_dir"
  else
    install_node
  fi

  lib_dir=$root/lib/$version
  say "Installing $package $version with Node.js $node_version ..."
  mkdir -p "$work/lib"
  printf '{ "private": true }\n' > "$work/lib/package.json"
  # npm from this Node, with this Node first on PATH for the packages' own scripts. The person's npm config (a registry
  # mirror, a proxy) still applies, as it does to npx.
  if ! PATH="$node_dir/bin:$PATH" "$node_dir/bin/npm" install --prefix "$work/lib" --no-audit --no-fund \
    --update-notifier=false --loglevel=error "$spec" > "$work/npm.log" 2>&1; then
    tail -n 20 "$work/npm.log" >&2
    fail "npm could not install $spec (its last lines are above)"
  fi
  entry=$lib_dir/node_modules/@parcha/agentrun/bin/agentrun.mjs
  [ -f "$work/lib/node_modules/@parcha/agentrun/bin/agentrun.mjs" ] || fail "npm installed $spec without its bin/agentrun.mjs"
  printf '%s\n' "$node_dir" > "$work/lib/.node"
  mkdir -p "$root/lib"
  replace "$work/lib" "$lib_dir"

  # The command: this version on this Node, whatever node is on PATH. Its Node goes first on PATH too, as the server's own
  # launcher and the harness installs run `node` and `npm` by name.
  shim=$root/bin/agentrun
  mkdir -p "$root/bin" "$root/logs"
  cat > "$work/agentrun" <<EOF
#!/bin/sh
# AgentRun $version on its own Node.js $node_version, written by the AgentRun installer (https://agentrun.ai/install).
PATH='$node_dir/bin':"\$PATH"
export PATH
exec '$node_dir/bin/node' '$entry' "\$@"
EOF
  chmod 755 "$work/agentrun"
  mv -f "$work/agentrun" "$shim"
  "$shim" help > /dev/null 2>&1 || fail "$shim does not run: $("$shim" help 2>&1 | tail -n 3)"
  say "Installed AgentRun $version (Node.js $node_version) in $root"
  tailnet_js=$lib_dir/node_modules/@parcha/agentrun/lib/tailscale.mjs
  [ -z "$ts_flag" ] || [ -f "$tailnet_js" ] || fail "AgentRun $version has no $ts_flag; install a newer version"

  add_to_path

  case $start in
    none)
      say ""
      say "Start it: $(shown_shim) service install ${ts_flag:+$ts_flag }   (keeps running, starts again at login)"
      say "      or: $(shown_shim)                    (in this terminal; Ctrl-C stops it)"
      ;;
    service)
      stop_background
      "$shim" service install ${ts_flag:+"$ts_flag"}
      ;;
    default)
      # A service already installed restarts on this version, or installs again to go on or off the tailnet; status
      # exits 3 when there is none.
      code=0
      "$shim" service status > /dev/null 2>&1 || code=$?
      if { [ "$code" = 0 ] || [ "$code" = 1 ]; } && [ -z "$ts_flag" ]; then
        "$shim" service restart
      elif [ "$code" = 0 ] || [ "$code" = 1 ] || { [ "$code" = 3 ] && service_manager; }; then
        stop_background
        "$shim" service install ${ts_flag:+"$ts_flag"}
      else
        [ "$code" = 3 ] || why="AgentRun $version has no service command"
        say "AgentRun can't run as a service here ($why), so it runs in the background."
        start_background
      fi
      ;;
  esac

  # After the start, so the version a server ran until now goes once it has stopped.
  prune
}

usage() {
  cat <<'EOF'
AgentRun's installer, for macOS and Linux (x64, arm64):

  curl -fsSL https://agentrun.ai/install | sh
  curl -fsSL https://agentrun.ai/install | sh -s -- [options]

It installs AgentRun, with a Node.js of its own, in ~/.agentrun, and starts it as a service of this user (launchd on
macOS, systemd --user on Linux), which keeps running after the terminal closes. Where there is no service manager, it
starts AgentRun in the background until the machine stops; `agentrun stop` stops it. It returns once AgentRun answers.

Options:
  --version V       the @parcha/agentrun version or npm tag to install (default: latest)
  --package FILE    install the launcher from FILE, a tarball `npm pack` made, in place of the registry's
  --node-version V  the Node.js version to install, at least the launcher's floor (default: the newest release on the
                    floor's major line, from nodejs.org/dist/index.json)
  --no-start        install only
  --service         install the service, and fail if this machine can't run one
  --tailscale       also serve it over HTTPS on your own tailnet only, at this machine's name there
                    (tailscale serve, never Funnel; Tailscale must be installed and logged in, and it says how when
                    not); --no-tailscale takes it off
  -h, --help        this help

On a Linux server you rent (Ubuntu or Debian, as root):

  curl -fsSL https://agentrun.ai/install | sh -s -- --vps

  --vps             AgentRun in Docker Compose in /opt/agentrun, its agents' shell in Docker sandboxes. It installs
                    Docker Engine from Docker's apt repository when Docker is missing, and serves AgentRun on your
                    tailnet when Tailscale is logged in; without Tailscale, AgentRun stays on this server's loopback and
                    the installer says how to add it. Running it again upgrades AgentRun and keeps its token and seal key.
                    The server gets this machine's Docker socket, which is root on it: keep the server for AgentRun alone
  --public          with --vps: listen on every address of the server, port 7340, over plain HTTP, in place of the
                    tailnet or loopback. AGENTRUN_PUBLIC_URL names the address when the server's own is not public
  --image IMAGE     with --vps: run IMAGE in place of the release's ghcr.io/parcha-ai/agentrun-server image
  --version V       with --vps: the release of that @parcha/agentrun version or tag (default: latest)
EOF
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'agentrun install: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" > /dev/null 2>&1 || fail "it needs $1, which this machine does not have"; }

download() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL --retry 3 --proto '=https' --tlsv1.2 "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -qO- "$1"
  else
    fail "it needs curl or wget, which this machine does not have"
  fi
}

detect_platform() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "AgentRun runs on macOS and Linux; this is $(uname -s). On Windows, use WSL." ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "AgentRun's Node.js comes for x64 and arm64; this is $(uname -m)" ;;
  esac
  # A shell under Rosetta on Apple silicon says x86_64: the machine is arm64.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; fi
  # On a musl libc (Alpine), Node's musl build: nodejs.org has one for x64 only.
  suffix=
  if [ "$os" = linux ] && { ls /lib/ld-musl-* > /dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
    [ "$arch" = x64 ] || fail "nodejs.org has no Node.js for musl on $arch; use a glibc Linux"
    suffix=-musl
  fi
}

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "it needs sha256sum or shasum to check Node.js, and this machine has neither"
  fi
}

# Whether version $1 is at least version $2 (X.Y.Z each).
at_least() {
  printf '%s %s\n' "$1" "$2" | awk '{ split($1, a, "."); split($2, b, ".")
    for (i = 1; i <= 3; i++) if (a[i] + 0 != b[i] + 0) exit !(a[i] + 0 > b[i] + 0)
    exit 0 }'
}

# Of the versions on stdin (X.Y.Z, one a line), the newest on $1's major line that is at least $1.
newest_from() {
  awk -F. -v floor="$1" 'BEGIN { split(floor, f, ".") }
    $1 + 0 == f[1] + 0 && ($2 + 0 > f[2] + 0 || ($2 + 0 == f[2] + 0 && $3 + 0 >= f[3] + 0)) &&
      (best == "" || $2 + 0 > b2 || ($2 + 0 == b2 && $3 + 0 > b3)) { best = $0; b2 = $2 + 0; b3 = $3 + 0 }
    END { if (best != "") print best }'
}

# $node_version: the newest release nodejs.org builds for this platform on the floor's major line, at least the floor.
# index.json holds one release a line, its version first and its builds in "files" ("linux-x64", "osx-arm64-tar").
resolve_node() {
  case $os in darwin) build=osx-$arch-tar ;; *) build=$os-$arch$suffix ;; esac
  download https://nodejs.org/dist/index.json > "$work/index.json" ||
    fail "could not read https://nodejs.org/dist/index.json to choose a Node.js; --node-version V names one"
  node_version=$(grep -F "\"$build\"" "$work/index.json" |
    sed -n 's/^{"version":"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | newest_from "$floor")
  [ -n "$node_version" ] || fail "nodejs.org lists no Node.js ${floor%%.*}.x at or above $floor built for $build"
}

install_node() {
  base=node-v$node_version-$os-$arch$suffix
  say "Downloading Node.js $node_version ($os-$arch$suffix) from nodejs.org ..."
  download "https://nodejs.org/dist/v$node_version/$base.tar.gz" > "$work/$base.tar.gz" || fail "could not download $base.tar.gz"
  download "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" > "$work/SHASUMS256.txt" || fail "could not download Node.js $node_version's SHASUMS256.txt"
  expected=$(awk -v file="$base.tar.gz" '$2 == file { print $1 }' "$work/SHASUMS256.txt")
  [ -n "$expected" ] || fail "SHASUMS256.txt of Node.js $node_version lists no $base.tar.gz"
  [ "$(sha256 "$work/$base.tar.gz")" = "$expected" ] || fail "$base.tar.gz does not match its SHA-256 in SHASUMS256.txt; nothing was installed"
  say "Checked $base.tar.gz against SHASUMS256.txt"
  tar -xzf "$work/$base.tar.gz" -C "$work"
  [ "$("$work/$base/bin/node" --version)" = "v$node_version" ] || fail "the Node.js downloaded does not run here"
  mkdir -p "$root/node"
  replace "$work/$base" "$node_dir"
}

# Moves the folder $1 to $2, in place of what $2 held.
replace() {
  if [ -e "$2" ]; then
    mv "$2" "$work/old"
    mv "$1" "$2"
    rm -rf "$work/old"
  else
    mv "$1" "$2"
  fi
}

# Removes every other version in lib/ and node/ unless a running process names it on its command line: a server started
# before this install keeps its files until it stops, and its Node (lib/<version>/.node). Without ps, removes nothing.
prune() {
  running=$(ps -A -o args= 2> /dev/null) || return 0
  keep_node=$node_dir
  for dir in "$root/lib"/*; do
    [ -d "$dir" ] || continue
    if [ "$dir" = "$lib_dir" ] || in_use "$dir"; then
      [ -f "$dir/.node" ] && keep_node="$keep_node
$(cat "$dir/.node")"
    else
      rm -rf "$dir"
    fi
  done
  for dir in "$root/node"/*; do
    [ -d "$dir" ] || continue
    printf '%s\n' "$keep_node" | grep -qxF "$dir" || in_use "$dir" || rm -rf "$dir"
  done
}

in_use() {
  case $running in *"$1/"*) return 0 ;; esac
  return 1
}

# Whether this user has a service manager AgentRun can be a service of; $why says why not.
service_manager() {
  why=
  if [ "$os" = darwin ]; then
    launchctl print "gui/$(id -u)" > /dev/null 2>&1 && return 0
    why="no launchd session for this user: a login over ssh has none"
  else
    command -v systemctl > /dev/null 2>&1 || { why="no systemd"; return 1; }
    systemctl --user show-environment > /dev/null 2>&1 && return 0
    why="no systemd user session"
  fi
  return 1
}

# Whether process $1 runs, from /proc where there is one (a container may have no ps), else from ps. A process that ended
# is a zombie until its parent reaps it, and in a container with no init nothing does, so a zombie has ended. $args is
# its command line.
alive() {
  case $1 in '' | *[!0-9]* | 0 | 1) return 1 ;; esac
  if [ -r "/proc/$1/stat" ]; then
    state=$(sed 's/.*) \(.\).*/\1/' "/proc/$1/stat" 2> /dev/null)
    args=$(tr '\0' ' ' < "/proc/$1/cmdline" 2> /dev/null)
  elif [ -e /proc/self/stat ]; then
    return 1
  else
    state=$(ps -o stat= -p "$1" 2> /dev/null | tr -d ' ' | cut -c 1)
    args=$(ps -o args= -p "$1" 2> /dev/null)
  fi
  [ -n "$state" ] && [ "$state" != Z ]
}

# Whether process $1 runs this install's files: a pid file outlives a crash, and its pid can be another process's by now.
ours() {
  alive "$1" || return 1
  case $args in *"$root/"*) return 0 ;; esac
  return 1
}

# Stops the AgentRun an earlier install started in the background, so only one server uses ~/.agentrun. The installer does
# it itself, as `agentrun stop` does, since the version installed may have no `agentrun stop`: a SIGTERM to the launcher,
# which passes it on to its server (the pid in .server.json) and waits for it. Both get 45 s, past the server's 30 s
# drain, then a SIGKILL; one that outlives that fails the install, so a second server never starts beside it.
stop_background() {
  bg=$(cat "$root/agentrun.pid" 2> /dev/null) || return 0
  if ours "$bg"; then
    server=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$root/.server.json" 2> /dev/null | head -n 1)
    say "Stopping the AgentRun started in the background before (pid $bg) ..."
    kill -s TERM "$bg" 2> /dev/null || true
    waited=0
    while { ours "$bg" || ours "$server"; } && [ "$waited" -lt 45 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if ours "$bg" || ours "$server"; then
      # Started with setsid, it leads a process group, the server's too.
      kill -s KILL -- "-$bg" 2> /dev/null || true
      for each in $bg $server; do
        if ours "$each"; then kill -s KILL "$each" 2> /dev/null || true; fi
      done
      sleep 1
      if ours "$bg" || ours "$server"; then
        fail "the AgentRun started before (pid $bg) still runs after a SIGKILL; stop it, then run the installer again"
      fi
    fi
  fi
  rm -f "$root/agentrun.pid"
}

# AgentRun in the background, where there is no service manager: in a session of its own where setsid is there (Linux),
# so neither the terminal closing nor a Ctrl-C to it stops AgentRun, with nothing open on this script's output, so a
# `curl | sh` returns. Its output goes to the service's log, its pid to agentrun.pid for `agentrun stop`. Waits for the
# launcher's "AgentRun is running at" line, or for it to end (it stops a server that never answers, after 60 s).
start_background() {
  # On the tailnet (--tailscale, or an earlier install's entry kept): the server takes its https address and a fixed port.
  # Checked before the AgentRun running now stops, so a refusal (Funnel on there) leaves it running.
  [ -n "$ts_flag" ] || [ ! -f "$root/tailscale.json" ] || [ ! -f "$tailnet_js" ] || ts_flag=--tailscale
  set -- --no-open
  public=
  if [ "$ts_flag" = --no-tailscale ]; then
    tailnet off
  elif [ "$ts_flag" = --tailscale ]; then
    set -- --no-open --port 7340
    public=$(tailnet address 7340) || exit 1
  fi
  stop_background
  log=$root/logs/agentrun.log
  touch "$log"
  from=$(($(wc -c < "$log") + 1))
  launch=
  command -v setsid > /dev/null 2>&1 && launch=setsid
  if [ -n "$public" ]; then
    AGENTRUN_PUBLIC_URL=$public AGENTRUN_TRUSTED_PROXIES=loopback nohup $launch "$shim" "$@" < /dev/null >> "$log" 2>&1 &
  else
    nohup $launch "$shim" "$@" < /dev/null >> "$log" 2>&1 &
  fi
  pid=$!
  printf '%s\n' "$pid" > "$root/agentrun.pid"
  url=
  waited=0
  while [ "$waited" -lt 120 ]; do
    url=$(tail -c "+$from" "$log" | sed -n 's/^AgentRun is running at //p' | head -n 1)
    [ -z "$url" ] || break
    alive "$pid" || break
    sleep 1
    waited=$((waited + 1))
  done
  if [ -z "$url" ]; then
    tail -c "+$from" "$log" | tail -n 20 >&2
    kill "$pid" 2> /dev/null || true
    fail "AgentRun did not start (its last lines are above, and all of them are in $log)"
  fi
  # The launcher names the https address it was given; on this machine it is the loopback one, in the server's record,
  # until serve is on.
  here=
  [ -z "$public" ] || here=$(sed -n 's/.*"base_url": *"\(http[^"]*\)\/v2".*/\1\//p' "$root/.server.json" 2> /dev/null | head -n 1)
  [ -z "$here" ] || url=$here
  say "AgentRun is running at $url"
  say "It runs in the background until this machine or container stops. $(shown_shim) stop stops it; its log is $log."
  [ -z "$public" ] || tailnet serve 7340 "$public" || exit 1
}

# tailscale.mjs of the version installed, on its Node: `address PORT`, `serve PORT URL` or `off`.
tailnet() {
  verb=$1
  shift
  "$node_dir/bin/node" "$tailnet_js" "$verb" "${1:-}" "curl -fsSL https://agentrun.ai/install | sh -s -- $ts_flag" "${2:-}"
}

shown_shim() {
  case ":$PATH:" in *":$root/bin:"*) printf agentrun ;; *) printf '%s' "$shim" ;; esac
}

# One line in the shell's startup file puts ~/.agentrun/bin on PATH, when no line there does yet.
add_to_path() {
  case ":$PATH:" in *":$root/bin:"*) return 0 ;; esac
  line='export PATH="$HOME/.agentrun/bin:$PATH"'
  case $(basename "${SHELL:-sh}") in
    zsh) rc=${ZDOTDIR:-$HOME}/.zshrc ;;
    bash) if [ "$os" = darwin ]; then rc=$HOME/.bash_profile; else rc=$HOME/.bashrc; fi ;;
    fish)
      rc=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/agentrun.fish
      line='fish_add_path --global "$HOME/.agentrun/bin"'
      mkdir -p "$(dirname "$rc")"
      ;;
    *) rc=$HOME/.profile ;;
  esac
  if grep -qs '\.agentrun/bin' "$rc"; then
    say "$rc already puts ~/.agentrun/bin on PATH; a new terminal will have agentrun."
    return 0
  fi
  printf '\n%s\n' "$line" >> "$rc"
  say "Added ~/.agentrun/bin to PATH in $rc. A new terminal will have agentrun; in this one, run:"
  say "  $line"
}

# --vps: AgentRun in Docker Compose in /opt/agentrun on a server someone rents, as root. As Coolify's and Dokploy's
# one-line installers do: Docker when it is missing, secrets made once with openssl into an .env that later runs keep.
vps_install() {
  vps_dir=/opt/agentrun
  port=7340
  again="curl -fsSL https://agentrun.ai/install | sh -s -- --vps${vps_public:+ --public}"
  [ "$(uname -s)" = Linux ] || fail "--vps sets up a Linux server; this is $(uname -s)"
  [ "$(id -u)" = 0 ] || fail "--vps installs Docker and writes $vps_dir, so it runs as root: curl -fsSL https://agentrun.ai/install | sudo sh -s -- --vps${vps_public:+ --public}"
  need curl
  mkdir -p -m 700 "$vps_dir" "$vps_dir/tailscale"
  chmod 700 "$vps_dir"
  work=$(mktemp -d "$vps_dir/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  vps_image
  vps_docker
  command -v openssl > /dev/null 2>&1 || vps_apt install openssl

  if ! docker image inspect "$image" > /dev/null 2>&1; then
    say "Pulling $image ..."
    docker pull -q "$image" > /dev/null || fail "could not pull $image"
  fi

  # Where it is reached: every address with --public; else the tailnet's https address when Tailscale is logged in, or
  # this server's loopback, with the steps to add Tailscale said.
  bind=127.0.0.1 # key-gate: loopback-rule the port is published on this server's loopback unless --public
  trusted=
  if [ -n "$vps_public" ]; then
    bind=0.0.0.0
    url=${AGENTRUN_PUBLIC_URL:-}
    if [ -z "$url" ]; then
      address=$(ip -4 route get 1.1.1.1 2> /dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
      [ -n "$address" ] || fail "--public: this server's IPv4 address is unknown (ip route get); name it, then run again: curl -fsSL https://agentrun.ai/install | AGENTRUN_PUBLIC_URL=http://<address>:$port/ sh -s -- --vps --public"
      url=http://$address:$port/
    fi
    say "--public: AgentRun listens on every address of this server, port $port, over plain HTTP, at $url"
    say "  Anyone who reaches that address reaches its console and API, and the setup code, your password and the API"
    say "  token cross the network unencrypted. Run again without --public to use Tailscale, or put a TLS proxy in front."
  else
    url=$(vps_tailnet address) || exit 1
    if [ -n "$url" ]; then
      # tailscale serve reaches the server through Docker's bridge, a private range, and names each visitor.
      trusted=uniquelocal
    else
      url=http://127.0.0.1:$port/ # key-gate: loopback-rule the server's address on this server alone
    fi
  fi

  vps_files
  say "Starting AgentRun $release in Docker Compose ($vps_dir) ..."
  if ! vps_compose up -d --wait --wait-timeout 300 > "$work/up.log" 2>&1; then
    tail -n 20 "$work/up.log" >&2
    vps_compose logs --no-color --tail 40 agentrun >&2 || true
    fail "AgentRun did not come up healthy within 5 minutes (the lines above say why; cd $vps_dir && docker compose logs has them all)"
  fi

  # Its first visit must ask for the setup code: a server that would take a password from anyone is stopped.
  host=${url#*://}
  host=${host%%/*}
  session=$(curl -fsS --max-time 10 -H "Host: $host" "http://127.0.0.1:$port/v2/auth/session") || session=
  owned=
  case $session in
    *'"password_set":true'* | *'"password_set": true'*) owned=1 ;;
    *'"setup_code":true'* | *'"setup_code": true'*) ;;
    *)
      vps_compose stop > /dev/null 2>&1 || true
      fail "AgentRun answered with no setup code asked (${session:-no answer}), so whoever reached it first could take it; it was stopped"
      ;;
  esac

  if [ "$trusted" = uniquelocal ]; then
    vps_tailnet serve "$url" "\`docker compose logs\` in $vps_dir" || exit 1
  fi

  say ""
  say "AgentRun $release is running at $url"
  if [ "$bind" != 0.0.0.0 ] && [ -z "$trusted" ]; then
    say "It is on this server only. From your computer: ssh -N -L $port:127.0.0.1:$port root@<this server>, then open $url"
  fi
  if [ -n "$owned" ]; then
    say "This server has its owner: sign in at $url"
  else
    # A good code is kept and a new one printed only when the last is expired or spent (POST /v2/setup/code).
    curl -fsS --max-time 10 -X POST -H "Host: $host" "http://127.0.0.1:$port/v2/setup/code" > /dev/null 2>&1 || true
    line=
    waited=0
    while [ -z "$line" ] && [ "$waited" -lt 10 ]; do
      line=$(vps_compose logs --no-color --no-log-prefix agentrun 2> /dev/null | sed -n 's/.*\(Set up this server: .*\)$/\1/p' | tail -n 1)
      [ -n "$line" ] || sleep 1
      waited=$((waited + 1))
    done
    say "${line:-Set up this server: its link is in the log (below)}"
    say "The code works once, for 30 minutes. Read the newest one later: cd $vps_dir && docker compose logs agentrun | grep 'Set up this server' | tail -n 1"
  fi
  say "The API token is AGENTRUN_TOKEN in $vps_dir/.env. Agents get a shell in Docker sandboxes on this server: AgentRun has"
  say "its Docker socket, which is root here, so keep this server for AgentRun alone."
}

# The image of the release asked for: the server the launcher of that version (or tag) depends on, whose release tag is
# v<that version>. --image names one in its place.
vps_image() {
  if [ -n "$image" ]; then
    release=$image
    return 0
  fi
  case $version in *[!A-Za-z0-9.+-]*) fail "--version $version is not a version or npm tag" ;; esac
  manifest=$(download "$registry/@parcha%2fagentrun/$version") || fail "$package has no version or tag $version on $registry"
  server=$(printf '%s' "$manifest" | tr ',{}' '\n\n\n' | sed -n 's/^"@parcha\/agentrun-serve":"\([^"]*\)"$/\1/p' | sort -u)
  case $server in "" | *[!A-Za-z0-9.+-]*) fail "$package $version names no single server version (@parcha/agentrun-serve)" ;; esac
  release=v$server
  image=ghcr.io/parcha-ai/agentrun-server:$release
}

# Docker Engine 26 or later with its compose plugin: one already here is used as it is, never changed; with none, Docker
# Engine from Docker's own apt repository, as https://docs.docker.com/engine/install/ubuntu/ (and debian/) set it up.
vps_docker() {
  if command -v docker > /dev/null 2>&1; then
    engine=$(docker version --format '{{.Server.Version}}' 2> /dev/null) ||
      fail "Docker is installed here, and its daemon does not answer (docker version). Start it (systemctl start docker), then run again: $again"
    say "Docker Engine $engine is already here; the installer leaves it as it is."
  else
    vps_install_docker
  fi
  major=${engine%%.*}
  case $major in "" | *[!0-9]*) fail "Docker says its version is $engine, which is not Docker Engine's" ;; esac
  [ "$major" -ge 26 ] || fail "Docker sandboxes need Docker Engine 26 or later (a named volume's subpath), and this one is $engine. Upgrade it, then run again: $again"
  compose=$(docker compose version --short 2> /dev/null) ||
    fail "This Docker has no compose plugin (docker compose). Install it (https://docs.docker.com/compose/install/linux/), then run again: $again"
  say "Docker Compose $compose"
}

vps_install_docker() {
  [ -r /etc/os-release ] || fail "Docker is not installed, and this server has no /etc/os-release to say which Linux it is. Install Docker Engine 26 or later with its compose plugin (https://docs.docker.com/engine/install/), then run again: $again"
  distro=$(. /etc/os-release && printf '%s' "${ID:-}")
  codename=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
  case $distro in
    ubuntu | debian) ;;
    *) fail "Docker is not installed, and the installer installs it on Ubuntu or Debian only (this is ${distro:-unknown}). Install Docker Engine 26 or later with its compose plugin (https://docs.docker.com/engine/install/), then run again: $again" ;;
  esac
  [ -n "$codename" ] || fail "/etc/os-release names no release codename for Docker's apt repository"
  repo=https://download.docker.com/linux/$distro
  say "Installing Docker Engine and its compose plugin from Docker's apt repository ($repo) ..."
  vps_apt update
  vps_apt install ca-certificates
  if grep -qs download.docker.com /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    say "Docker's apt repository is already in this server's apt sources; installing from it."
  else
    install -m 0755 -d /etc/apt/keyrings
    download "$repo/gpg" > "$work/docker.asc" || fail "could not download $repo/gpg"
    install -m 0644 "$work/docker.asc" /etc/apt/keyrings/docker.asc
    printf 'Types: deb\nURIs: %s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
      "$repo" "$codename" "$(dpkg --print-architecture)" > "$work/docker.sources"
    install -m 0644 "$work/docker.sources" /etc/apt/sources.list.d/docker.sources
    vps_apt update
  fi
  vps_apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  waited=0
  until engine=$(docker version --format '{{.Server.Version}}' 2> /dev/null); do
    [ "$waited" -lt 30 ] || fail "Docker Engine is installed, and its daemon does not answer (systemctl status docker says why)"
    sleep 1
    waited=$((waited + 1))
  done
  say "Installed Docker Engine $engine"
}

vps_apt() {
  if ! DEBIAN_FRONTEND=noninteractive apt-get -y -qq -o Dpkg::Use-Pty=0 "$@" > "$work/apt.log" 2>&1; then
    tail -n 20 "$work/apt.log" >&2
    fail "apt-get $* failed (its last lines are above)"
  fi
}

vps_compose() { (cd "$vps_dir" && docker compose "$@"); }

# lib/tailscale.mjs of the image, run in it as root with this server's tailscale and its socket: `address`, or `serve URL
# LOG`. Its record of the serve entry is kept in $vps_dir/tailscale.
vps_tailnet() {
  verb=$1
  shift
  ts=$(command -v tailscale 2> /dev/null) || ts=
  sock=
  [ -z "$ts" ] || [ ! -d /var/run/tailscale ] || sock=/var/run/tailscale
  docker run --rm --network none --user 0:0 -e HOME=/root -v "$vps_dir/tailscale:/root/.agentrun" \
    ${ts:+-v} ${ts:+"$ts:/usr/local/bin/tailscale:ro"} ${sock:+-v} ${sock:+"$sock:$sock"} \
    --entrypoint node "$image" /opt/agentrun/packages/agentrun/lib/tailscale.mjs "$verb" "$port" "$again" "$@"
}

# .env: the token and the seal key made once and kept, then the settings this run chose; any other line stays as it is.
# compose.yaml: written again on every run (changes of one's own go in compose.override.yaml beside it).
vps_files() {
  env_file=$vps_dir/.env
  token=$(sed -n 's/^AGENTRUN_TOKEN=//p' "$env_file" 2> /dev/null | tail -n 1)
  seal=$(sed -n 's/^AGENTRUN_SEAL_KEY=//p' "$env_file" 2> /dev/null | tail -n 1)
  made=
  if [ -z "$token" ]; then
    token=$(openssl rand -hex 32)
    made="the API token"
  fi
  if [ -z "$seal" ]; then
    seal=$(openssl rand -base64 32)
    made="${made:+$made and }the seal key"
  fi
  [ -n "$token" ] && [ -n "$seal" ] || fail "openssl made no API token or seal key"
  gid=$(stat -c %g /var/run/docker.sock) || fail "this Docker has no /var/run/docker.sock to give AgentRun"
  {
    if [ -f "$env_file" ]; then
      grep -v -E '^(AGENTRUN_TOKEN|AGENTRUN_SEAL_KEY|AGENTRUN_IMAGE|AGENTRUN_BIND|AGENTRUN_PUBLIC_URL|AGENTRUN_TRUSTED_PROXIES|DOCKER_GID)=' "$env_file" || true
    else
      echo "# AgentRun's settings for Docker Compose. The installer (--vps) keeps AGENTRUN_TOKEN and AGENTRUN_SEAL_KEY, and"
      echo "# writes the lines after them on every run. Lines of your own (a model key, AGENTRUN_BOX_ALLOW) stay; keep this"
      echo "# file's seal key: every saved secret is sealed under it."
    fi
    printf 'AGENTRUN_TOKEN=%s\n' "$token"
    printf 'AGENTRUN_SEAL_KEY=%s\n' "$seal"
    printf 'AGENTRUN_IMAGE=%s\n' "$image"
    printf 'AGENTRUN_BIND=%s\n' "$bind"
    printf 'AGENTRUN_PUBLIC_URL=%s\n' "$url"
    printf 'AGENTRUN_TRUSTED_PROXIES=%s\n' "$trusted"
    printf 'DOCKER_GID=%s\n' "$gid"
  } > "$work/env"
  chmod 600 "$work/env"
  mv -f "$work/env" "$env_file"
  if [ -n "$made" ]; then
    say "Made $made in $env_file (mode 600), kept on every later run"
  else
    say "Kept the API token and the seal key in $env_file"
  fi

  cat > "$work/compose.yaml" << 'EOF'
# AgentRun, written by its installer (curl -fsSL https://agentrun.ai/install | sh -s -- --vps) on every run: put changes
# of your own in compose.override.yaml beside this file, which Docker Compose reads too. .env holds the settings.
#
# The server gets this server's Docker socket, so a run's computer can be a Docker sandbox: a container beside the
# server's, with no socket, every capability dropped, no network but its egress proxy, and of the data volume only its
# run's folder. Whatever reaches that socket is root on this server: keep the server for AgentRun alone.
name: agentrun
services:
  agentrun:
    image: ${AGENTRUN_IMAGE:?run the installer again}
    ports:
      - "${AGENTRUN_BIND:?run the installer again}:7340:7340"
    volumes:
      - agentrun-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    group_add:
      - "${DOCKER_GID:?run the installer again}"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7340/v2/health').then(({ ok, status }) => { if (!ok) throw new Error(String(status)) })"] # key-gate: loopback-rule the servers own loopback, its health check
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
      start_interval: 2s
    environment:
      AGENTRUN_BOXES: docker
      AGENTRUN_BOX_ALLOW: ${AGENTRUN_BOX_ALLOW:-}
      AGENTRUN_DOCKER_HOST_ADDRESSES: ${AGENTRUN_DOCKER_HOST_ADDRESSES:-}
      AGENTRUN_SEAL_KEY: ${AGENTRUN_SEAL_KEY:?run the installer again}
      AGENTRUN_TOKEN: ${AGENTRUN_TOKEN:?run the installer again}
      AGENTRUN_TRUSTED_PROXIES: ${AGENTRUN_TRUSTED_PROXIES:-}
      AGENTRUN_PUBLIC_URL: ${AGENTRUN_PUBLIC_URL:?run the installer again}
      AGENT_MODEL: ${AGENT_MODEL:-}
      AGENT_MODEL_FAST: ${AGENT_MODEL_FAST:-}
      AGENT_MODEL_STRONG: ${AGENT_MODEL_STRONG:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      PARTICLE_API_KEY: ${PARTICLE_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      AGENT_MODEL_BASE_URL: ${AGENT_MODEL_BASE_URL:-}
      AGENT_MODEL_API_KEY: ${AGENT_MODEL_API_KEY:-}
    restart: unless-stopped
    stop_grace_period: 15s
volumes:
  agentrun-data:
EOF
  mv -f "$work/compose.yaml" "$vps_dir/compose.yaml"
}

main "$@"
