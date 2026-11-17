#!/bin/sh
# AgentRun's installer, for macOS and Linux (x64, arm64):
#
#   curl -fsSL https://agentrun.ai/install | sh
#   curl -fsSL https://agentrun.ai/install | sh -s -- --version 0.4.11 --no-start
#
# It brings its own Node.js: the launcher's engines floor (`>=X.Y.Z`, the security release it needs), downloaded from
# nodejs.org and checked against that release's SHASUMS256.txt, into ~/.agentrun/node/vX.Y.Z. It installs
# @parcha/agentrun, and the server it depends on, with that Node into ~/.agentrun/lib/<version>, and writes
# ~/.agentrun/bin/agentrun, which always runs that Node. The node, nvm, Homebrew or global npm on this machine are never
# used or changed. ~/.agentrun is also the server's data directory: the installer keeps to bin, lib, node and logs, names
# the server never uses. No sudo. Running it again installs the version asked for (the latest by default) and keeps the
# one before it.
#
# Then it starts AgentRun as a service of this user (`agentrun service install`: launchd on macOS, systemd --user on
# Linux), so it keeps running after the terminal closes and starts again at login. Where this user has no service
# manager (a container, say), it starts AgentRun in this terminal instead. Options: --help.
#
# The whole script is one function, called on its last line, so a download cut short runs nothing.

set -eu

main() {
  registry=https://registry.npmjs.org
  package=@parcha/agentrun
  version=latest
  tarball=
  start=default

  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || fail "--version takes a version or npm tag"; version=$2; shift ;;
      --version=*) version=${1#--version=} ;;
      --package) [ $# -ge 2 ] || fail "--package takes a tarball"; tarball=$2; shift ;;
      --package=*) tarball=${1#--package=} ;;
      --no-start) start=none ;;
      --service) start=service ;;
      -h | --help) usage; return 0 ;;
      *) fail "unknown option $1 (see --help)" ;;
    esac
    shift
  done

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

  mkdir -p "$root"
  chmod 700 "$root"
  # Every download and build lands in a folder beside its final place, so each one moves in whole, in one rename.
  work=$(mktemp -d "$root/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  node_dir=$root/node/v$floor
  if [ -x "$node_dir/bin/node" ] && [ "$("$node_dir/bin/node" --version 2>/dev/null)" = "v$floor" ]; then
    say "Node.js $floor is already in $node_dir"
  else
    install_node
  fi

  lib_dir=$root/lib/$version
  say "Installing $package $version with Node.js $floor ..."
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
  mkdir -p "$root/lib"
  replace "$work/lib" "$lib_dir"

  # The command: this version on this Node, whatever node is on PATH. Its Node goes first on PATH too, as the server's own
  # launcher and the harness installs run `node` and `npm` by name.
  shim=$root/bin/agentrun
  previous_lib=
  previous_node=
  if [ -f "$shim" ]; then
    previous_lib=$(sed -n "s/^# lib: //p" "$shim")
    previous_node=$(sed -n "s/^# node: //p" "$shim")
  fi
  mkdir -p "$root/bin" "$root/logs"
  cat > "$work/agentrun" <<EOF
#!/bin/sh
# AgentRun $version on its own Node.js $floor, written by the AgentRun installer (https://agentrun.ai/install).
# lib: $lib_dir
# node: $node_dir
PATH='$node_dir/bin':"\$PATH"
export PATH
exec '$node_dir/bin/node' '$entry' "\$@"
EOF
  chmod 755 "$work/agentrun"
  mv -f "$work/agentrun" "$shim"
  "$shim" help > /dev/null 2>&1 || fail "$shim does not run: $("$shim" help 2>&1 | tail -n 3)"
  say "Installed AgentRun $version (Node.js $floor) in $root"

  # Every other version goes, except the one this replaced, which a server started before this may still be running.
  prune "$root/lib" "$lib_dir" "$previous_lib"
  prune "$root/node" "$node_dir" "$previous_node"

  add_to_path

  case $start in
    none)
      say ""
      say "Start it: $(shown_shim) service install    (keeps running, starts again at login)"
      say "      or: $(shown_shim)                    (in this terminal; Ctrl-C stops it)"
      ;;
    service)
      "$shim" service install
      ;;
    default)
      # A service already installed restarts on this version; status exits 3 when there is none.
      code=0
      "$shim" service status > /dev/null 2>&1 || code=$?
      if [ "$code" = 0 ] || [ "$code" = 1 ]; then
        "$shim" service restart
      elif [ "$code" = 3 ] && service_manager; then
        "$shim" service install
      else
        [ "$code" = 3 ] || why="AgentRun $version has no service command"
        say "AgentRun can't run as a service here ($why), so it runs in this terminal: Ctrl-C stops it."
        rm -rf "$work"
        trap - EXIT
        exec "$shim"
      fi
      ;;
  esac
}

usage() {
  cat <<'EOF'
AgentRun's installer, for macOS and Linux (x64, arm64):

  curl -fsSL https://agentrun.ai/install | sh
  curl -fsSL https://agentrun.ai/install | sh -s -- [options]

It installs AgentRun, with a Node.js of its own, in ~/.agentrun, and starts it as a service of this user (launchd on
macOS, systemd --user on Linux), which keeps running after the terminal closes. Where there is no service manager, it
starts AgentRun in this terminal.

Options:
  --version V     the @parcha/agentrun version or npm tag to install (default: latest)
  --package FILE  install the launcher from FILE, a tarball `npm pack` made, in place of the registry's
  --no-start      install only
  --service       install the service, and fail if this machine can't run one
  -h, --help      this help
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

install_node() {
  base=node-v$floor-$os-$arch$suffix
  say "Downloading Node.js $floor ($os-$arch$suffix) from nodejs.org ..."
  download "https://nodejs.org/dist/v$floor/$base.tar.gz" > "$work/$base.tar.gz" || fail "could not download $base.tar.gz"
  download "https://nodejs.org/dist/v$floor/SHASUMS256.txt" > "$work/SHASUMS256.txt" || fail "could not download Node.js $floor's SHASUMS256.txt"
  expected=$(awk -v file="$base.tar.gz" '$2 == file { print $1 }' "$work/SHASUMS256.txt")
  [ -n "$expected" ] || fail "SHASUMS256.txt of Node.js $floor lists no $base.tar.gz"
  [ "$(sha256 "$work/$base.tar.gz")" = "$expected" ] || fail "$base.tar.gz does not match its SHA-256 in SHASUMS256.txt; nothing was installed"
  say "Checked $base.tar.gz against SHASUMS256.txt"
  tar -xzf "$work/$base.tar.gz" -C "$work"
  [ "$("$work/$base/bin/node" --version)" = "v$floor" ] || fail "the Node.js downloaded does not run here"
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

# Removes every folder in $1 but $2 and $3.
prune() {
  for dir in "$1"/*; do
    [ -d "$dir" ] || continue
    [ "$dir" = "$2" ] || [ "$dir" = "$3" ] || rm -rf "$dir"
  done
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
