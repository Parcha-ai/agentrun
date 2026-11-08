// Background processes on a run's computer (moved from serve's background.ts; its scripts unchanged): `bash_background`
// starts a command and answers at once with its id; `bash_output` reads its output in pages, from a byte offset;
// `bash_input` writes to its stdin; `bash_signal` sends its process group TERM, INT or KILL; `bash_list` lists them.
// Every call is one short command on the run's hands (`sh -c '<script>' agentrun-background "$PWD" <op> <args>`, which
// the hands run with `bash -c`), so they work wherever `bash` runs on a computer. The tool gate holds each call to
// bash's setting (gate.ts SHELL_FAMILY): bash: deny refuses them all; bash: ask parks bash_background and bash_input
// under their own names, while bash_output, bash_list and bash_signal on this run's own processes run.
//
// In the computer, a start makes `work/background/<id>/` (the run's files show it) with `output.log` (stdout and
// stderr, the first BACKGROUND_LOG_BYTES of them) and display copies of `command`, `started`, `pid` (the command's
// process group) and, once it ends, `exit` (its code: 128 + n for signal n). Every file there can be written by the
// run's own file tools, so no call trusts one: the copies a call reads (the group, the exit code, the start time, the
// command, the run's-end mark) live in a computer-only directory (the computer's TMPDIR, else /tmp, under
// `.agentrun-background/<id>/`), and output.log is read only as a regular file reached through no link. The command runs
// under its own session (`setsid`), from a runner started with `setsid -f nohup`, which writes `exit` once the
// command's output is all in the log and no live process of its group is left. The computer-only directory also holds
// the fifo the command reads as its stdin, the runner's pid and the pid of the `sleep` holding the fifo's write end
// open. A process with no computer-only directory, or whose runner is gone without an exit code, is `lost`, and is never
// signalled. The run's end ends them (endBackground): TERM to each running group, KILL after 3 s, and an `ended` mark.
import { type ExecResult, exitCodeOf, type Executor, type Hands, type ToolAnswer } from "./hands.js";
import { BACKGROUND_DIR, BACKGROUND_INPUT_BYTES, BACKGROUND_LIST_MAX, BACKGROUND_LOG_BYTES, BACKGROUND_MAX, BACKGROUND_PAGE_BYTES, BACKGROUND_SIGNALS } from "./limits.js";

const MIB = BACKGROUND_LOG_BYTES / (1024 * 1024);
/** Each signal's number, for an exit code past 128. */
const SIGNAL_NAMES: Readonly<Record<number, string>> = { 1: "HUP", 2: "INT", 3: "QUIT", 6: "ABRT", 9: "KILL", 13: "PIPE", 14: "ALRM", 15: "TERM" };

/**
 * The runner, started under its own session by a start: `$1` the log's directory, `$2` the box-only directory, `$3` the
 * log's cap, `$4` work/, `$5` the command, `$6` 1 to run it on a terminal: `script -qfec`, which gives it a pty, copies
 * what the fifo brings to the pty and what the pty shows to the log, and exits with the command's code. It holds the fifo's write end open (a `sleep`), runs the command under a
 * session of its own (so a signal to the command's group never reaches the runner) with the fifo as stdin, and keeps
 * the first `$3` bytes of its output, written to the log as they come (head, unbuffered by stdbuf where the box has it;
 * else the last few KiB may wait in head's buffer until the process ends). Once the output's last writer is gone, it
 * writes the exit code.
 */
