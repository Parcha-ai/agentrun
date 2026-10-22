/**
 * The supervisor the host uploads to a box: POSIX `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `date`, `kill`, `sleep`, `id`,
 * and for a framed launch `base64` and a builtin `printf`. It holds no pipe to the host and keeps every fact in files of its
 * own directory, except a framed launch's stdin and secrets, which live only in its processes' memory. It uses no parameter expansion with braces, so
 * that this file can hold it as a raw string.
 */
const SCRIPT_TEMPLATE = String.raw`@@UNSET@@
MODE=$1
D=$2
SELF=$0
TICK=1
STEP=1
STEPS=10
if sleep 0.1 2>/dev/null; then TICK=0.2; STEP=0.1; STEPS=1; fi
SETSID=
if command -v setsid >/dev/null 2>&1; then SETSID=setsid; fi
GEN=
RESTART=1
DELAY=0
BURST=5
INTERVAL=60
TERMINALS=
LOGMAX=1048576
FRAMED=0
RUNAS=
TOOLS=
ISOLATION=
HOOK=0
HOOK_TENTHS=300
@@PTRACE_FILE@@
if [ -r "$D/spec.sh" ]; then . "$D/spec.sh"; fi
# A framed launch's stdin and secrets (base64), read from this process's stdin: in memory only, never a file, an
# environment or an argv. The supervisor hands them to each incarnation on a pipe.
FSEC=
FIN=
read_frame() {
  IFS= read -r magic || return 1
  IFS= read -r FSEC || return 1
  IFS= read -r FIN || return 1
  [ "$magic" = PI-TRANSPORT-LAUNCH/1 ] || return 1
  extra=
  if IFS= read -r extra; then return 1; fi
  [ -z "$extra" ] || return 1
  case "$FSEC$FIN" in *[!A-Za-z0-9+/=]*) return 1 ;; esac
  return 0
}
send_frame() { printf '%s\n%s\n%s\n' PI-TRANSPORT-LAUNCH/1 "$FSEC" "$FIN"; }

now() { date +%s; }
rest() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null; }
ticks() { rest "$1" | cut -d' ' -f20; }
alive() {
  [ -n "$1" ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  [ "$(rest "$1" | cut -c1)" != Z ] || return 1
  [ -z "$2" ] || [ "$(ticks "$1")" = "$2" ]
}
# A signal to a process group. dash wants "--" before a negative pid and BusyBox refuses it, so try both.
gkill() { kill -s "$1" -- "-$2" 2>/dev/null || kill -s "$1" "-$2" 2>/dev/null; }
@@GROUP_LIVE@@
rd() { cat "$D/$1" 2>/dev/null; }
wr() { printf '%s\n' "$2" > "$D/$1.$$" && mv "$D/$1.$$" "$D/$1"; }
current_gen() { sed -n "s/^GEN='\(.*\)'\$/\1/p" "$D/spec.sh" 2>/dev/null; }
MYGEN=$GEN
stale() { [ "$(current_gen)" != "$MYGEN" ]; }
detach() { ( $SETSID sh "$SELF" "$@" </dev/null >/dev/null 2>&1 & ); }
# The same, with this process's frame on the new process's stdin (a pipe from the builtin printf: no argv holds it).
detach_framed() { ( send_frame | $SETSID sh "$SELF" "$@" >/dev/null 2>&1 & ); }

# An exclusive section: mkdir is atomic. Every section is a few file operations, so a holder that has not let go after 15 s
# died inside one, and its lock is broken. A section never exits while it holds the lock.
lock() {
  m=$D/mutex
  [ -z "$1" ] || m=$D/$1
  began=$(now)
  until mkdir "$m" 2>/dev/null; do
    [ -d "$D" ] || exit 0
    if [ $(( $(now) - began )) -gt 15 ]; then rm -rf "$m"; began=$(now); fi
    sleep $STEP
  done
}
unlock() {
  m=$D/mutex
  [ -z "$1" ] || m=$D/$1
  rmdir "$m" 2>/dev/null
}

# Whether the process group named by a saved id is still the one this launch made. The id of a process that ended can be given
# to an unrelated job (a restarted sandbox, a long-lived box): a live process that holds the id with another start time is
# not ours. A group whose leader is gone may still hold leftover children of the program, and those are.
own_group() {
  [ -n "$1" ] || return 1
  if kill -0 "$1" 2>/dev/null && [ "$(rest "$1" | cut -c1)" != Z ]; then
    [ -z "$2" ] || [ "$(ticks "$1")" = "$2" ]
    return
  fi
  return 0
}

# Keep about the last half of LOGMAX bytes of the program's output once it holds more than LOGMAX.
# The whole trim is one exclusive section: the watchdog and the end of the launch can both trim, and a second copy of the
# tail must not read or rewrite the file while the first one does.
trim_log() {
  lock trim
  size=$(( $(wc -c < "$D/out.log" 2>/dev/null) + 0 ))
  if [ "$size" -gt "$LOGMAX" ]; then
    tail -c $(( LOGMAX / 2 )) "$D/out.log" > "$D/out.log.cut" && cat "$D/out.log.cut" > "$D/out.log"
    rm -f "$D/out.log.cut"
  fi
  unlock trim
}

# A state write by a runner or the supervisor, unless a stop has begun: the stop owns the launch's last state. The check and
# the write are one exclusive section, so a stop's "stopping" is never written over. Fails (1) when a stop has begun.
write_live() {
  lock
  if [ -e "$D/stop.req" ]; then unlock; return 1; fi
  write_state "$@"
  unlock
}

write_state() {
  p=$2; [ -n "$p" ] || p=null
  e=$3; [ -n "$e" ] || e=null
  s=$(rd starts); [ -n "$s" ] || s=0
  l=$(rd launcher.pid); [ -n "$l" ] || l=null
  t=$(( $(now) * 1000 ))
  printf '{"phase":"%s","pid":%s,"starts":%s,"lastExit":%s,"since":%s,"launcher":%s}\n' "$1" "$p" "$s" "$e" "$t" "$l" > "$D/state.$$" && mv "$D/state.$$" "$D/state"
}

terminal() {
  case " 0 $TERMINALS " in *" $1 "*) return 0 ;; esac
  [ "$RESTART" = 1 ] || return 0
  return 1
}

run() {
  n=$1
  # Publishing the wrapper and a stop agree on who comes first: a stop that came first leaves nothing to start, and one that
  # came after finds the wrapper's group to end.
  lock
  if [ -e "$D/stop.req" ] || [ -e "$D/done" ] || stale; then unlock; exit 0; fi
  wr pid.$n $$
  wr ticks.$n "$(ticks $$)"
  write_state running $$ "$(rd lastexit)"
  unlock
  if [ "$FRAMED" = 1 ] && [ -n "$FSEC" ]; then
    # The secrets on fd 3 and the stdin on the program's stdin, each decoded from memory straight into a pipe.
    printf '%s' "$FSEC" | base64 -d 2>/dev/null | { exec 3<&0; printf '%s' "$FIN" | base64 -d 2>/dev/null | ( run_program ) >> "$D/out.log" 2>&1; }
  elif [ "$FRAMED" = 1 ]; then
    printf '%s' "$FIN" | base64 -d 2>/dev/null | ( run_program ) >> "$D/out.log" 2>&1
  else
    ( run_program ) >> "$D/out.log" 2>&1 < /dev/null
  fi
  code=$?
  if terminal "$code"; then write_live exited "" "$code"; else write_live restarting "" "$code"; fi
  wr lastexit $code
  wr exit.$n $code
}

ensure_watch() {
  [ ! -e "$D/done" ] || return 0
  alive "$(rd watch.pid)" "$(rd watch.ticks)" && return 0
  detach watch "$D"
  # The watchdog is part of the launcher: the program starts, and a caller is told so, only once it has registered.
  i=0
  while [ "$i" -lt 50 ] && ! alive "$(rd watch.pid)" "$(rd watch.ticks)"; do
    sleep $TICK
    i=$(( i + 1 ))
  done
}

start_one() {
  if [ -e "$D/stop.req" ] || stale; then exit 0; fi
  n=$(( $1 + 1 ))
  wr starts $n
  wr started.at "$(now)"
  write_live starting "" "$(rd lastexit)" || exit 0
  if [ "$FRAMED" = 1 ]; then detach_framed run "$D" $n; else detach run "$D" $n; fi
  i=0
  while [ ! -e "$D/pid.$n" ] && [ "$i" -lt 50 ]; do
    sleep $TICK
    i=$(( i + 1 ))
  done
}

end_incarnation() {
  n=$1
  if [ -e "$D/stop.req" ] || stale; then exit 0; fi
  code=$(rd exit.$n)
  pid=$(rd pid.$n)
  if [ -z "$code" ]; then
    code=$2
    [ -n "$code" ] || code=137
    wr exit.$n $code
    wr lastexit $code
  fi
  if own_group "$pid" "$(rd ticks.$n)"; then gkill KILL "$pid"; fi
  if terminal "$code"; then
    write_live exited "" "$code" || exit 0
    trim_log
    : > "$D/done"
    exit 0
  fi
  write_live restarting "" "$code" || exit 0
  t=$(now)
  echo "$t" >> "$D/restarts"
  cut=$(( t - INTERVAL ))
  c=$(( $(awk -v c=$cut '$1 >= c' "$D/restarts" | wc -l) + 0 ))
  if [ "$c" -gt "$BURST" ]; then
    write_live gave_up "" "$code" || exit 0
    trim_log
    : > "$D/done"
    exit 0
  fi
  sleep "$DELAY"
  if [ -e "$D/stop.req" ] || stale; then exit 0; fi
  start_one "$n"
}

supervise() {
  # Looking for a running supervisor and becoming the supervisor is one step, so that two starts of a lost launch make one.
  lock
  other=$(rd launcher.pid)
  if [ -n "$other" ] && [ "$other" != "$$" ] && alive "$other" "$(rd launcher.ticks)"; then unlock; exit 0; fi
  if [ -e "$D/done" ] || stale; then unlock; exit 0; fi
  wr launcher.pid $$
  wr launcher.ticks "$(ticks $$)"
  unlock
  while :; do
    if [ -e "$D/stop.req" ] || stale; then exit 0; fi
    ensure_watch
    n=$(rd starts)
    [ -n "$n" ] || n=0
    if [ "$n" -eq 0 ]; then start_one 0; continue; fi
    if [ ! -e "$D/pid.$n" ]; then
      t0=$(rd started.at)
      [ -n "$t0" ] || t0=0
      if [ $(( $(now) - t0 )) -gt 5 ]; then end_incarnation "$n" 126; else sleep $TICK; fi
      continue
    fi
    if [ -e "$D/exit.$n" ] || ! alive "$(rd pid.$n)" "$(rd ticks.$n)"; then end_incarnation "$n"; continue; fi
    sleep $TICK
  done
}

# The launch is over: its output still obeys the limit, unless the directory now belongs to a newer launch.
watch_over() {
  if ! stale; then trim_log; fi
  exit 0
}

watch() {
  lock
  other=$(rd watch.pid)
  if [ -n "$other" ] && [ "$other" != "$$" ] && alive "$other" "$(rd watch.ticks)"; then unlock; exit 0; fi
  wr watch.pid $$
  wr watch.ticks "$(ticks $$)"
  unlock
  while :; do
    if [ -e "$D/done" ] || [ -e "$D/stop.req" ] || stale; then watch_over; fi
    sleep 1
    if [ -e "$D/done" ] || [ -e "$D/stop.req" ] || stale; then watch_over; fi
    # A framed launch's supervisor held its stdin and secrets in memory: nothing here has them, so it is never brought back
    # (the launch reads lost; a caller that holds them again launches it again).
    if ! alive "$(rd launcher.pid)" "$(rd launcher.ticks)"; then
      if [ "$FRAMED" = 1 ]; then watch_over; fi
      detach supervise "$D"
    fi
    trim_log
  done
}

# ONE stop owns a launch's stop, claimed under the lock by the first: it drains, runs the hook (once per launch), kills and
# writes the last state, then stop.done. Its deadline is its drain, the hook at its longest, and 3 s. A later or concurrent
# stop never kills while the owner is within it (stop_wait).
stopit() {
  tenths=$1
  lock
  wr stop.req 1
  n=$(rd starts)
  [ -n "$n" ] || n=0
  pid=$(rd pid.$n)
  before=$(rd state | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
  claimed=0
  if [ ! -e "$D/stop.claimed" ]; then
    : > "$D/stop.claimed"
    claimed=1
    wr stop.deadline $(( $(centis) + tenths * 10 + HOOK_TENTHS * 10 + 300 ))
    case "$before" in exited|gave_up|stopped) ;; *) write_state stopping "" "$(rd lastexit)" ;; esac
  fi
  unlock
  if [ "$claimed" = 0 ]; then stop_wait "$tenths"; return; fi
  if alive "$pid" "$(rd ticks.$n)"; then
    gkill TERM "$pid"
    began=$(centis)
    limit=$(( tenths * 10 ))
    while group_live "$pid" && [ $(( $(centis) - began )) -lt "$limit" ]; do
      sleep $STEP
    done
  fi
  run_hook
  stop_end
}

# The end of a stop: what is left of the program's group killed, the launcher's processes ended, the last state, stop.done.
stop_end() {
  if own_group "$pid" "$(rd ticks.$n)"; then gkill KILL "$pid"; fi
  for f in launcher watch; do
    p=$(rd $f.pid)
    if alive "$p" "$(rd $f.ticks)"; then kill -s KILL "$p" 2>/dev/null; fi
  done
  case "$before" in
    exited|gave_up|stopped) ;;
    *) write_state stopped "" "$(rd lastexit)" ;;
  esac
  trim_log
  : > "$D/done"
  : > "$D/stop.done"
  cat "$D/state"
}

# A stop that did not claim the launch waits for the owner's end, within its own bound ($1 tenths of drain, the hook at its
# longest, 3 s: what the host waits for it), and reports the state as it then stands. Past the owner's deadline, the owner
# died: this stop takes the stop over, once (it moves the deadline under the lock), and ends it.
stop_wait() {
  bound=$(( $(centis) + $1 * 10 + HOOK_TENTHS * 10 + 300 ))
  while [ ! -e "$D/stop.done" ]; do
    lock
    dl=$(rd stop.deadline)
    [ -n "$dl" ] || dl=0
    if [ ! -e "$D/stop.done" ] && [ "$(centis)" -gt "$dl" ]; then
      wr stop.deadline $(( $(centis) + 300 ))
      unlock
      hp=$(rd hook.pid)
      if [ -n "$hp" ] && alive "$hp" "$(rd hook.ticks)"; then
        if [ -n "$SETSID" ]; then gkill KILL "$hp"; else kill -s KILL "$hp" 2>/dev/null; fi
      fi
      before=$(rd state | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
      stop_end
      return
    fi
    unlock
    if [ "$(centis)" -gt "$bound" ]; then break; fi
    sleep $STEP
  done
  cat "$D/state"
}

status() {
  a=0
  st=$(rd state)
  phase=$(printf '%s\n' "$st" | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
  case "$phase" in exited|gave_up|stopped) done_for=1 ;; *) done_for=0 ;; esac
  if [ "$done_for" = 0 ] && { alive "$(rd launcher.pid)" "$(rd launcher.ticks)" || alive "$(rd watch.pid)" "$(rd watch.ticks)"; }; then a=1; fi
  printf 'ALIVE %s\n' "$a"
  printf 'GEN %s\n' "$(current_gen)"
  if [ -r "$D/user" ]; then read -r u1 u2 u3 u4 < "$D/user"; printf 'USER %s %s\n' "$u1" "$u2"; fi
  if [ -r "$D/tools" ]; then read -r u1 u2 u3 < "$D/tools"; printf 'TOOLS %s %s\n' "$u1" "$u2"; fi
  if [ -e "$D/stop.claimed" ] && [ ! -e "$D/stop.done" ]; then
    dl=$(rd stop.deadline)
    [ -n "$dl" ] || dl=0
    left=$(( dl - $(centis) ))
    if [ "$left" -lt 0 ]; then echo 'STOP late'; else printf 'STOP %s\n' "$left"; fi
  fi
  if [ -n "$st" ]; then printf '%s\n' "$st"; else echo NOSTATE; fi
}

# Who the program runs as ($RUNAS, a name or a uid), resolved once at the start into $D/user (name uid gid home). A
# launcher that is not root runs it only as itself; a root launcher drops to another user with setpriv or runuser, and needs
# a user for a framed launch, so the program never shares the root launcher's memory.
resolve_user() {
  me=$(id -u)
  if [ -z "$RUNAS" ]; then
    # The program runs as the launcher: as root, a framed launch needs a tools user, and a tools user needs a root launcher.
    if [ -n "$TOOLS" ] && [ "$me" != 0 ]; then echo "INVALID toolsUser goes only with a program run as root: this launcher runs as uid $me"; return 8; fi
    if [ "$me" = 0 ] && [ "$FRAMED" = 1 ] && [ -z "$TOOLS" ]; then echo "INVALID a launch with stdin or secrets runs its program as root (uid 0) only with a toolsUser: name the user its tools run as, or run it as another user"; return 8; fi
    return 0
  fi
  line=$(awk -F: -v u="$RUNAS" '$1 == u || $3 == u { print $1 " " $3 " " $4 " " $6; exit }' /etc/passwd 2>/dev/null)
  if [ -z "$line" ] && command -v getent >/dev/null 2>&1; then
    line=$(getent passwd "$RUNAS" 2>/dev/null | awk -F: '{ print $1 " " $3 " " $4 " " $6; exit }')
  fi
  [ -n "$line" ] || { echo "INVALID there is no user $RUNAS in this box"; return 8; }
  name=$(printf '%s\n' "$line" | cut -d' ' -f1)
  uid=$(printf '%s\n' "$line" | cut -d' ' -f2)
  gid=$(printf '%s\n' "$line" | cut -d' ' -f3)
  home=$(printf '%s\n' "$line" | cut -d' ' -f4-)
  # A framed launch runs its program as root (sharing the launcher's memory and files), whatever its name, only with a tools user,
  # and a tools user goes only with a program run as root.
  if [ -n "$TOOLS" ] && [ "$uid" != 0 ]; then echo "INVALID toolsUser goes only with a program run as root: this launch runs it as $name (uid $uid)"; return 8; fi
  if [ "$FRAMED" = 1 ] && [ "$uid" = 0 ] && [ -z "$TOOLS" ]; then echo "INVALID a launch with stdin or secrets runs its program as root (uid 0) only with a toolsUser: name the user its tools run as, or run it as another user"; return 8; fi
  if [ "$me" != 0 ] && [ "$uid" != "$me" ]; then echo "UNSUPPORTED only a root launcher runs a program as another user"; return 9; fi
  # How a root launcher drops to the user, found by doing it once: a setpriv that takes --reuid (util-linux; BusyBox's does
  # not), else runuser. A box with neither refuses here, never at an incarnation.
  how=self
  if [ "$me" = 0 ] && [ "$uid" != 0 ]; then
    if setpriv --reuid="$uid" --regid="$gid" --init-groups -- true >/dev/null 2>&1; then how=setpriv
    elif runuser -u "$name" -- true >/dev/null 2>&1; then how=runuser
    else echo "UNSUPPORTED this box cannot run a program as $RUNAS: it has no setpriv that takes --reuid and no runuser"; return 9
    fi
  fi
  wr user "$name $uid $gid $how $home"
}

# The ptrace scope a launch that holds stdin or secrets needs: 1 or more, or a same-user process could read them from the
# program's memory. Measured here, in the box ($1: the kernel's file; a missing one counts as 0); 0 on a box with its own
# kernel ($2 = vm) is raised to 1 and read back; 0 anywhere else, or a value that does not move, refuses.
ptrace_check() {
  v=$(cat "$1" 2>/dev/null | tr -d ' \n')
  case "$v" in ''|*[!0-9]*) v=0 ;; esac
  if [ "$v" -ge 1 ]; then return 0; fi
  if [ "$2" = vm ]; then
    { printf '1\n' > "$1"; } 2>/dev/null || sysctl -w kernel.yama.ptrace_scope=1 >/dev/null 2>&1
    v=$(cat "$1" 2>/dev/null | tr -d ' \n')
    case "$v" in ''|*[!0-9]*) v=0 ;; esac
    if [ "$v" -ge 1 ]; then return 0; fi
  fi
  echo "REFUSED kernel.yama.ptrace_scope is $v in this box, and a launch with stdin or secrets needs 1 or more (a process of the same user could read them from the program's memory)"
  return 11
}

# The tools user of a program run as root (TOOLS), checked in the box before the frame is read: the launcher measures what it
# can of the host's promise that the program runs everything it does not trust as that user. It exists (V1), is not root and has
# not the root group (V2); then, in a bounded process of its own (tools-check, 60 s), it has no sudo rule (V3) and can run no
# setuid or setgid root file and no file with capabilities (V4). What the launcher cannot measure stays the host's (README,
# "toolsUser"). Its record, $D/tools (name uid gid), is what the program and the state are told.
verify_tools() {
  line=$(awk -F: -v u="$TOOLS" '$1 == u || $3 == u { print $1 " " $3 " " $4; exit }' /etc/passwd 2>/dev/null)
  if [ -z "$line" ] && command -v getent >/dev/null 2>&1; then
    line=$(getent passwd "$TOOLS" 2>/dev/null | awk -F: '{ print $1 " " $3 " " $4; exit }')
  fi
  [ -n "$line" ] || { echo "INVALID there is no tools user $TOOLS in this box"; return 8; }
  t_name=$(printf '%s\n' "$line" | cut -d' ' -f1)
  t_uid=$(printf '%s\n' "$line" | cut -d' ' -f2)
  t_gid=$(printf '%s\n' "$line" | cut -d' ' -f3)
  if [ "$t_uid" = 0 ]; then echo "INVALID the tools user $t_name is root (uid 0)"; return 8; fi
  if [ "$t_gid" = 0 ]; then echo "INVALID the tools user $t_name has the root group (gid 0)"; return 8; fi
  wr tools "$t_name $t_uid $t_gid"
  rm -f "$D/tools.check"
  if [ -n "$SETSID" ]; then $SETSID sh "$SELF" tools-check "$D" </dev/null > "$D/tools.check" 2>/dev/null & else sh "$SELF" tools-check "$D" </dev/null > "$D/tools.check" 2>/dev/null & fi
  cp=$!
  began=$(centis)
  while alive "$cp" && [ $(( $(centis) - began )) -lt 6000 ]; do sleep $STEP; done
  if alive "$cp"; then
    if [ -n "$SETSID" ]; then gkill KILL "$cp"; else kill -s KILL "$cp" 2>/dev/null; fi
    wait "$cp" 2>/dev/null
    rm -f "$D/tools"
    echo "UNSUPPORTED the check of the tools user $t_name did not finish in 60 s"
    return 10
  fi
  wait "$cp" 2>/dev/null
  said=$(grep -E '^(REFUSED|UNSUPPORTED) ' "$D/tools.check" 2>/dev/null | head -1)
  if [ -z "$said" ] && ! grep -qx CHECKED "$D/tools.check" 2>/dev/null; then said="UNSUPPORTED the check of the tools user $t_name ended without an answer"; fi
  rm -f "$D/tools.check"
  [ -z "$said" ] && return 0
  rm -f "$D/tools"
  echo "$said"
  case "$said" in REFUSED*) return 12 ;; *) return 10 ;; esac
}

# The bounded half of verify_tools, in a process of its own (tools-check): V3 and V4. It prints REFUSED or UNSUPPORTED and why,
# or CHECKED.
tools_check() {
  read -r t_name t_uid t_gid < "$D/tools" || { echo "UNSUPPORTED the launcher's record of the tools user is gone"; return; }
  # V3. sudo has no machine-readable answer, and its exit status is 0 whether or not the user may run anything (measured on
  # Debian's sudo 1.9). It runs with an empty environment but PATH (the C locale: its sentences untranslated, nothing inherited
  # bending them); env -i rather than a prefix that sets LC_ALL to C, so the script never assigns LC_ALL, which stays a name a
  # program may set. The one answer accepted is its EXACT sentence for a user with no rule, built from the user's name and this
  # box's short hostname, as its whole output: never a substring or a pattern. Anything else refuses, with its first line. V3 is
  # defence in depth beside V4: a sudo the tools user cannot run today (4750) may still hold a rule for it.
  if command -v sudo >/dev/null 2>&1; then
    h=$(cut -d. -f1 /proc/sys/kernel/hostname 2>/dev/null)
    [ -n "$h" ] || h=$(hostname 2>/dev/null | cut -d. -f1)
    out=$(env -i PATH="$PATH" sudo -n -l -U "$t_name" 2>&1)
    if [ "$out" != "User $t_name is not allowed to run sudo on $h." ]; then
      echo "REFUSED sudo does not say the tools user $t_name may run nothing: $(printf '%s\n' "$out" | head -1 | cut -c1-160)"
      return
    fi
  fi
  # V4. Every mount that honours setuid bits and file capabilities (no nosuid) is LISTED as root, so a directory the tools user can
  # pass through but not list hides nothing; each file found is then TESTED as the tools user (access(2), through setpriv with no
  # groups, as disk's spawn runs it; runuser, with its groups, only where there is no such setpriv).
  gc=$(command -v getcap 2>/dev/null)
  [ -n "$gc" ] || { echo "UNSUPPORTED this box has no getcap to measure file capabilities"; return; }
  [ -r /proc/self/mountinfo ] || { echo "UNSUPPORTED this box has no /proc/self/mountinfo to list its mounts"; return; }
  if setpriv --reuid="$t_uid" --regid="$t_gid" --clear-groups -- true >/dev/null 2>&1; then as="setpriv --reuid=$t_uid --regid=$t_gid --clear-groups --"
  elif runuser -u "$t_name" -- true >/dev/null 2>&1; then as="runuser -u $t_name --"
  else echo "UNSUPPORTED this box cannot test files as the tools user $t_name: it has no setpriv that takes --reuid and no runuser"; return
  fi
  awk '$6 !~ /(^|,)nosuid(,|$)/ { print $5 }' /proc/self/mountinfo | sort -u > "$D/tools.mounts"
  : > "$D/tools.s"
  : > "$D/tools.c"
  while IFS= read -r m; do
    m=$(printf '%b' "$m")
    [ -e "$m" ] || { echo "UNSUPPORTED a mount point the check cannot open: $m"; return; }
    find "$m" -xdev \( -perm -4000 -user 0 -o -perm -2000 -group 0 \) -type f -print 2>/dev/null >> "$D/tools.s"
    find "$m" -xdev -type f -perm /111 -exec "$gc" {} + 2>/dev/null >> "$D/tools.c"
  done < "$D/tools.mounts"
  found_s=$(sort -u "$D/tools.s" | while IFS= read -r f; do if $as sh -c 'test -x "$1"' sh "$f" 2>/dev/null; then printf '%s\n' "$f"; fi; done | head -5 | tr '\n' ' ')
  # getcap prints "path caps" (or "path = caps"): the path is all but the last field.
  found_c=$(sort -u "$D/tools.c" | while IFS= read -r f; do p=$(printf '%s\n' "$f" | sed 's/ [^ ]*$//; s/ =$//'); if $as sh -c 'test -x "$1"' sh "$p" 2>/dev/null; then printf '%s; ' "$f"; fi; done | cut -d';' -f1-5)
  rm -f "$D/tools.mounts" "$D/tools.s" "$D/tools.c"
  if [ -n "$found_s" ]; then echo "REFUSED the tools user $t_name can run a setuid or setgid root file: $found_s"; return; fi
  if [ -n "$found_c" ]; then echo "REFUSED the tools user $t_name can run a file with capabilities: $found_c"; return; fi
  echo CHECKED
}

# The start of a launch: a framed one measures the ptrace scope, then reads its frame, and both resolve the user, before
# the supervisor exists.
start_launch() {
  # Who the program runs as is resolved first; then what guards a framed launch's stdin and secrets is measured: a program run as
  # root with its tools user verified (a pda attach on a root process needs CAP_SYS_PTRACE, with or without Yama), else the
  # ptrace scope. Both come before the frame is read: a refused start never holds the secrets.
  resolve_user || exit $?
  if [ -n "$TOOLS" ]; then
    verify_tools || exit $?
  elif [ "$FRAMED" = 1 ]; then
    ptrace_check "$PTRACE_FILE" "$ISOLATION" || exit 11
  fi
  if [ "$FRAMED" = 1 ]; then
    case "$(command -V printf 2>/dev/null)" in *builtin*) ;; *) echo "UNSUPPORTED printf is not a shell builtin in this box, so the launch's stdin could reach an argv"; exit 10 ;; esac
    command -v base64 >/dev/null 2>&1 || { echo "UNSUPPORTED this box has no base64 to decode the launch's stdin"; exit 10; }
    read_frame || { echo "INVALID the launch frame is malformed (this launch carries stdin or secrets: launch it with them)"; exit 7; }
  fi
  if [ "$FRAMED" = 1 ]; then detach_framed supervise "$D"; else detach supervise "$D"; fi
}

# A stop's hook (beforeStop), after the drain and before the final kill: in a session of its own, bounded by HOOK_TENTHS;
# one past its bound is killed (137). Its exit goes to out.log; it never fails the stop.
run_hook() {
  [ "$HOOK" = 1 ] || return 0
  if [ -n "$SETSID" ]; then $SETSID sh "$SELF" hook "$D" </dev/null >> "$D/out.log" 2>&1 & else sh "$SELF" hook "$D" </dev/null >> "$D/out.log" 2>&1 & fi
  hp=$!
  wr hook.pid "$hp"
  wr hook.ticks "$(ticks "$hp")"
  began=$(centis)
  limit=$(( HOOK_TENTHS * 10 ))
  while kill -0 "$hp" 2>/dev/null && [ "$(rest "$hp" | cut -c1)" != Z ] && [ $(( $(centis) - began )) -lt "$limit" ]; do
    sleep $STEP
  done
  if kill -0 "$hp" 2>/dev/null && [ "$(rest "$hp" | cut -c1)" != Z ]; then
    # Its session is its own only with setsid; without it, only the hook itself is ended (never this stop's group).
    if [ -n "$SETSID" ]; then gkill KILL "$hp"; else kill -s KILL "$hp" 2>/dev/null; fi
    wait "$hp" 2>/dev/null
    hcode=137
  else
    wait "$hp"
    hcode=$?
  fi
  printf '[launcher] beforeStop exited %s\n' "$hcode" >> "$D/out.log"
}

clear_dir() {
  for f in launcher watch; do
    p=$(rd $f.pid)
    if alive "$p" "$(rd $f.ticks)"; then kill -s KILL "$p" 2>/dev/null; fi
  done
  i=0
  while [ "$i" -lt 25 ]; do
    rm -rf "$D" 2>/dev/null
    [ ! -e "$D" ] && break
    i=$(( i + 1 ))
    sleep $TICK
  done
  mkdir -m 700 "$D"
}

case "$MODE" in
  group-live) group_live "$3" ;;
  own-group) own_group "$3" "$4" ;;
  trim) trim_log ;;
  centis) centis ;;
  clear) clear_dir ;;
  run) if [ "$FRAMED" = 1 ]; then read_frame || exit 7; fi; run "$3" ;;
  supervise) if [ "$FRAMED" = 1 ]; then read_frame || exit 7; fi; supervise ;;
  watch) watch ;;
  start) start_launch ;;
  stop) stopit "$3" ;;
  status) status ;;
  ptrace-check) ptrace_check "$PTRACE_FILE" "$3" ;;
  tools-check) tools_check ;;
  hook) before_stop ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
`;

