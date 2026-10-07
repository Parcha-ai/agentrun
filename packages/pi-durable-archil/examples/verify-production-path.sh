#!/usr/bin/env bash
# Verifies the README's "Setting up a host for production" on a DISPOSABLE root machine: a dedicated run user, the
# root-owned archil wrapper, a sudoers drop-in for exactly that wrapper and `fusermount -u`, the supervisor as root with
# `--user`, and the agent's commands under no_new_privs. It then runs example 02 (kill) the production way and checks what
# only a production host can show: the instances run as the run user and never as root, the run user can use sudo for
# the wrapper and for nothing else, no_new_privs takes even that away from a command, no mount token reaches the journal,
# and nothing is left behind.
#
#   examples/verify-production-path.sh [setup|run|teardown|all|plan]        (default: all)
#
# Run it as root on a machine you can throw away (a VM, a sandbox with systemd): it creates a user, a sudoers file and
# files under /usr/local/lib, /opt and /etc, and `teardown` removes what `setup` made. DO NOT run it on a shared machine:
# a mistake in a sudoers file breaks sudo for everyone on it (the script checks the file with visudo first).
#
# Environment:
#   ARCHIL_API_KEY, ARCHIL_DISK, ARCHIL_REGION   a scratch disk and its key (needed by `run` and `teardown`)
#   RUN_USER=pda  MOUNT_ROOT_A=/mnt/archil-a  MOUNT_ROOT_B=/mnt/archil-b  INSTALL_DIR=/opt/pi-durable-archil
#   PACKAGE_DIR   a checkout with dist/ built (`npm ci`); default: the checkout this script is in
#   NODE          a Node 22.19+ the run user can execute; default: `command -v node`
#   DRY_RUN=1     print every step instead of doing it (or use `plan`); needs no root
#   KEEP=1        with `all`, skip the teardown, to look around after a failure (then run `teardown` yourself)
# Exit codes: 0 every check passed, 1 a check failed, 2 the machine cannot run it, 3 a step failed.
set -euo pipefail