const RUNNER = [
  'L=$1; C=$2; cap=$3; echo $$ > "$C/runner"',
  // A display copy in work/ (put): from inside the log's directory, entered with cd -P and checked to be
  // work/background/<id> itself by its real path, written to a new file there (mktemp: an exclusive create, so never a
  // planted link) and renamed over its name on that same filesystem, the name taken as a file even where a link to a
  // directory stands there (mv -T; else that link is removed first), so a link planted at the name, or at the
  // directory, is never followed. A check that fails skips the copy; the temporary file (hidden, a dot name) is removed
  // on every path; no call reads a copy back.
  `put() { [ -n "$rw" ] || return 0; ( cd -P "$L" 2>/dev/null && [ "$(pwd -P)" = "$rw/background/\${L##*/}" ] || exit 0; r=$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' '); [ -n "$r" ] || exit 0; t=./.put.$$.$r; ( set -C; printf '%s\\n' "$2" > "$t" ) || { rm -f "$t"; exit 0; }; { mv -fT "$t" "./$1" 2>/dev/null || { [ -d "./$1" ] && [ ! -L "./$1" ] && { rm -f "$t"; exit 0; }; [ -L "./$1" ] && rm -f "./$1"; mv -f "$t" "./$1"; }; } || rm -f "$t" ) 2>/dev/null; return 0; }`,
  // The log is opened once, here, where start has just made it a regular file, then checked as opened: the file the
  // open reached must be work/background/<id>/output.log itself (by its real path, so through no link) and a regular
  // file, else nothing is kept. What later stands at its name is never written through.
  'rw=$(cd "$4" 2>/dev/null && pwd -P); [ -f "$L/output.log" ] && [ ! -L "$L/output.log" ] && exec 4>>"$L/output.log" || exec 4>/dev/null',
  '[ -n "$rw" ] && [ "$(readlink /proc/self/fd/4 2>/dev/null)" = "$rw/background/\${L##*/}/output.log" ] && [ -f /proc/self/fd/4 ] || exec 4>/dev/null',
  // The first $cap bytes, written as they come: head holds its output in a buffer unless stdbuf unbuffers it.
  'if stdbuf -o0 true 2>/dev/null; then keep() { stdbuf -o0 head -c "$cap" >&4; }; else keep() { head -c "$cap" >&4; }; fi',
  'sleep 2147483647 > "$C/in" & h=$!; echo "$h" > "$C/hold"',
  // The command's group goes in C, beside the fifo (pgid), the only copy any call trusts; one byte past the cap marks
  // the log capped.
  `{ setsid -w sh -c 'echo $$ > "$1/.pgid" && mv -f "$1/.pgid" "$1/pgid"; cd "$2" || exit 126; b=$(command -v bash 2>/dev/null) || b=; if [ "$4" = 1 ]; then SHELL=\${b:-/bin/sh}; AGENTRUN_BG_CMD=$3; AGENTRUN_BG_SID=$1/tsid; export SHELL AGENTRUN_BG_CMD AGENTRUN_BG_SID; exec script -qfec "echo \\$\\$ > \\"\\$AGENTRUN_BG_SID\\"; c=\\$AGENTRUN_BG_CMD; unset AGENTRUN_BG_CMD AGENTRUN_BG_SID; exec \\"\\$SHELL\\" -c \\"\\$c\\"" /dev/null; fi; [ -n "$b" ] && exec bash -c "$3"; exec sh -c "$3"' agentrun-background "$C" "$4" "$5" "$6" < "$C/in" 2>&1; echo $? > "$C/code"; } | { keep; [ -n "$(head -c 1 | od -An -c)" ] && { : > "$C/capped"; put capped ""; }; cat > /dev/null; }`,
  // A child the command left running (a server started with &, its output sent elsewhere) keeps the process going: the
  // group is waited for, and on a terminal the terminal's session (tsid, script's command's own pid), whose processes
  // outlive script; so it stays running, signalled, counted and ended at the run's end until no live process of either
  // is left.
  `g=$(cat "$C/pgid" 2>/dev/null); live() { [ -n "$g" ] || return 1; s=$(cat "$C/tsid" 2>/dev/null); if [ -r /proc/self/stat ]; then cat /proc/[0-9]*/stat 2>/dev/null | awk -v g="$g" -v s="$s" '{ sub(/^[0-9]+ \\(.*\\) /, ""); if ($1 != "Z" && ($3 == g || (s != "" && $4 == s))) n++ } END { exit n > 0 ? 0 : 1 }'; else kill -0 "-$g" 2>/dev/null; fi; }; while live; do sleep 0.5; done`,
  'kill "$h" 2>/dev/null; code=$(cat "$C/code" 2>/dev/null); [ -n "$code" ] || code=255',
  // The display copy first, then the trusted exit code: a reader that sees the process ended (the run's end among them,
  // which then destroys the box) finds its display copy in work/ already, never cut off by the box's end.
  'put exit "$code"; printf \'%s\\n\' "$code" > "$C/.exit" && mv -f "$C/.exit" "$C/exit"; rm -f "$C/in"',
].join("\n");