/**
 * Whether a process of group $1 that is not a zombie is left. A killed process whose parent has gone stays a zombie where the
 * box's init does not reap orphans (a Modal VM): it still answers signal 0 and still belongs to its group. Built from shell
 * builtins only (a fork per process is seconds on a host with thousands), and only once the cheap group probe says
 * something is there. PROC is /proc; a test points it at a directory of its own. The text lives in an ordinary string because
 * it holds a dollar sign and a brace, which a template literal would take for its own.
 */
const GROUP_LIVE = [
	"# Whether a process of group $1 that is not a zombie is left (shell builtins only; PROC is /proc, a test's own in a test).",
	"PROC=/proc",
	'if [ -n "$PI_TRANSPORT_PROC" ]; then PROC=$PI_TRANSPORT_PROC; fi',
	"group_live() {",
	"  g=$1",
	'  gkill 0 "$g" || [ "$PROC" != /proc ] || return 1',
	'  for f in "$PROC"/[0-9]*/stat; do',
	'    read -r line < "$f" || continue',
	"    r=\x24{line##*) }",
	'    [ "$r" != "$line" ] || continue',
	"    set -- $r",
	'    if [ "$3" = "$g" ] && [ "$1" != Z ]; then return 0; fi',
	"  done",
	"  return 1",
	"} 2>/dev/null",
	"# Hundredths of a second on a clock that only goes forward, as a plain decimal: shell arithmetic reads a leading zero as octal,",
	"# and 0.88 s of uptime written as 088 is a syntax error (a fresh VM reports such an uptime).",
	"centis() {",
	'  if read -r up _ < "$PROC/uptime" 2>/dev/null; then',
	"    case $up in",
	"      [0-9]*.[0-9][0-9]) i=\x24{up%.*}; f=\x24{up#*.}; echo $(( i * 100 + 1\x24{f} - 100 )); return ;;",
	"    esac",
	"  fi",
	"  echo $(( $(date +%s) * 100 ))",
	"}",
].join("\n");

