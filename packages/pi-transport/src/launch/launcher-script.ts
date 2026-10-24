/**
 * The supervisor the host uploads to a box: POSIX `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `date`, `kill`, `sleep`, `id`,
 * `ls`, and for a framed launch `base64` and a builtin `printf`. It holds no pipe to the host and keeps every fact in files
 * of its own directory, except a framed launch's stdin and secrets, which live only in its processes' memory. It uses no
 * parameter expansion with braces, so that this file can hold it as a raw string.
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
@@TOOLS_CHECK@@
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
@@DIRECTORY_CHECK@@
@@CAP_LINE@@
@@STOP_STATUS@@
rd() { cat "$D/$1" 2>/dev/null; }
wr() { printf '%s\n' "$2" > "$D/$1.$$" && mv "$D/$1.$$" "$D/$1"; }
current_gen() { sed -n "s/^GEN='\(.*\)'\$/\1/p" "$D/spec.sh" 2>/dev/null; }
MYGEN=$GEN
stale() { [ "$(current_gen)" != "$MYGEN" ]; }
# Every process started from $SELF reads this directory again: none starts unless it and the spool are still the launcher's own.
detach() { own_dirs || exit 13; ( $SETSID sh "$SELF" "$@" </dev/null >/dev/null 2>&1 & ); }
# The same, with this process's frame on the new process's stdin (a pipe from the builtin printf: no argv holds it).
detach_framed() { own_dirs || exit 13; ( send_frame | $SETSID sh "$SELF" "$@" >/dev/null 2>&1 & ); }

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
  # The process ids it signals and the restart it decides are read from the directory: only from one still the launcher's own.
  own_dirs || exit 13
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
# A stop is for the launch its caller read ($2, that launch's generation; empty from an older caller): from here on its
# generation is that one, never the spec this script happened to read. Before any kill, write or lock, a $D that holds another
# generation, or none, means that launch has ended and a later one may hold the name: nothing is stopped then.
stop_for() {
  if [ -n "$2" ]; then
    MYGEN=$2
    if stale; then stop_gone; return; fi
  fi
  stopit "$1"
}

# The launch this stop is for, once it has ended: as its own stop recorded it; or, with no record, a line that it ended and
# exit 4, which launchStop reads as a launch that does not exist (invalid), never another launch's state.
stop_gone() {
  rec=$(record_path "$MYGEN")
  if [ -r "$rec" ]; then cat "$rec"; return 0; fi
  echo "the launch this stop was for has ended, and another launch of the name holds the name now"
  exit 4
}

stopit() {
  tenths=$1
  lock
  # The same, under the lock: a launch of the name may have taken $D since.
  if stale; then unlock; stop_gone; return; fi
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

# The end of a stop: what is left of the program's group killed, the launcher's processes ended, the last state. Then its
# status, recorded under this launch's generation BEFORE done and stop.done release the name (a launch of the name that waited
# may wipe $D at once after), and printed from memory, never read again.
stop_end() {
  if own_group "$pid" "$(rd ticks.$n)"; then gkill KILL "$pid"; fi
  for f in launcher watch; do
    p=$(rd $f.pid)
    if alive "$p" "$(rd $f.ticks)"; then kill -s KILL "$p" 2>/dev/null; fi
  done
  # Nothing but this stop trims the output now: a trim lock left is a killed watchdog's, never waited out (15 s).
  rmdir "$D/trim" 2>/dev/null
  case "$before" in
    exited|gave_up|stopped) ;;
    *) write_state stopped "" "$(rd lastexit)" ;;
  esac
  trim_log
  final=$(status_block)
  rec=$(record_path "$MYGEN")
  printf '%s\n' "$final" > "$rec.$$" && mv "$rec.$$" "$rec"
  : > "$D/done"
  : > "$D/stop.done"
  printf '%s\n' "$final"
}

# A stop that did not claim the launch waits for the owner's end, within its own bound ($1 tenths of drain, the hook at its
# longest, 3 s: what the host waits for it). Past the owner's deadline, the owner died: this stop takes the stop over, once
# (it moves the deadline under the lock), and ends it. Once the stop has ended, a launch of the name may already hold $D
# (stale: another generation, or none yet), so what this stop reports is then its own generation's record; while $D is still
# this launch's, the status as it stands (stopping, past its bound).
stop_wait() {
  bound=$(( $(centis) + $1 * 10 + HOOK_TENTHS * 10 + 300 ))
  while [ ! -e "$D/stop.done" ] && ! stale; do
    # In a subshell: a lock that finds $D gone (a launch of the name is wiping it) ends only the subshell.
    seen=$(lock; if [ -e "$D/stop.done" ] || stale; then echo ended; else dl=$(rd stop.deadline); [ -n "$dl" ] || dl=0; if [ "$(centis)" -gt "$dl" ]; then wr stop.deadline $(( $(centis) + 300 )); echo take; else echo wait; fi; fi; unlock)
    case "$seen" in
      take)
        hp=$(rd hook.pid)
        if [ -n "$hp" ] && alive "$hp" "$(rd hook.ticks)"; then
          if [ -n "$SETSID" ]; then gkill KILL "$hp"; else kill -s KILL "$hp" 2>/dev/null; fi
        fi
        before=$(rd state | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
        stop_end
        return ;;
      wait) ;;
      *) break ;;
    esac
    if [ "$(centis)" -gt "$bound" ]; then break; fi
    sleep $STEP
  done
  if ! stale; then
    final=$(status_block)
    # Read while $D was still this launch's: a wipe never brings this generation back.
    if ! stale; then printf '%s\n' "$final"; return; fi
  fi
  stop_gone
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
  own_dirs || return 13
  rm -f "$D/tools.check"
  if [ -n "$SETSID" ]; then $SETSID sh "$SELF" tools-check "$D" </dev/null > "$D/tools.check" 2>/dev/null & else sh "$SELF" tools-check "$D" </dev/null > "$D/tools.check" 2>/dev/null & fi
  cp=$!
  began=$(centis)
  while alive "$cp" && [ $(( $(centis) - began )) -lt "$TOOLS_CHECK_CENTIS" ]; do sleep $STEP; done
  if alive "$cp"; then
    if [ -n "$SETSID" ]; then gkill KILL "$cp"; else kill -s KILL "$cp" 2>/dev/null; fi
    wait "$cp" 2>/dev/null
    rm -f "$D/tools" "$D/tools.probe" "$D/tools.mounts" "$D/tools.s" "$D/tools.c" "$D/tools.cs" "$D/tools.err"
    echo "UNSUPPORTED the check of the tools user $t_name did not finish in $(( TOOLS_CHECK_CENTIS / 100 )) s"
    return 10
  fi
  wait "$cp" 2>/dev/null
  # A check that died (killed, crashed) left its probe and its scratch files: they go, whatever it answered.
  rm -f "$D/tools.probe" "$D/tools.mounts" "$D/tools.s" "$D/tools.c" "$D/tools.cs" "$D/tools.err"
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
  # groups, as disk's spawn runs it; runuser, with its groups, only where there is no such setpriv). The check fails CLOSED: it
  # answers only when its tools answer, and an empty answer is never a clean box.
  gc=$(command -v getcap 2>/dev/null)
  [ -n "$gc" ] || { echo "UNSUPPORTED this box has no getcap to measure file capabilities"; return; }
  [ -r /proc/self/mountinfo ] || { echo "UNSUPPORTED this box has no /proc/self/mountinfo to list its mounts"; return; }
  # The controls: find and getcap must each report a probe planted to be found, or a silent one (an error, a missing feature, a
  # broken binary) would read as a box with nothing in it. The probe is INERT: an empty file, root's, mode 4700 (only root may
  # run it, and empty it runs nothing), with cap_net_raw (which grants nothing on an empty file), in this launch's directory,
  # root's alone (0700), never within the tools user's reach. Its x bit is there because the capability walk lists only files
  # with one (-perm /111) and the control goes through the walk's own predicates. It is planted afresh (a leftover from a check
  # that crashed is removed first) and removed BEFORE anything runs as the tools user and before the walk: the walk never sees
  # it, so it ignores no file by its name or its directory. A trap removes it on every way out, and the launcher removes it
  # again after any check, one it had to kill included. No control writes a sudo rule.
  probe="$D/tools.probe"
  trap 'rm -f "$D/tools.probe"' EXIT
  rm -f "$probe"
  { : > "$probe" && chmod 4700 "$probe"; } 2>/dev/null || { echo "UNSUPPORTED the check cannot plant its probe in $D"; return; }
  [ "$(find "$probe" -xdev \( -perm -4000 -user 0 -o -perm -2000 -group 0 \) -type f -print 2>/dev/null)" = "$probe" ] || { echo "UNSUPPORTED this box's find does not find a planted setuid root file"; return; }
  if ! command -v setcap >/dev/null 2>&1 || ! setcap cap_net_raw+ep "$probe" >/dev/null 2>&1; then echo "UNSUPPORTED this box cannot plant a file capability to check its getcap (setcap)"; return; fi
  case "$(find "$probe" -xdev -type f -perm /111 -exec "$gc" {} + 2>/dev/null)" in "$probe "*) ;; *) echo "UNSUPPORTED this box's getcap does not report a planted file capability"; return ;; esac
  rm -f "$probe"
  [ ! -e "$probe" ] || { echo "UNSUPPORTED the check cannot remove its probe"; return; }
  # Only now does anything run as the tools user.
  if setpriv --reuid="$t_uid" --regid="$t_gid" --clear-groups -- true >/dev/null 2>&1; then as="setpriv --reuid=$t_uid --regid=$t_gid --clear-groups --"
  elif runuser -u "$t_name" -- true >/dev/null 2>&1; then as="runuser -u $t_name --"
  else echo "UNSUPPORTED this box cannot test files as the tools user $t_name: it has no setpriv that takes --reuid and no runuser"; return
  fi
  # The tools user's test must answer for a file that user can run (its shell): a switch that never runs the test would read every
  # file as one it cannot run.
  $as sh -c 'test -x "$1"' sh "$(command -v sh)" 2>/dev/null || { echo "UNSUPPORTED this box cannot test a file as the tools user $t_name"; return; }
  awk '$6 !~ /(^|,)nosuid(,|$)/ { print $5 }' /proc/self/mountinfo | sort -u > "$D/tools.mounts"
  [ -s "$D/tools.mounts" ] || { echo "UNSUPPORTED the check found no mount to walk"; return; }
  : > "$D/tools.s"
  : > "$D/tools.c"
  # Every listed mount is walked, whole. A walk that fails on one (a mount root cannot read, a find that cannot) has not seen it.
  while IFS= read -r m; do
    m=$(printf '%b' "$m")
    [ -e "$m" ] || { echo "UNSUPPORTED a mount point the check cannot open: $m"; return; }
    find "$m" -xdev \( -perm -4000 -user 0 -o -perm -2000 -group 0 \) -type f -print 2> "$D/tools.err" >> "$D/tools.s" || { echo "UNSUPPORTED the check could not walk $m: $(head -1 "$D/tools.err" | cut -c1-160)"; return; }
    find "$m" -xdev -type f -perm /111 -exec "$gc" {} + 2> "$D/tools.err" >> "$D/tools.c" || { echo "UNSUPPORTED the check could not walk $m: $(head -1 "$D/tools.err" | cut -c1-160)"; return; }
  done < "$D/tools.mounts"
  found_s=$(sort -u "$D/tools.s" | while IFS= read -r f; do if $as sh -c 'test -x "$1"' sh "$f" 2>/dev/null; then printf '%s\n' "$f"; fi; done | head -5 | tr '\n' ' ')
  # A getcap line whose file the check cannot tell (cap_runnable) is never passed over: the check cannot answer.
  sort -u "$D/tools.c" > "$D/tools.cs"
  found_c=
  nc=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cap_runnable "$f"
    case $? in
      0) if [ "$nc" -lt 5 ]; then found_c="$found_c$f; "; fi; nc=$(( nc + 1 )) ;;
      2) rm -f "$D/tools.mounts" "$D/tools.s" "$D/tools.c" "$D/tools.cs" "$D/tools.err"; echo "UNSUPPORTED the check cannot tell which file a getcap line names: $(printf '%s\n' "$f" | cut -c1-160)"; return ;;
    esac
  done < "$D/tools.cs"
  rm -f "$D/tools.mounts" "$D/tools.s" "$D/tools.c" "$D/tools.cs" "$D/tools.err"
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
  own_dirs || exit 13
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
  stop) stop_for "$3" "$4" ;;
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
 * something is there. PROC is /proc, from PROC_LINE: a test copy of the script points it at a directory of its own, and no
 * environment can. The text lives in an ordinary string because
 * it holds a dollar sign and a brace, which a template literal would take for its own.
 */