/**
 * Every call's script: `$1` work/, `$2` the operation, the rest its arguments. Each answers on stdout in lines a parse
 * below reads. A state is `running`, `exited <code>` or `lost`. What a call trusts (the group, the exit code, the start
 * time, the command, the run's-end mark) is read from the box-only directory `c` alone, which the run's file tools
 * cannot write; of work/background/<id>/ only output.log is read, and only as a regular file reached through no link.
 */
const SCRIPT = [
  'w=$1; op=$2; shift 2; d=$w/background; c=${TMPDIR:-/tmp}/.agentrun-background; rw=$(cd "$w" 2>/dev/null && pwd -P)',
  `alive() { [ -n "$1" ] || return 1; if [ -r /proc/self/stat ]; then s=$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1); [ -n "$s" ] && [ "$s" != Z ] && [ "$s" != X ]; else kill -0 "$1" 2>/dev/null; fi; }`,
  'state() { [ -d "$c/$1" ] || { echo unstarted; return; }; if [ -f "$c/$1/exit" ]; then echo "exited $(cat "$c/$1/exit")"; elif alive "$(cat "$c/$1/runner" 2>/dev/null)"; then echo running; else echo lost; fi; }',
  // The ids this box started (c), and with them, for the list alone, those of work/ (a box before this one's).
  'cids() { for p in "$c"/*; do i=${p##*/}; case $i in ""|*[!0-9]*) continue;; esac; [ -d "$p" ] && echo "$i"; done; }',
  'ids() { { cids; [ -L "$d" ] || for p in "$d"/*; do i=${p##*/}; case $i in ""|*[!0-9]*) continue;; esac; echo "$i"; done; } | sort -un; }',
  'running() { for i in $(cids); do [ -f "$c/$i/exit" ] && continue; [ "$(state "$i")" = running ] && echo "$i"; done; }',
  // $1's log, opened first and then checked as opened (fd 3): the file the open reached is work/background/<id>/output.log
  // itself, by its real path (so through no link), and a regular file. Every read after is of that open file
  // (/proc/self/fd/3), so a link swapped in at its name after the check is never read. 0: open; 1: there is no log;
  // 2: it is not to be read (a link, or not a regular file); 3: this box has no /proc to check it by.
  'openlog() { exec 3<&-; f="$d/$1/output.log"; [ -e "$f" ] || [ -L "$f" ] || return 1; [ -f "$f" ] && [ ! -L "$f" ] && [ -n "$rw" ] || return 2; exec 3< "$f" 2>/dev/null || return 2; [ -e /proc/self/fd/3 ] || { exec 3<&-; return 3; }; [ "$(readlink /proc/self/fd/3 2>/dev/null)" = "$rw/background/$1/output.log" ] && [ -f /proc/self/fd/3 ] || { exec 3<&-; return 2; }; }',
  'size() { if openlog "$1"; then echo $(($(wc -c < /proc/self/fd/3))); exec 3<&-; else echo 0; fi; }',
  // A display copy in work/ (the runner's put, by id): from inside work/background/<id>, entered with cd -P and checked
  // by its real path, an exclusive new file there renamed over its name on the same filesystem; a failed check skips it.
  `put() { [ -n "$rw" ] || return 0; ( cd -P "$d/$1" 2>/dev/null && [ "$(pwd -P)" = "$rw/background/$1" ] || exit 0; r=$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' '); [ -n "$r" ] || exit 0; t=./.put.$$.$r; ( set -C; if [ "$4" = n ]; then printf '%s\\n' "$3"; else printf '%s' "$3"; fi > "$t" ) || { rm -f "$t"; exit 0; }; { mv -fT "$t" "./$2" 2>/dev/null || { [ -d "./$2" ] && [ ! -L "./$2" ] && { rm -f "$t"; exit 0; }; [ -L "./$2" ] && rm -f "./$2"; mv -f "$t" "./$2"; }; } || rm -f "$t" ) 2>/dev/null; return 0; }`,
  // A display name the process has no box-only copy for (a tty or capped mark planted in work/), removed from inside the
  // checked directory, as put enters it: a link goes, never what it names.
  `drop() { [ -n "$rw" ] || return 0; ( cd -P "$d/$1" 2>/dev/null && [ "$(pwd -P)" = "$rw/background/$1" ] || exit 0; rm -f "./$2" ) 2>/dev/null; return 0; }`,
  'known() { [ -d "$c/$1" ] || { [ ! -L "$d" ] && [ -d "$d/$1" ]; }; }',
  // A tty process's command runs in the pty's own session (tsid: script's command, its leader), whose processes may
  // outlive script: the groups of that session (sgs), and its terminal's foreground group (fgs, the tpgid its processes
  // read): an interactive shell's running job is a group of its own, which Ctrl-C reaches and the shell's own does not.
  `sgs() { cat /proc/[0-9]*/stat 2>/dev/null | awk -v s="$1" '{ sub(/^[0-9]+ \\(.*\\) /, ""); if ($1 != "Z" && $4 == s) print $3 }' | sort -u; }`,
  `fgs() { cat /proc/[0-9]*/stat 2>/dev/null | awk -v s="$1" '{ sub(/^[0-9]+ \\(.*\\) /, ""); if ($1 != "Z" && $4 == s && $6 > 0) print $6 }' | sort -u; }`,
  // Signal $2 to process $1's group (its box-only copy, never work/'s); on a tty process (its box-only mark), to its
  // terminal's processes instead, as a terminal delivers it: INT to the foreground group alone (Ctrl-C), TERM and KILL to
  // every group of the terminal's session (script would turn INT into TERM, and a script signalled itself exits 0):
  // script exits with the code its command ended with, and what its command left on the terminal is reached after
  // script is gone. Before script has its command, script itself. Each group is signalled once, and a send that finds
  // its group already gone is no failure: only a missing group is.
  'hit() { g=$(cat "$c/$1/pgid" 2>/dev/null); [ -n "$g" ] || return 1; t=; if [ -f "$c/$1/tty" ]; then s=$(cat "$c/$1/tsid" 2>/dev/null); if [ -n "$s" ]; then if [ "$2" = INT ]; then t=$(fgs "$s"); fi; [ -n "$t" ] || t=$(sgs "$s"); fi; fi; if [ -z "$t" ]; then kill -"$2" -"$g" 2>/dev/null; return 0; fi; for p in $t; do kill -"$2" -"$p" 2>/dev/null; done; return 0; }',
  'case $op in',
  'start)',
  '  if [ "$5" = 1 ] && ! command -v script >/dev/null 2>&1; then echo noscript; exit 0; fi',
  // util-linux's script alone takes -e (the command's exit code as script's own); busybox's refuses it, and always exits
  // 0 without it, so its terminal process would read as succeeded whatever the command did.
  '  if [ "$5" = 1 ] && ! script --version 2>&1 | grep -q util-linux; then echo notutil; exit 0; fi',
  '  mkdir -p "$c" || exit 1; [ -L "$d" ] && { echo linkdir; exit 0; }; mkdir -p "$d" || exit 1',
  '  k=0; until mkdir "$c/.lock" 2>/dev/null; do k=$((k+1)); if [ $k -ge 100 ]; then rmdir "$c/.lock" 2>/dev/null; k=0; fi; sleep 0.05; done',
  '  trap \'rmdir "$c/.lock" 2>/dev/null\' EXIT',
  '  n=$(running | wc -l); if [ "$n" -ge "$2" ]; then echo "full $n"; exit 0; fi',
  '  i=1; while [ -e "$d/$i" ] || [ -L "$d/$i" ] || [ -e "$c/$i" ]; do i=$((i+1)); done',
  '  mkdir "$d/$i" && mkdir "$c/$i" || exit 1',
  '  printf \'%s\' "$1" > "$c/$i/command"; date -u +%Y-%m-%dT%H:%M:%SZ > "$c/$i/started"; : > "$d/$i/output.log"',
  '  put "$i" command "$1"; put "$i" started "$(cat "$c/$i/started")" n',
  '  mkfifo "$c/$i/in" || exit 1; if [ "$5" = 1 ]; then : > "$c/$i/tty"; put "$i" tty ""; fi',
  '  setsid -f nohup sh -c "$4" agentrun-background "$d/$i" "$c/$i" "$3" "$w" "$1" "$5" </dev/null >/dev/null 2>"$c/$i/err" || exit 1',
  '  k=0; while [ ! -s "$c/$i/pgid" ] && [ ! -f "$c/$i/exit" ] && [ $k -lt 200 ]; do sleep 0.05; k=$((k+1)); done',
  '  [ -s "$c/$i/pgid" ] || [ -f "$c/$i/exit" ] || { cat "$c/$i/err" >&2; echo "process $i did not start" >&2; exit 1; }',
  '  put "$i" pid "$(cat "$c/$i/pgid" 2>/dev/null)" n; echo "started $i $(cat "$c/$i/pgid" 2>/dev/null)";;',
  'output)',
  '  known "$1" || { echo none; exit 0; }',
  '  st=$(state "$1"); echo "state $st"',
  '  openlog "$1"; r=$?; [ $r = 2 ] && { echo notlog; exit 0; }; [ $r = 3 ] && { echo noproc; exit 0; }; n=0; [ $r = 0 ] && n=$(($(wc -c < /proc/self/fd/3))); echo "size $n"',
  '  [ -f "$c/$1/capped" ] && echo capped; [ -f "$c/$1/ended" ] && echo ended; echo --',
  '  m=$((n - $2)); [ $m -gt "$3" ] && m=$3',
  '  if [ $m -gt 0 ] && [ $r = 0 ]; then tail -c +$(($2 + 1)) /proc/self/fd/3 | head -c $m | base64; fi;;',
  'input)',
  '  known "$1" || { echo none; exit 0; }',
  '  st=$(state "$1"); [ "$st" = running ] || { echo "state $st"; exit 0; }',
  '  [ -f "$c/$1/closed" ] && { echo closed; exit 0; }',
  '  if [ -n "$2" ]; then exec 3<>"$c/$1/in" || exit 1; printf \'%s\' "$2" >&3 || exit 1; exec 3>&-; fi',
  '  if [ "$3" = 1 ]; then : > "$c/$1/closed"; kill "$(cat "$c/$1/hold" 2>/dev/null)" 2>/dev/null; fi',
  '  echo sent;;',
  'signal)',
  '  known "$1" || { echo none; exit 0; }',
  '  st=$(state "$1"); [ "$st" = running ] || { echo "was $st"; exit 0; }',
  '  hit "$1" "$2" || { echo "was $st"; exit 0; }',
  '  k=0; while [ ! -f "$c/$1/exit" ] && [ $k -lt 40 ]; do sleep 0.05; k=$((k+1)); done',
  '  echo "state $(state "$1")";;',
  'list)',
  // Every running one, then the newest $1 others, chosen before any of their details is read: the list costs the same
  // however many ended before.
  '  t=0; o=0; picked=""; for i in $(ids | sort -rn); do t=$((t+1)); if [ -f "$c/$i/exit" ] || [ "$(state "$i")" != running ]; then [ $o -lt "$1" ] || continue; o=$((o+1)); fi; picked="$picked $i"; done',
  '  echo "total $t"',
  `  for i in $picked; do printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t' "$i" "$(state "$i")" "$(size "$i")" "$(cat "$c/$i/started" 2>/dev/null)" "$([ -f "$c/$i/ended" ] && echo ended)" "$([ -f "$c/$i/tty" ] && echo tty)"; head -c 200 "$c/$i/command" 2>/dev/null | base64 | tr -d '\\n'; echo; done;;`,
  'end)',
  '  n=0; for i in $(running); do : > "$c/$i/ended"; put "$i" ended ""; hit "$i" TERM; n=$((n+1)); done',
  '  k=0; while [ $k -lt 60 ] && [ -n "$(running)" ]; do sleep 0.05; k=$((k+1)); done',
  '  for i in $(running); do hit "$i" KILL; done',
  '  k=0; while [ $k -lt 40 ] && [ -n "$(running)" ]; do sleep 0.05; k=$((k+1)); done',
  '  for i in $(running); do r=$(cat "$c/$i/runner" 2>/dev/null); [ -n "$r" ] && kill -KILL -"$r" 2>/dev/null; done',
  // Every display copy rewritten from the box-only copies, by the checked rename, so a link planted at one since its start
  // does not stay in the run's files after the box is gone.
  '  for i in $(cids); do put "$i" command "$(cat "$c/$i/command" 2>/dev/null)"; put "$i" started "$(cat "$c/$i/started" 2>/dev/null)" n; [ -s "$c/$i/pgid" ] && put "$i" pid "$(cat "$c/$i/pgid")" n; if [ -f "$c/$i/tty" ]; then put "$i" tty ""; else drop "$i" tty; fi; if [ -f "$c/$i/capped" ]; then put "$i" capped "" n; else drop "$i" capped; fi; done',
  '  echo "ended $n";;',
  'esac',
].join("\n");

