/**
 * The supervisor the host uploads to a box: POSIX `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `date`, `kill`, `sleep`. It holds
 * no pipe to the host and keeps every fact in files of its own directory. It uses no parameter expansion with braces, so
 * that this file can hold it as a raw string.
 */
const SCRIPT_TEMPLATE = String.raw`MODE=$1
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
if [ -r "$D/spec.sh" ]; then . "$D/spec.sh"; fi

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

# An exclusive section: mkdir is atomic. Every section is a few file operations, so a holder that has not let go after 15 s
# died inside one, and its lock is broken. A section never exits while it holds the lock.
lock() {
  began=$(now)
  until mkdir "$D/mutex" 2>/dev/null; do
    [ -d "$D" ] || exit 0
    if [ $(( $(now) - began )) -gt 15 ]; then rm -rf "$D/mutex"; began=$(now); fi
    sleep $STEP
  done
}
unlock() { rmdir "$D/mutex" 2>/dev/null; }

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
trim_log() {
  size=$(( $(wc -c < "$D/out.log" 2>/dev/null) + 0 ))
  if [ "$size" -gt "$LOGMAX" ]; then
    tail -c $(( LOGMAX / 2 )) "$D/out.log" > "$D/out.log.cut" && cat "$D/out.log.cut" > "$D/out.log"
    rm -f "$D/out.log.cut"
  fi
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
  ( run_program ) >> "$D/out.log" 2>&1 < /dev/null
  code=$?
  if terminal "$code"; then write_state exited "" "$code"; else write_state restarting "" "$code"; fi
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
  write_state starting "" "$(rd lastexit)"
  detach run "$D" $n
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
    write_state exited "" "$code"
    trim_log
    : > "$D/done"
    exit 0
  fi
  write_state restarting "" "$code"
  t=$(now)
  echo "$t" >> "$D/restarts"
  cut=$(( t - INTERVAL ))
  c=$(( $(awk -v c=$cut '$1 >= c' "$D/restarts" | wc -l) + 0 ))
  if [ "$c" -gt "$BURST" ]; then
    write_state gave_up "" "$code"
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
    if ! alive "$(rd launcher.pid)" "$(rd launcher.ticks)"; then detach supervise "$D"; fi
    trim_log
  done
}

stopit() {
  tenths=$1
  lock
  wr stop.req 1
  n=$(rd starts)
  [ -n "$n" ] || n=0
  pid=$(rd pid.$n)
  unlock
  before=$(rd state | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
  if alive "$pid" "$(rd ticks.$n)"; then
    gkill TERM "$pid"
    began=$(centis)
    limit=$(( tenths * 10 ))
    while group_live "$pid" && [ $(( $(centis) - began )) -lt "$limit" ]; do
      sleep $STEP
    done
  fi
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
  if [ -n "$st" ]; then printf '%s\n' "$st"; else echo NOSTATE; fi
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
  centis) centis ;;
  clear) clear_dir ;;
  run) run "$3" ;;
  supervise) supervise ;;
  watch) watch ;;
  start) detach supervise "$D" ;;
  stop) stopit "$3" ;;
  status) status ;;
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

/** The supervisor the host uploads to a box: POSIX `sh`, with the programs named in the file's header. */
export const LAUNCHER_SCRIPT = SCRIPT_TEMPLATE.replace("@@GROUP_LIVE@@", () => GROUP_LIVE);
