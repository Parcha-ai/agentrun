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
# Either way it returns once AgentRun answers, and prints its address. Options: --help.
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

  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || fail "--version takes a version or npm tag"; version=$2; shift ;;
      --version=*) version=${1#--version=} ;;
      --package) [ $# -ge 2 ] || fail "--package takes a tarball"; tarball=$2; shift ;;
      --package=*) tarball=${1#--package=} ;;
      --node-version) [ $# -ge 2 ] || fail "--node-version takes a Node.js version"; node_version=${2#v}; shift ;;
      --node-version=*) node_version=${1#--node-version=}; node_version=${node_version#v} ;;
      --no-start) start=none ;;
      --service) start=service ;;
      -h | --help) usage; return 0 ;;
      *) fail "unknown option $1 (see --help)" ;;
    esac
    shift
  done
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

  add_to_path

  case $start in
    none)
      say ""
      say "Start it: $(shown_shim) service install    (keeps running, starts again at login)"
      say "      or: $(shown_shim)                    (in this terminal; Ctrl-C stops it)"
      ;;
    service)
      stop_background
      "$shim" service install
      ;;
    default)
      # A service already installed restarts on this version; status exits 3 when there is none.
      code=0
      "$shim" service status > /dev/null 2>&1 || code=$?
      if [ "$code" = 0 ] || [ "$code" = 1 ]; then
        "$shim" service restart
      elif [ "$code" = 3 ] && service_manager; then
        stop_background
        "$shim" service install
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
  -h, --help        this help
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

# Stops the AgentRun an earlier install started in the background, if one runs, so only one server uses ~/.agentrun.
stop_background() {
  "$shim" stop > /dev/null 2>&1 || true
}

# AgentRun in the background, where there is no service manager: in a session of its own where setsid is there (Linux),
# so neither the terminal closing nor a Ctrl-C to it stops AgentRun, with nothing open on this script's output, so a
# `curl | sh` returns. Its output goes to the service's log, its pid to agentrun.pid for `agentrun stop`. Waits for the
# launcher's "AgentRun is running at" line, or for it to end (it stops a server that never answers, after 60 s).
start_background() {
  stop_background
  log=$root/logs/agentrun.log
  touch "$log"
  from=$(($(wc -c < "$log") + 1))
  if command -v setsid > /dev/null 2>&1; then
    nohup setsid "$shim" --no-open < /dev/null >> "$log" 2>&1 &
  else
    nohup "$shim" --no-open < /dev/null >> "$log" 2>&1 &
  fi
  pid=$!
  printf '%s\n' "$pid" > "$root/agentrun.pid"
  url=
  waited=0
  while [ "$waited" -lt 120 ]; do
    url=$(tail -c "+$from" "$log" | sed -n 's/^AgentRun is running at //p' | head -n 1)
    [ -z "$url" ] || break
    kill -0 "$pid" 2> /dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  if [ -z "$url" ]; then
    tail -c "+$from" "$log" | tail -n 20 >&2
    kill "$pid" 2> /dev/null || true
    fail "AgentRun did not start (its last lines are above, and all of them are in $log)"
  fi
  say "AgentRun is running at $url"
  say "It runs in the background until this machine or container stops. $(shown_shim) stop stops it; its log is $log."
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

main "$@"