/** One shell word, quoted for `sh`: the value as given, whatever it holds (a NUL never reaches here). */
const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** A failed exec, in words. */
const failed = (result: ExecResult, timeoutS: number): string | undefined => {
  if (result.timedOut) return `timed out after ${timeoutS} s`;
  const code = exitCodeOf(result);
  return code === 0 ? undefined : `exit code ${code ?? "unknown"}`;
};

/** One operation on the run's computer, through its hands: its stdout. A call the computer cannot run, or that fails,
 *  throws. */
async function inBox(hands: Hands, op: string, args: readonly string[], signal: AbortSignal | undefined, timeoutS = 30): Promise<string> {
  let out = "";
  let said = "";
  const command = ["sh", "-c", quoted(SCRIPT), "agentrun-background", '"$PWD"', quoted(op), ...args.map(quoted)].join(" ");
  let result: ExecResult;
  try {
    result = await hands.exec(command, {
      timeoutS,
      onOutput: ({ stream, data }) => {
        if (stream === "stdout") out += data;
        else if (said.length < 2_000) said += data;
      },
    }, signal);
  } catch (error) {
    throw new Error(`the run's box did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.timedOut) throw new Error(`the run's box did not answer: ${failed(result, timeoutS)}`);
  const code = exitCodeOf(result);
  if (code !== 0) throw new Error(`the run's box answered with exit code ${code ?? "unknown"}${said.trim() ? `: ${said.trim().slice(0, 500)}` : ""}`);
  return out;
}

/** A process's id as a call gives it: digits only, so no call names a path. */
function idOf(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new Error(`${JSON.stringify(value)} is no background process id: an id is the number bash_background answered, such as "1" (bash_list shows them)`);
  return id;
}

type State = { state: "running" } | { state: "exited"; exit_code: number; signal?: string } | { state: "lost" } | { state: "unstarted" };

/** A state as the script says it. */
function stateOf(said: string): State {
  if (said === "running") return { state: "running" };
  if (said === "unstarted") return { state: "unstarted" };
  const exited = /^exited (\d+)$/.exec(said);
  if (!exited) return { state: "lost" };
  const code = Number(exited[1]);
  const signal = code > 128 ? SIGNAL_NAMES[code - 128] : undefined;
  return { state: "exited", exit_code: code, ...(signal ? { signal } : {}) };
}

/** A state in words: `running`, `exited with code 0`, `ended by signal TERM (exit code 143)`, or lost. */
function stateWords(state: State, ended = false): string {
  const atEnd = ended ? ", at the run's end" : "";
  if (state.state === "running") return "is running";
  if (state.state === "unstarted") return "was not started in this box (only its files in work/ remain)";
  if (state.state === "lost") return "is gone: what ran it ended first (its box was replaced, or its runner was killed), so its exit code is not known";
  return state.signal ? `ended by signal ${state.signal} (exit code ${state.exit_code})${atEnd}` : `exited with code ${state.exit_code}${atEnd}`;
}

const noSuch = (id: string) => new Error(`there is no background process ${id} in this run: bash_list shows them`);

/** The end of `bytes` that ends inside a UTF-8 character, left for the next page: how many bytes to keep (none, when the
 *  page holds only part of one character). */
function wholeChars(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

const decode = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64.replace(/\s+/g, ""), "base64"));
const intArg = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`);
  return value;
};
const answer = (text: string, details: unknown): ToolAnswer => ({ text, details });

const bashBackground: Executor = async (args, call) => {
  const command = String((args as { command?: unknown }).command ?? "");
  const tty = (args as { tty?: unknown }).tty === true;
  if (!command.trim()) throw new Error("command is the shell command to start");
  const said = (await inBox(call.hands, "start", [command, String(BACKGROUND_MAX), String(BACKGROUND_LOG_BYTES), RUNNER, tty ? "1" : "0"], call.signal)).trim();
  if (said === "noscript") throw new Error("this box has no `script` program (util-linux), so tty: true cannot run here: start the command without tty");
  if (said === "notutil") throw new Error("this box's `script` is not util-linux's (it takes no -e, so the command's exit code would be lost), so tty: true cannot run here: start the command without tty");
  if (said === "linkdir") throw new Error("work/background is a link, so no background process starts: remove it, and its logs go in a directory of their own again");
  const full = /^full (\d+)/.exec(said);
  if (full) throw new Error(`${full[1]} background processes already run in this run's box, the most at once (${BACKGROUND_MAX}): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.`);
  const started = /^started (\d+) ?(\d*)/.exec(said);
  if (!started) throw new Error(`the run's box did not start the process: ${said.slice(0, 300) || "it said nothing"}`);
  const [, id, group] = started;
  const log = `${BACKGROUND_DIR}/${id}/output.log`;
  return answer(`Started background process ${id}${group ? ` (process group ${group})` : ""}${tty ? " on a terminal" : ""}. Its output goes to ${log} in work/: read it with bash_output {"id": "${id}"}, write its stdin with bash_input, end it with bash_signal.`, { id, log, ...(group ? { pid: Number(group) } : {}), ...(tty ? { tty } : {}) });
};