/**
 * Every name the launcher's shell assigns: the script's own, the spec's (spec.sh) and the program's wrapper's (run_program),
 * temporaries included. The program's settings (`env`) and `inheritEnv` refuse each of them, so a program can never assign one;
 * and the script's FIRST statement unsets each, so a name the box runtime exported keeps no export flag, and what the launcher
 * puts in it (the frame's stdin and secrets among them) never reaches a child's environment. A test fails on any name the script
 * or a generated spec assigns that is not here. (The private prefix that replaces this list is a follow-up.)
 */
export const LAUNCHER_SHELL_NAMES: readonly string[] = [
	"MODE",
	"D",
	"SELF",
	"TICK",
	"STEP",
	"STEPS",
	"SETSID",
	"GEN",
	"MYGEN",
	"RESTART",
	"DELAY",
	"BURST",
	"INTERVAL",
	"TERMINALS",
	"LOGMAX",
	"FRAMED",
	"RUNAS",
	"ISOLATION",
	"HOOK",
	"HOOK_TENTHS",
	"PTRACE_FILE",
	"PROC",
	"FSEC",
	"FIN",
	"a",
	"before",
	"began",
	"c",
	"code",
	"cut",
	"done_for",
	"e",
	"extra",
	"f",
	"g",
	"gid",
	"hcode",
	"home",
	"how",
	"hp",
	"i",
	"l",
	"limit",
	"line",
	"m",
	"magic",
	"me",
	"n",
	"name",
	"other",
	"p",
	"phase",
	"pid",
	"r",
	"s",
	"size",
	"st",
	"t",
	"t0",
	"tenths",
	"u",
	"u1",
	"u2",
	"u3",
	"u4",
	"uid",
	"up",
	"v",
	"u_name",
	"u_id",
	"u_gid",
	"u_how",
	"u_home",
	"_",
	"claimed",
	"TOOLS",
	"t_name",
	"t_uid",
	"t_gid",
	"cp",
	"said",
	"h",
	"out",
	"gc",
	"as",
	"found_s",
	"found_c",
	"bound",
	"dl",
	"left",
];

/** The one line that names the kernel's ptrace scope file: a script-level constant, which no environment can change. */
export const PTRACE_FILE_LINE = "PTRACE_FILE=/proc/sys/kernel/yama/ptrace_scope";

/** The supervisor the host uploads to a box: POSIX `sh`, with the programs named in the file's header. */
export const LAUNCHER_SCRIPT = SCRIPT_TEMPLATE.replace("@@GROUP_LIVE@@", () => GROUP_LIVE)
	.replace("@@PTRACE_FILE@@", () => PTRACE_FILE_LINE)
	.replace("@@UNSET@@", () => `unset ${LAUNCHER_SHELL_NAMES.join(" ")}`);