RUN_USER=${RUN_USER:-pda}
MOUNT_ROOT_A=${MOUNT_ROOT_A:-/mnt/archil-a}
MOUNT_ROOT_B=${MOUNT_ROOT_B:-/mnt/archil-b}
INSTALL_DIR=${INSTALL_DIR:-/opt/pi-durable-archil}
PACKAGE_DIR=${PACKAGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
NODE=${NODE:-$(command -v node || true)}
WRAPPER_DIR=/usr/local/lib/pi-durable-archil
WRAPPER=$WRAPPER_DIR/archil-scoped
SUDOERS=/etc/sudoers.d/pi-durable-archil
ENV_DIR=/etc/pi-durable-archil-verify
STATE=/var/lib/pi-durable-archil-verify
RUN_ID=${RUN_ID:-verify-$(date +%s)}
DRY_RUN=${DRY_RUN:-0}
FAILED=0
# Whether `setup` made a thing (always, in a dry run), so teardown removes only what setup made.
created() { [ "$DRY_RUN" = 1 ] || [ -e "$STATE/created-$1" ]; }

cmd=${1:-all}
[ "$cmd" = plan ] && { DRY_RUN=1; cmd=all; }

say() { printf '\n== %s\n' "$*"; }
# Every state-changing step goes through here, so DRY_RUN prints exactly what would run.
do_() { printf '+ %s\n' "$*"; [ "$DRY_RUN" = 1 ] || "$@"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
die() { printf 'verify-production-path: %s\n' "$*" >&2; exit "${2:-2}"; }

preflight() {
  say "preflight"
  [ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root, on a disposable machine"
  [ "$DRY_RUN" = 1 ] || [ -d /run/systemd/system ] || die "systemd is not running: the local host driver starts instances as systemd units. Use a VM, or a sandbox with systemd as PID 1"
  [ "$DRY_RUN" = 1 ] || [ -e /dev/fuse ] || die "/dev/fuse is missing: this machine cannot mount FUSE"
  for bin in /usr/bin/archil /usr/bin/fusermount /usr/bin/setpriv /usr/sbin/visudo /usr/bin/runuser /usr/bin/sudo; do
    [ "$DRY_RUN" = 1 ] || [ -x "$bin" ] || die "$bin is missing (archil client, fuse3, util-linux, sudo)"
  done
  [ -n "$NODE" ] || die "no node on the PATH: set NODE"
  [ "$DRY_RUN" = 1 ] || [ -f "$PACKAGE_DIR/dist/index.js" ] || die "$PACKAGE_DIR has no dist/: run npm ci there first"
  [ "$DRY_RUN" = 1 ] || [ -d "$PACKAGE_DIR/node_modules" ] || die "$PACKAGE_DIR has no node_modules: run npm ci there first"
  printf 'user %s, mount roots %s and %s, package %s, node %s\n' "$RUN_USER" "$MOUNT_ROOT_A" "$MOUNT_ROOT_B" "$PACKAGE_DIR" "$NODE"
}

setup() {
  preflight
  say "setup"
  do_ mkdir -p "$STATE"
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    echo "user $RUN_USER exists: left as it is, and not removed by teardown"
  else
    do_ useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
    do_ touch "$STATE/created-user"
  fi
  for root in "$MOUNT_ROOT_A" "$MOUNT_ROOT_B"; do
    [ -d "$root" ] || do_ touch "$STATE/created-root-$(basename "$root")"
    do_ mkdir -p "$root/runs"
    do_ chown "$RUN_USER" "$root/runs"
  done
  # Step 2 of the README: the wrapper, root-owned, because root executes it.
  do_ install -D -o root -g root -m 0755 "$PACKAGE_DIR/bin/archil-scoped" "$WRAPPER"
  # Step 3: the sudoers drop-in for exactly the wrapper and `fusermount -u` under the mount roots; no env_keep.
  local tmp
  if [ "$DRY_RUN" = 1 ]; then tmp=/tmp/pda-sudoers.dry; else tmp=$(mktemp); fi
  printf '%s ALL=(root) NOPASSWD: %s, /usr/bin/fusermount -u %s/runs/*, /usr/bin/fusermount -u %s/runs/*\n' "$RUN_USER" "$WRAPPER" "$MOUNT_ROOT_A" "$MOUNT_ROOT_B" > "$tmp"
  echo "sudoers drop-in:"; sed 's/^/    /' "$tmp"
  if [ "$DRY_RUN" = 1 ]; then echo "+ visudo -cf $tmp"; else visudo -cf "$tmp" >/dev/null || die "visudo rejects the drop-in; nothing was installed" 3; fi
  do_ install -o root -g root -m 0440 "$tmp" "$SUDOERS"
  do_ touch "$STATE/created-sudoers"
  rm -f "$tmp"
  # The package where the run user can read it, and Node where the run user can execute it (an nvm Node under a home directory is not).
  do_ mkdir -p "$INSTALL_DIR"
  if [ "$DRY_RUN" = 1 ]; then echo "+ tar -C $PACKAGE_DIR --exclude=.git --exclude=.tmp -cf - . | tar -C $INSTALL_DIR -xf -"; else tar -C "$PACKAGE_DIR" --exclude=.git --exclude=.tmp -cf - . | tar -C "$INSTALL_DIR" -xf -; fi
  do_ chmod -R a+rX "$INSTALL_DIR"
  do_ touch "$STATE/created-install"
  [ "$DRY_RUN" = 1 ] || runuser -u "$RUN_USER" -- "$NODE" --version >/dev/null || die "$RUN_USER cannot execute $NODE: install Node system-wide (not under a home directory) and set NODE" 3
  # Step 4: the API key in a root-only file the supervisor's environment is loaded from; never through sudo, which logs it.
  do_ install -d -o root -g root -m 0700 "$ENV_DIR"
  if [ "$DRY_RUN" = 1 ]; then echo "+ (umask 077; write ARCHIL_API_KEY, ARCHIL_DISK, ARCHIL_REGION to $ENV_DIR/supervisor.env)"; else
    : "${ARCHIL_API_KEY:?}" "${ARCHIL_DISK:?}" "${ARCHIL_REGION:?}"
    ( umask 077; printf 'ARCHIL_API_KEY=%s\nARCHIL_DISK=%s\nARCHIL_REGION=%s\n' "$ARCHIL_API_KEY" "$ARCHIL_DISK" "$ARCHIL_REGION" > "$ENV_DIR/supervisor.env" )
  fi
  do_ touch "$STATE/created-env"
  [ "$DRY_RUN" = 1 ] || echo "$RUN_ID" > "$STATE/run-id"
}

run() {
  say "run: what sudo lets $RUN_USER do"
  if [ "$DRY_RUN" = 1 ]; then echo "+ sudo -l -U $RUN_USER; assert it names $WRAPPER and fusermount -u, and nothing with ALL"; echo "+ runuser -u $RUN_USER -- sudo -n $WRAPPER version   (must work)"; echo "+ runuser -u $RUN_USER -- sudo -n true   (must be refused)"; echo "+ runuser -u $RUN_USER -- setpriv --no-new-privs sudo -n $WRAPPER version   (must be refused: no new privileges)"; else
    local listing; listing=$(sudo -l -U "$RUN_USER" 2>&1 || true)
    echo "$listing" | sed 's/^/    /'
    if echo "$listing" | grep -q "$WRAPPER" && echo "$listing" | grep -q "fusermount -u" && ! echo "$listing" | grep -Eq '\(ALL.*\) *(NOPASSWD: *)?ALL'; then pass "sudo -l: the wrapper and fusermount -u, not ALL"; else fail "sudo -l shows more or less than the wrapper and fusermount -u"; fi
    if runuser -u "$RUN_USER" -- sudo -n "$WRAPPER" version >/dev/null 2>&1; then pass "$RUN_USER can run the wrapper through sudo -n"; else fail "$RUN_USER cannot run the wrapper through sudo -n"; fi
    if runuser -u "$RUN_USER" -- sudo -n true >/dev/null 2>&1; then fail "$RUN_USER can sudo something other than the wrapper"; else pass "$RUN_USER cannot sudo anything else"; fi
    local nnp; nnp=$(runuser -u "$RUN_USER" -- setpriv --no-new-privs sudo -n "$WRAPPER" version 2>&1 || true)
    if echo "$nnp" | grep -qi "no new privileges"; then pass "under no_new_privs, sudo refuses even the wrapper (\"no new privileges\")"; else fail "no_new_privs did not stop sudo: $nnp"; fi
  fi

  say "run: example 02 (kill), supervisor as root, instances as $RUN_USER"
  local since; since=$(date '+%Y-%m-%d %H:%M:%S')
  local demo=("$NODE" examples/02-paid-effect/demo.ts kill --user "$RUN_USER" --archil "$WRAPPER" --mount-root-a "$MOUNT_ROOT_A" --mount-root-b "$MOUNT_ROOT_B" --id "$RUN_ID")
  printf '+ (cd %s; set -a; . %s/supervisor.env; set +a; %s)\n' "$INSTALL_DIR" "$ENV_DIR" "${demo[*]}"
  if [ "$DRY_RUN" != 1 ]; then
    if ( cd "$INSTALL_DIR"; set -a; . "$ENV_DIR/supervisor.env"; set +a; "${demo[@]}" ); then pass "the demo finished: at most once held, every instance ran as $RUN_USER (it exits 1 on a root instance)"; else fail "the demo failed (see its output above)"; fi

    say "run: what is left"
    local leaked; leaked=$(journalctl --since "$since" --no-pager 2>/dev/null | grep -c 'ARCHIL_MOUNT_TOKEN=' || true)
    if command -v journalctl >/dev/null; then [ "$leaked" = 0 ] && pass "no journal line carries ARCHIL_MOUNT_TOKEN= (counted, none printed)" || fail "$leaked journal lines carry ARCHIL_MOUNT_TOKEN="; else echo "no journalctl here: token-in-journal check skipped"; fi
    local files; files=$(find /run/pi-durable-archil -name '*.mount-token' -size +0 2>/dev/null | wc -l)
    [ "$files" = 0 ] && pass "no non-empty token file under /run/pi-durable-archil" || fail "$files non-empty token files under /run/pi-durable-archil"
    local mounts; mounts=$(grep -cE " ($MOUNT_ROOT_A|$MOUNT_ROOT_B)/runs/" /proc/mounts || true)
    [ "$mounts" = 0 ] && pass "no archil mount left under the mount roots" || fail "$mounts mounts left under the mount roots"
    local units; units=$(systemctl list-units --all --no-legend 'pda-demo-*' 2>/dev/null | wc -l)
    [ "$units" = 0 ] && pass "no pda-demo unit left" || fail "$units pda-demo units left"
  fi
}

teardown() {
  say "teardown"
  [ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root"
  # What a failed demo can leave: units, dead mounts, token users and the run directory on the disk.
  if [ "$DRY_RUN" = 1 ]; then echo "+ stop pda-demo-* units, unmount anything under the mount roots, remove this run's token users and directory"; else
    systemctl list-units --all --no-legend --plain 'pda-demo-*' 2>/dev/null | awk '{print $1}' | while read -r u; do [ -n "$u" ] && { systemctl stop "$u" 2>/dev/null || true; systemctl reset-failed "$u" 2>/dev/null || true; }; done
    for mp in $(grep -E " ($MOUNT_ROOT_A|$MOUNT_ROOT_B)/runs/" /proc/mounts | awk '{print $2}'); do fusermount -u "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || true; done
    if [ -f "$ENV_DIR/supervisor.env" ] && [ -d "$INSTALL_DIR/node_modules/disk" ]; then
      ( cd "$INSTALL_DIR"; set -a; . "$ENV_DIR/supervisor.env"; set +a
        RUN_ID=$(cat "$STATE/run-id" 2>/dev/null || echo "$RUN_ID") "$NODE" --input-type=module -e '
          import { configure, getDisk } from "disk";
          configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
          const disk = await getDisk(process.env.ARCHIL_DISK);
          const id = process.env.RUN_ID;
          for (const u of disk.authorizedUsers ?? []) if (u.identifier && u.nickname?.includes(`-${id}-g`)) { await disk.removeUser("token", u.identifier); console.log("removed token user", u.nickname); }
          const prefix = `runs/${id}/`;
          const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
          const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])].sort((a, b) => b.split("/").length - a.split("/").length);
          if (keys.length) await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true });
          for (const d of dirs) await disk.deleteObjects([d], { quiet: true });
          console.log("run directory removed:", prefix);
          process.exit(0);' ) || echo "disk cleanup failed: remove token users named *-$RUN_ID-g* and runs/$RUN_ID/ by hand"
    fi
  fi
  if created sudoers; then do_ rm -f "$SUDOERS"; fi
  do_ rm -rf "$WRAPPER_DIR"
  if created install; then do_ rm -rf "$INSTALL_DIR"; fi
  if created env; then do_ rm -rf "$ENV_DIR"; fi
  for root in "$MOUNT_ROOT_A" "$MOUNT_ROOT_B"; do
    do_ rmdir "$root/runs" || true
    if created "root-$(basename "$root")"; then do_ rmdir "$root" || true; fi
  done
  if created user; then do_ userdel "$RUN_USER"; fi
  do_ rm -rf "$STATE"
}

case "$cmd" in
  setup) setup ;;
  run) run ;;
  teardown) teardown ;;
  all)
    [ "${KEEP:-0}" = 1 ] || trap 'teardown' EXIT
    setup
    run
    ;;
  *) die "usage: $0 [setup|run|teardown|all|plan]" ;;
esac
[ "$FAILED" = 0 ] || { echo; echo "SOME CHECKS FAILED"; exit 1; }
[ "$DRY_RUN" = 1 ] && { echo; echo "plan only: nothing was run"; exit 0; }
echo; echo "all checks passed"