const bashOutput: Executor = async (args, call) => {
  const given = args as { id?: unknown; offset?: unknown; max_bytes?: unknown };
  const id = idOf(given.id);
  const offset = intArg(given.offset, "offset", 0, BACKGROUND_LOG_BYTES, 0);
  const max = intArg(given.max_bytes, "max_bytes", 1, BACKGROUND_PAGE_BYTES, BACKGROUND_PAGE_BYTES);
  const said = await inBox(call.hands, "output", [id, String(offset), String(max)], call.signal);
  if (said.trim() === "none") throw noSuch(id);
  if (said.split("\n").includes("notlog")) throw new Error(`background process ${id}'s log is not read: ${BACKGROUND_DIR}/${id}/output.log (or a directory on its way) is a link or not a regular file, so it could name another file`);
  if (said.split("\n").includes("noproc")) throw new Error(`background process ${id}'s log is not read: this box has no /proc, by which a log is checked to be its own file before it is read`);
  const at = said.indexOf("\n--\n");
  const head = (at < 0 ? said : said.slice(0, at)).split("\n");
  const fact = (key: string) => head.find((line) => line === key || line.startsWith(`${key} `))?.slice(key.length + 1);
  const state = stateOf(fact("state") ?? "");
  const size = Number(fact("size") ?? 0);
  const capped = head.includes("capped");
  const ended = head.includes("ended");
  const read = at < 0 ? new Uint8Array() : decode(said.slice(at + 4));
  // A character the page would split is left for the next one, unless the process has ended and nothing follows.
  const keep = state.state === "running" || offset + read.length < size ? wholeChars(read) : read.length;
  // A page too small for the one character it starts with reads nothing, and says what to ask instead.
  if (keep === 0 && read.length > 0) throw new Error(`the character at byte ${offset} of background process ${id}'s output is longer than max_bytes ${max}: ask again with max_bytes 4 or more`);
  const bytes = read.subarray(0, keep);
  const next = offset + bytes.length;
  const more = next < size;
  const where = offset >= size && bytes.length === 0
    ? `No output past byte ${offset.toLocaleString("en-US")} (the log has ${size.toLocaleString("en-US")} bytes)${state.state === "running" ? "; call again later with the same offset for what comes next" : ""}.`
    : `Output bytes ${offset.toLocaleString("en-US")} to ${next.toLocaleString("en-US")} of ${size.toLocaleString("en-US")}${more ? `; call again with offset ${next} for the next part` : state.state === "running" ? `, all of it so far; call again with offset ${next} for what comes next` : ", the end"}.`;
  const cap = capped ? ` Its log reached the ${MIB} MiB cap, so later output was dropped.` : "";
  const text = new TextDecoder().decode(bytes);
  return answer(`Background process ${id} ${stateWords(state, ended)}. ${where}${cap}${text ? `\n\n${text}` : ""}`, { id, ...state, offset, next_offset: next, size, ...(capped ? { capped } : {}), ...(ended ? { ended_at_run_end: true } : {}) });
};