const GROUP_LIVE = [
	"# Whether a process of group $1 that is not a zombie is left (shell builtins only; PROC is /proc, a test copy's own in one).",
	"@@PROC@@",
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
 * `own_dir PATH`: whether PATH is a directory only the launcher's uid can change, from ONE listing of PATH itself (a symbolic
 * link is never followed): a directory, owned by `id -u`, with no group- or other-write bit. 0 when it is, 4 when nothing is
 * there, 13 and a line `UNSAFE <why>` when it is not. A path that is there and did not list (another caller may have removed
 * and made it again in between) is listed again, at most three times in all; one that never lists is unsafe.
 * `own_above PATH`: every directory above PATH, up to /, is root's or the launcher's uid's, never a symbolic link, with no
 * group- or other-write bit unless it has the sticky bit (where only an entry's owner may rename it away): else another user
 * could rename the spool away and put another in its place between a check and a use. 0, or 13 and a line `UNSAFE <why>`
 * naming the directory. `own_spool` asks both of the spool; `own_dirs` asks it of $D's parent (the spool), then own_dir of
 * $D. Every script that uses the spool or a launch directory asks first, the launcher's own included: a `mkdir -p` that
 * succeeded proves nothing.
 */
export const DIRECTORY_CHECK = [
	"own_dir() {",
	"  for sn in 1 2 3; do",
	'    sd=$(ls -ldn "$1" 2>/dev/null | awk \'NR == 1 { print $1 " " $3 }\')',
	'    [ -z "$sd" ] || break',
	'    [ -e "$1" ] || [ -L "$1" ] || return 4',
	'    [ "$sn" = 3 ] || sleep 0.1 2>/dev/null || sleep 1',
	"  done",
	"  sm=\x24{sd%% *}",
	'  case "$sm" in',
	'    "") echo "UNSAFE $1 cannot be listed"; return 13 ;;',
	'    l*) echo "UNSAFE $1 is a symbolic link, not a directory of the launcher\'s own"; return 13 ;;',
	"    d*) ;;",
	'    *) echo "UNSAFE $1 is not a directory"; return 13 ;;',
	"  esac",
	'  [ "\x24{sd#* }" = "$(id -u)" ] || { echo "UNSAFE $1 belongs to uid \x24{sd#* }, not to the launcher\'s uid $(id -u)"; return 13; }',
	'  case "$sm" in d????-??-*) ;; *) echo "UNSAFE $1 can be written by its group or by other users ($sm)"; return 13 ;; esac',
	"}",
	"own_above() {",
	'  case "$1" in /*) ;; *) echo "UNSAFE $1 is not an absolute path"; return 13 ;; esac',
	"  sp=$1",
	'  while [ "$sp" != / ]; do',
	"    sp=\x24{sp%/*}",
	'    [ -n "$sp" ] || sp=/',
	'    sd=$(ls -ldn "$sp" 2>/dev/null | awk \'NR == 1 { print $1 " " $3 }\')',
	"    sm=\x24{sd%% *}",
	'    case "$sm" in d*) ;; *) echo "UNSAFE $sp, above the spool, is not a directory (a symbolic link or another file)"; return 13 ;; esac',
	'    [ "\x24{sd#* }" = 0 ] || [ "\x24{sd#* }" = "$(id -u)" ] || { echo "UNSAFE $sp, above the spool, belongs to uid \x24{sd#* }: neither root nor the launcher\'s uid $(id -u)"; return 13; }',
	'    case "$sm" in ?????????[tT]*|d????-??-*) ;; *) echo "UNSAFE $sp, above the spool, can be written by its group or by other users and has no sticky bit ($sm)"; return 13 ;; esac',
	"  done",
	"}",
	'own_spool() { own_dir "$1" && own_above "$1"; }',
	'own_dirs() { own_spool "\x24{D%/*}" && own_dir "$D"; }',
].join("\n");

/**
 * `cap_runnable LINE`: whether the getcap line LINE names a file the tools user can run (as the tools check's `$as` runs a test).
 * getcap prints "path caps", where caps may be several space-separated groups, or the older "path = caps", and a path may hold
 * spaces: so each candidate path is LINE with one more trailing field cut, from the longest down, and every candidate that is a
 * file is tested. 0 when one is a file that user can run, 1 when candidates are files and none is, 2 when no candidate is a file
 * (a line the check did not read, or a file gone since): the caller then cannot answer, and says so.
 */
export const CAP_LINE_CHECK = [
	"cap_runnable() {",
	"  cn=$1",
	"  cf=0",
	"  while :; do",
	'    case "$cn" in *" "*) cn=\x24{cn% *} ;; *) break ;; esac',
	'    [ -f "$cn" ] || continue',
	"    cf=1",
	'    if $as sh -c \'test -x "$1"\' sh "$cn" 2>/dev/null; then return 0; fi',
	"  done",
	'  [ "$cf" = 1 ] || return 2',
	"  return 1",
	"}",
].join("\n");

/** The first and the last line of the status block a stop prints and records: launchStop parses the last such block, nothing else. */
export const STATUS_BEGIN = "PI-TRANSPORT-STATUS/1";
export const STATUS_END = "PI-TRANSPORT-STATUS/1 END";

/**
 * `status_block`: this launch's status (status's own lines, less a stop's progress) between STATUS_BEGIN and STATUS_END.
 * `record_path GEN`: where a stop records that block for the launch of generation GEN, beside $D in the spool and never in it,
 * since a launch of the name that waited for the stop may wipe $D: `.stopped.<name>.<GEN>`, a name no launch can have.
 */
const STOP_STATUS = [
	`status_block() { echo '${STATUS_BEGIN}'; status | sed '/^STOP /d'; echo '${STATUS_END}'; }`,
	'record_path() { printf \'%s/.stopped.%s.%s\\n\' "\x24{D%/*}" "\x24{D##*/}" "$1"; }',
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
	"TOOLS_CHECK_CENTIS",
	"probe",
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
	"sd",
	"sm",
	"sn",
	"sp",
	"cn",
	"cf",
	"nc",
	"final",
	"rec",
	"seen",
];

/** The one line that names the kernel's ptrace scope file: a script-level constant, which no environment can change. */
export const PTRACE_FILE_LINE = "PTRACE_FILE=/proc/sys/kernel/yama/ptrace_scope";

/** The one line that names the process table the launcher reads (group_live, centis): a script-level constant like PTRACE_FILE_LINE. */
export const PROC_LINE = "PROC=/proc";

/** How long the tools user's check may take in the box (60 s). A start's call to the box is given this and more. */
export const TOOLS_CHECK_MS = 60_000;

/** The bound of the tools user's check, in centiseconds: a script-level constant like PTRACE_FILE_LINE, which no environment can change. */
export const TOOLS_CHECK_LINE = `TOOLS_CHECK_CENTIS=${TOOLS_CHECK_MS / 10}`;

/** The supervisor the host uploads to a box: POSIX `sh`, with the programs named in the file's header. */
export const LAUNCHER_SCRIPT = SCRIPT_TEMPLATE.replace("@@GROUP_LIVE@@", () =>
	GROUP_LIVE.replace("@@PROC@@", () => PROC_LINE),
)
	.replace("@@DIRECTORY_CHECK@@", () => DIRECTORY_CHECK)
	.replace("@@CAP_LINE@@", () => CAP_LINE_CHECK)
	.replace("@@STOP_STATUS@@", () => STOP_STATUS)
	.replace("@@PTRACE_FILE@@", () => PTRACE_FILE_LINE)
	.replace("@@TOOLS_CHECK@@", () => TOOLS_CHECK_LINE)
	.replace("@@UNSET@@", () => `unset ${LAUNCHER_SHELL_NAMES.join(" ")}`);
