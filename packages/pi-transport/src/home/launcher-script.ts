/**
 * The supervisor the host uploads to a box: POSIX `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `date`, `kill`, `sleep`. It holds
 * no pipe to the host and keeps every fact in files of its own directory. It uses no parameter expansion with braces, so
 * that this file can hold it as a raw string.
 */
export const LAUNCHER_SCRIPT = String.raw`MODE=$1
D=$2
SELF=$0
TICK=1
STEP=1
STEPS=10
if sleep 0.1 2>/dev/null; then TICK=0.2; STEP=0.1; STEPS=1; fi
SETSID=
if command -v setsid >/dev/null 2>&1; then SETSID=setsid; fi
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
rd() { cat "$D/$1" 2>/dev/null; }
wr() { printf '%s\n' "$2" > "$D/$1.$$" && mv "$D/$1.$$" "$D/$1"; }
detach() { ( $SETSID sh "$SELF" "$@" </dev/null >/dev/null 2>&1 & ); }

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
  wr pid.$n $$
  wr ticks.$n "$(ticks $$)"
  write_state running $$ "$(rd lastexit)"
  ( run_program ) >> "$D/out.log" 2>&1 < /dev/null
  code=$?
  if terminal "$code"; then write_state exited "" "$code"; else write_state restarting "" "$code"; fi
  wr lastexit $code
  wr exit.$n $code
}

ensure_watch() {
  [ ! -e "$D/done" ] || return 0
  alive "$(rd watch.pid)" "$(rd watch.ticks)" || detach watch "$D"
}

start_one() {
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
  if [ -e "$D/stop.req" ]; then exit 0; fi
  code=$(rd exit.$n)
  pid=$(rd pid.$n)
  if [ -z "$code" ]; then
    code=$2
    [ -n "$code" ] || code=137
    wr exit.$n $code
    wr lastexit $code
  fi
  if [ -n "$pid" ]; then kill -s KILL -- "-$pid" 2>/dev/null; fi
  if terminal "$code"; then
    write_state exited "" "$code"
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
    : > "$D/done"
    exit 0
  fi
  sleep "$DELAY"
  if [ -e "$D/stop.req" ]; then exit 0; fi
  start_one "$n"
}

supervise() {
  other=$(rd launcher.pid)
  if [ -n "$other" ] && [ "$other" != "$$" ] && alive "$other" "$(rd launcher.ticks)"; then exit 0; fi
  wr launcher.pid $$
  wr launcher.ticks "$(ticks $$)"
  while :; do
    if [ -e "$D/stop.req" ]; then exit 0; fi
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

watch() {
  other=$(rd watch.pid)
  if [ -n "$other" ] && [ "$other" != "$$" ] && alive "$other" "$(rd watch.ticks)"; then exit 0; fi
  wr watch.pid $$
  wr watch.ticks "$(ticks $$)"
  keep=$(( LOGMAX / 2 ))
  while :; do
    if [ -e "$D/done" ] || [ -e "$D/stop.req" ]; then exit 0; fi
    sleep 1
    if ! alive "$(rd launcher.pid)" "$(rd launcher.ticks)"; then detach supervise "$D"; fi
    size=$(( $(wc -c < "$D/out.log" 2>/dev/null) + 0 ))
    if [ "$size" -gt "$LOGMAX" ]; then
      tail -c "$keep" "$D/out.log" > "$D/out.log.cut" && cat "$D/out.log.cut" > "$D/out.log"
      rm -f "$D/out.log.cut"
    fi
  done
}

stopit() {
  tenths=$1
  wr stop.req 1
  n=$(rd starts)
  [ -n "$n" ] || n=0
  pid=$(rd pid.$n)
  before=$(rd state | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
  if alive "$pid" "$(rd ticks.$n)"; then
    kill -s TERM -- "-$pid" 2>/dev/null
    i=0
    while kill -s 0 -- "-$pid" 2>/dev/null && [ "$i" -lt "$tenths" ]; do
      sleep $STEP
      i=$(( i + STEPS ))
    done
  fi
  if [ -n "$pid" ]; then kill -s KILL -- "-$pid" 2>/dev/null; fi
  for f in launcher watch; do
    p=$(rd $f.pid)
    if alive "$p" "$(rd $f.ticks)"; then kill -s KILL "$p" 2>/dev/null; fi
  done
  case "$before" in
    exited|gave_up|stopped) ;;
    *) write_state stopped "" "$(rd lastexit)" ;;
  esac
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