const bashInput: Executor = async (args, call) => {
  const given = args as { id?: unknown; text?: unknown; close?: unknown };
  const id = idOf(given.id);
  const text = typeof given.text === "string" ? given.text : "";
  if (Buffer.byteLength(text) > BACKGROUND_INPUT_BYTES) throw new Error(`text is at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call; send it in parts`);
  if (text.includes("\0")) throw new Error("text holds a NUL byte, which no shell argument carries");
  const close = given.close === true;
  if (!text && !close) throw new Error("text is what to write: give some, or close: true to close stdin");
  const said = (await inBox(call.hands, "input", [id, text, close ? "1" : "0"], call.signal, 15).catch((error: Error) => {
    throw new Error(`process ${id} did not take its input: ${error.message} (a process that does not read its stdin fills its pipe at 64 KiB)`);
  })).trim();
  if (said === "none") throw noSuch(id);
  if (said === "closed") throw new Error(`background process ${id}'s stdin is closed: an earlier bash_input closed it`);
  if (said.startsWith("state ")) throw new Error(`background process ${id} ${stateWords(stateOf(said.slice(6)))}, so it takes no input`);
  const bytes = Buffer.byteLength(text);
  return answer(`Wrote ${bytes.toLocaleString("en-US")} bytes to background process ${id}'s stdin${close ? ", then closed it" : ""}. Read what it answers with bash_output.`, { id, bytes, ...(close ? { closed: true } : {}) });
};

const bashSignal: Executor = async (args, call) => {
  const given = args as { id?: unknown; signal?: unknown };
  const id = idOf(given.id);
  const signal = typeof given.signal === "string" ? given.signal.trim().toUpperCase().replace(/^SIG/, "") : "";
  if (!(BACKGROUND_SIGNALS as readonly string[]).includes(signal)) throw new Error(`signal is one of ${BACKGROUND_SIGNALS.join(", ")}`);
  const said = (await inBox(call.hands, "signal", [id, signal], call.signal, 15)).trim();
  if (said === "none") throw noSuch(id);
  if (said.startsWith("was ")) throw new Error(`background process ${id} ${stateWords(stateOf(said.slice(4)))}, so no signal was sent`);
  const state = stateOf(said.replace(/^state /, ""));
  return answer(`Sent ${signal} to background process ${id}: it ${stateWords(state)}.${state.state === "running" ? " Send KILL to end it at once." : ""}`, { id, signal, ...state });
};

const bashList: Executor = async (_args, call) => {
  const said = await inBox(call.hands, "list", [String(BACKGROUND_LIST_MAX)], call.signal);
  const [first = "", ...rows] = said.split("\n");
  const total = Number(/^total (\d+)$/.exec(first)?.[1] ?? 0);
  const all = rows.filter(Boolean).map((line) => {
    const [id = "", state = "", size = "0", started = "", ended = "", tty = "", command = ""] = line.split("\t");
    return { id, ...stateOf(state), size: Number(size) || 0, ...(started ? { started } : {}), ...(ended ? { ended_at_run_end: true } : {}), ...(tty ? { tty: true } : {}), command: new TextDecoder().decode(decode(command)) };
  }).sort((a, b) => Number(b.id) - Number(a.id));
  const shown = [...all.filter((p) => p.state === "running"), ...all.filter((p) => p.state !== "running")].slice(0, BACKGROUND_LIST_MAX);
  if (!shown.length) return answer("No background processes in this run's box: bash_background starts one.", { processes: [] });
  const running = all.filter((p) => p.state === "running").length;
  const lines = shown.map((p) => `${p.id}: ${stateWords(p, p.ended_at_run_end === true)}; ${p.size.toLocaleString("en-US")} bytes of output; started ${p.started ?? "at an unknown time"}; ${JSON.stringify(p.command.replace(/\s+/g, " ").slice(0, 120))}${p.tty ? " (tty)" : ""}`);
  const left = total - shown.length;
  return answer(`${running} of at most ${BACKGROUND_MAX} running.\n${lines.join("\n")}${left > 0 ? `\n(and ${left} older ones that ended)` : ""}`, { running, processes: shown });
};

/** The background tools' executors, by name. */
export const BACKGROUND_EXECUTORS: Readonly<Record<string, Executor>> = {
  bash_background: bashBackground,
  bash_output: bashOutput,
  bash_input: bashInput,
  bash_signal: bashSignal,
  bash_list: bashList,
};

/** The run's end: every background process still running on the run's computer is sent TERM, then KILL after 3 s, and
 *  marked as ended at the run's end, so its runner writes its exit code and its log is whole before the computer goes.
 *  How many it ended. */
export async function endBackground(hands: Hands, signal?: AbortSignal): Promise<number> {
  const said = await inBox(hands, "end", [], signal, 20);
  return Number(/^ended (\d+)/.exec(said.trim())?.[1] ?? 0);
}
