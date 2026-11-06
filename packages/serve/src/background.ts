// Background processes in a sandbox run's box: `bash_background` starts a command and answers at once with its id;
// `bash_output` reads its output in pages, from a byte offset; `bash_input` writes to its stdin; `bash_signal` sends its
// process group TERM, INT or KILL; `bash_list` lists them. Every call is one short command in the box, on the same
// environment `bash` runs on (coding-tools.ts), so they work on every box that runs `bash`, and the permission gate that
// wraps the coding source takes them as it takes `bash`. Nothing new runs on this server.
//
// In the box, a start makes `work/background/<id>/` (the run's files show it) with `output.log` (stdout and stderr, the
// first BACKGROUND_LOG_BYTES of them) and display copies of `command`, `started`, `pid` (the command's process group)
// and, once it ends, `exit` (its code: 128 + n for signal n). Every file there can be written by the run's own file
// tools, so no call trusts one: the copies a call reads (the group, the exit code, the start time, the command, the
// run's-end mark) live in the box-only directory below, a copy in work/ is moved over its name from inside its checked
// directory (never written through a link planted there), and output.log is read only as a regular file reached through no link. The command runs under its own session (`setsid`), from a runner started with
// `setsid -f nohup`, which writes `exit` once the command's output is all in the log and no live process of its group
// is left, so a read that sees `exit` sees the whole log, and a child left running keeps the process running. The
// box-only directory is the box's TMPDIR (else /tmp), under `.agentrun-background/<id>/`, never work/: it holds the
// fifo the command reads as its stdin (a pull of a remote box refuses a pipe in work/), the runner's pid, the pid of
// the `sleep` that holds the fifo's write end open (so the command reads no end of input until `bash_input` closes it),
// and the copies every call trusts. A process with no box-only directory (a box before this one's, or a directory
// made in work/), or whose runner is gone without an exit code, is `lost`, and is never signalled.
//
// The run's end ends them (endBackground, from the server's settle, before the box is pulled and destroyed): TERM to
// each running group, KILL after 3 s, and an `ended` mark (with its display copy beside the log, in the run's files).
import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { BoxProvider } from "@parcha/pi-transport";
import { BOX_WORK } from "./place.js";
import { forModel } from "./result.js";

/** The most background processes that run at once in one run's box. */
export const BACKGROUND_MAX = 8;
/** The most bytes of output one background process's log keeps: later output is dropped, and the process runs on. */
export const BACKGROUND_LOG_BYTES = 16 * 1024 * 1024;
/** The most bytes of output one `bash_output` call answers, and its default. */
export const BACKGROUND_PAGE_BYTES = 48 * 1024;
/** The most bytes one `bash_input` call writes. */
export const BACKGROUND_INPUT_BYTES = 64 * 1024;
/** The most processes `bash_list` names: every running one, then the newest that ended. */
export const BACKGROUND_LIST_MAX = 40;
/** Where a background process's log and state live, under the run's work/. */
export const BACKGROUND_DIR = "background";
/** The signals `bash_signal` sends. */
export const BACKGROUND_SIGNALS = ["TERM", "INT", "KILL"] as const;
/** The tools, by name. */
export const BACKGROUND_TOOLS = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"] as const;
/** The tools that run a command in the box, never on this server: bash, and the background tools. The tool gate holds
 *  each to bash's setting (tool-gate.ts SHELL_FAMILY); under bash: ask, bash_output, bash_list and bash_signal run unasked
 *  (tool-gate.ts SHELL_WATCHERS), since an id reaches only this run's own processes (idOf, noSuch). */
export const SHELL_TOOLS: readonly string[] = ["bash", ...BACKGROUND_TOOLS];

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
  `put() { [ -n "$rw" ] || return 0; ( cd -P "$L" 2>/dev/null && [ "$(pwd -P)" = "$rw/background/\${L##*/}" ] || exit 0; t=$(mktemp ./.put.XXXXXX) || exit 0; printf '%s\\n' "$2" > "$t" && { mv -fT "$t" "./$1" 2>/dev/null || { [ -L "./$1" ] && rm -f "./$1"; mv -f "$t" "./$1"; }; } || rm -f "$t" ) 2>/dev/null; return 0; }`,
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
  'state() { if [ -f "$c/$1/exit" ]; then echo "exited $(cat "$c/$1/exit")"; elif alive "$(cat "$c/$1/runner" 2>/dev/null)"; then echo running; else echo lost; fi; }',
  // The ids this box started (c), and with them, for the list alone, those of work/ (a box before this one's).
  'cids() { for p in "$c"/*; do i=${p##*/}; case $i in ""|*[!0-9]*) continue;; esac; [ -d "$p" ] && echo "$i"; done; }',
  'ids() { { cids; [ -L "$d" ] || for p in "$d"/*; do i=${p##*/}; case $i in ""|*[!0-9]*) continue;; esac; echo "$i"; done; } | sort -un; }',
  'running() { for i in $(cids); do [ -f "$c/$i/exit" ] && continue; [ "$(state "$i")" = running ] && echo "$i"; done; }',
  // $1's log, opened first and then checked as opened (fd 3): the file the open reached is work/background/<id>/output.log
  // itself, by its real path (so through no link), and a regular file. Every read after is of that open file
  // (/proc/self/fd/3), so a link swapped in at its name after the check is never read. 0: open; 1: there is no log;
  // 2: it is not to be read (a link, not a regular file, or a box with no /proc to check it by).
  'openlog() { exec 3<&-; f="$d/$1/output.log"; [ -e "$f" ] || [ -L "$f" ] || return 1; [ -f "$f" ] && [ ! -L "$f" ] && [ -n "$rw" ] || return 2; exec 3< "$f" 2>/dev/null || return 2; [ "$(readlink /proc/self/fd/3 2>/dev/null)" = "$rw/background/$1/output.log" ] && [ -f /proc/self/fd/3 ] || { exec 3<&-; return 2; }; }',
  'size() { if openlog "$1"; then echo $(($(wc -c < /proc/self/fd/3))); exec 3<&-; else echo 0; fi; }',
  // A display copy in work/ (the runner's put, by id): from inside work/background/<id>, entered with cd -P and checked
  // by its real path, an exclusive new file there renamed over its name on the same filesystem; a failed check skips it.
  `put() { [ -n "$rw" ] || return 0; ( cd -P "$d/$1" 2>/dev/null && [ "$(pwd -P)" = "$rw/background/$1" ] || exit 0; t=$(mktemp ./.put.XXXXXX) || exit 0; if [ "$4" = n ]; then printf '%s\\n' "$3"; else printf '%s' "$3"; fi > "$t" && { mv -fT "$t" "./$2" 2>/dev/null || { [ -L "./$2" ] && rm -f "./$2"; mv -f "$t" "./$2"; }; } || rm -f "$t" ) 2>/dev/null; return 0; }`,
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
  '  openlog "$1"; r=$?; [ $r = 2 ] && { echo notlog; exit 0; }; n=0; [ $r = 0 ] && n=$(($(wc -c < /proc/self/fd/3))); echo "size $n"',
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
  '  echo "ended $n";;',
  'esac',
].join("\n");

/** One operation in the box, on the run's environment: its stdout. A call the box cannot run, or that fails, throws. */
async function inBox(given: ExecutionEnv | undefined, op: string, args: readonly string[], context: Context, timeout = 30): Promise<string> {
  if (!given) throw new Error("this call has no box to run in");
  const env = given;
  let out = "";
  let said = "";
  const work = typeof env.cwd === "string" && env.cwd ? env.cwd : BOX_WORK;
  const ran = await env.exec(["sh", "-c", SCRIPT, "agentrun-background", work, op, ...args], {
    timeout,
    onOutput: (text, _context, info) => {
      if (info.stream === "stdout") out += text;
      else if (said.length < 2_000) said += text;
    },
  }, context);
  if (!ran.ok) throw new Error(`the run's box did not answer: ${ran.error.message}`);
  if (ran.value.exitCode !== 0) throw new Error(`the run's box answered with exit code ${ran.value.exitCode}${said.trim() ? `: ${said.trim().slice(0, 500)}` : ""}`);
  return out;
}

/** A process's id as a call gives it: digits only, so no call names a path. */
function idOf(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new Error(`${JSON.stringify(value)} is no background process id: an id is the number bash_background answered, such as "1" (bash_list shows them)`);
  return id;
}

type State = { state: "running" } | { state: "exited"; exit_code: number; signal?: string } | { state: "lost" };

/** A state as the script says it. */
function stateOf(said: string): State {
  if (said === "running") return { state: "running" };
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
  if (state.state === "lost") return "is gone: its box was replaced before it ended, so its exit code is not known";
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

const ID_SCHEMA = { type: "string", pattern: "^[1-9][0-9]*$", description: "The process's id, as bash_background answered it (\"1\")." };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required }) as unknown as TSchema;

const bashBackground = defineTool({
  name: "bash_background",
  description: `Start a shell command in the background in the run's box, from its work/, and answer at once with its id. Each call is a fresh shell (bash, else sh). The command runs until it and every child it left in its process group (a server started with &) have exited, bash_signal ends it, or the run ends, which ends it. Its stdout and stderr go together to work/background/<id>/output.log, which the run's files keep: the first ${MIB} MiB of them, later output dropped while it runs on. Its stdin is a pipe that bash_input writes; tty: true gives it a terminal instead. At most ${BACKGROUND_MAX} run at once in a run's box. Read its output with bash_output, list them with bash_list.`,
  parameters: schema({
    command: { type: "string", minLength: 1, description: "The command, as you would give bash." },
    tty: { type: "boolean", description: "Run it on a terminal (a pty, through script in the box), for a program that needs one: a prompt, a REPL, a progress display. Its log then holds what the terminal shows (your input echoed, lines ending in \\r\\n); bash_input types into the terminal, and bash_signal INT is Ctrl-C to its foreground job." },
  }, ["command"]),
  execute: async (args, api, context) => {
    const command = String((args as { command?: unknown }).command ?? "");
    const tty = (args as { tty?: unknown }).tty === true;
    if (!command.trim()) throw new Error("command is the shell command to start");
    const said = (await inBox(api.env, "start", [command, String(BACKGROUND_MAX), String(BACKGROUND_LOG_BYTES), RUNNER, tty ? "1" : "0"], context)).trim();
    if (said === "noscript") throw new Error("this box has no `script` program (util-linux), so tty: true cannot run here: start the command without tty");
    if (said === "linkdir") throw new Error("work/background is a link, so no background process starts: remove it, and its logs go in a directory of their own again");
    const full = /^full (\d+)/.exec(said);
    if (full) throw new Error(`${full[1]} background processes already run in this run's box, the most at once (${BACKGROUND_MAX}): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.`);
    const started = /^started (\d+) ?(\d*)/.exec(said);
    if (!started) throw new Error(`the run's box did not start the process: ${said.slice(0, 300) || "it said nothing"}`);
    const [, id, group] = started;
    const log = `${BACKGROUND_DIR}/${id}/output.log`;
    return forModel(`Started background process ${id}${group ? ` (process group ${group})` : ""}${tty ? " on a terminal" : ""}. Its output goes to ${log} in work/: read it with bash_output {"id": "${id}"}, write its stdin with bash_input, end it with bash_signal.`, { details: { id, log, ...(group ? { pid: Number(group) } : {}), ...(tty ? { tty } : {}) } });
  },
});

const bashOutput = defineTool({
  name: "bash_output",
  description: `Read a background process's output (stdout and stderr together) from a byte offset: at most max_bytes (default and most ${BACKGROUND_PAGE_BYTES / 1024} KiB), with whether it still runs, its exit code once it has ended, the log's size, and the offset to read from next. Start at 0; pass the next offset to read on, also to see what a running process wrote since.`,
  parameters: schema({
    id: ID_SCHEMA,
    offset: { type: "integer", minimum: 0, description: "The byte to read from; 0, the start, when absent." },
    max_bytes: { type: "integer", minimum: 1, maximum: BACKGROUND_PAGE_BYTES, description: `The most bytes to read; ${BACKGROUND_PAGE_BYTES.toLocaleString("en-US")} when absent.` },
  }, ["id"]),
  replay: "safe",
  execute: async (args, api, context) => {
    const given = args as { id?: unknown; offset?: unknown; max_bytes?: unknown };
    const id = idOf(given.id);
    const offset = intArg(given.offset, "offset", 0, BACKGROUND_LOG_BYTES, 0);
    const max = intArg(given.max_bytes, "max_bytes", 1, BACKGROUND_PAGE_BYTES, BACKGROUND_PAGE_BYTES);
    const said = await inBox(api.env, "output", [id, String(offset), String(max)], context);
    if (said.trim() === "none") throw noSuch(id);
    if (said.split("\n").includes("notlog")) throw new Error(`background process ${id}'s log is not read: ${BACKGROUND_DIR}/${id}/output.log (or a directory on its way) is a link or not a regular file, so it could name another file (or this box has no /proc to check it by)`);
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
    return forModel(`Background process ${id} ${stateWords(state, ended)}. ${where}${cap}${text ? `\n\n${text}` : ""}`, { details: { id, ...state, offset, next_offset: next, size, ...(capped ? { capped } : {}), ...(ended ? { ended_at_run_end: true } : {}) } });
  },
});

const bashInput = defineTool({
  name: "bash_input",
  description: `Write text to a running background process's stdin, as given (end a line with \\n), at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call. close: true closes its stdin after the text, so the process reads the end of its input. To interrupt it, send bash_signal INT; a control character written here is only a byte.`,
  parameters: schema({
    id: ID_SCHEMA,
    text: { type: "string", description: "The bytes to write, as UTF-8; empty with close: true closes stdin alone." },
    close: { type: "boolean", description: "Close the process's stdin after the text." },
  }, ["id", "text"]),
  execute: async (args, api, context) => {
    const given = args as { id?: unknown; text?: unknown; close?: unknown };
    const id = idOf(given.id);
    const text = typeof given.text === "string" ? given.text : "";
    if (Buffer.byteLength(text) > BACKGROUND_INPUT_BYTES) throw new Error(`text is at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call; send it in parts`);
    if (text.includes("\0")) throw new Error("text holds a NUL byte, which no shell argument carries");
    const close = given.close === true;
    if (!text && !close) throw new Error("text is what to write: give some, or close: true to close stdin");
    const said = (await inBox(api.env, "input", [id, text, close ? "1" : "0"], context, 15).catch((error: Error) => {
      throw new Error(`process ${id} did not take its input: ${error.message} (a process that does not read its stdin fills its pipe at 64 KiB)`);
    })).trim();
    if (said === "none") throw noSuch(id);
    if (said === "closed") throw new Error(`background process ${id}'s stdin is closed: an earlier bash_input closed it`);
    if (said.startsWith("state ")) throw new Error(`background process ${id} ${stateWords(stateOf(said.slice(6)))}, so it takes no input`);
    const bytes = Buffer.byteLength(text);
    return forModel(`Wrote ${bytes.toLocaleString("en-US")} bytes to background process ${id}'s stdin${close ? ", then closed it" : ""}. Read what it answers with bash_output.`, { details: { id, bytes, ...(close ? { closed: true } : {}) } });
  },
});

const bashSignal = defineTool({
  name: "bash_signal",
  description: "Send a signal to a background process's process group: TERM asks it to stop, INT is Ctrl-C, KILL ends it at once. Answers its state after up to 2 s: a process that handles the signal may run on.",
  parameters: schema({ id: ID_SCHEMA, signal: { type: "string", enum: [...BACKGROUND_SIGNALS], description: "TERM, INT or KILL." } }, ["id", "signal"]),
  execute: async (args, api, context) => {
    const given = args as { id?: unknown; signal?: unknown };
    const id = idOf(given.id);
    const signal = typeof given.signal === "string" ? given.signal.trim().toUpperCase().replace(/^SIG/, "") : "";
    if (!(BACKGROUND_SIGNALS as readonly string[]).includes(signal)) throw new Error(`signal is one of ${BACKGROUND_SIGNALS.join(", ")}`);
    const said = (await inBox(api.env, "signal", [id, signal], context, 15)).trim();
    if (said === "none") throw noSuch(id);
    if (said.startsWith("was ")) throw new Error(`background process ${id} ${stateWords(stateOf(said.slice(4)))}, so no signal was sent`);
    const state = stateOf(said.replace(/^state /, ""));
    return forModel(`Sent ${signal} to background process ${id}: it ${stateWords(state)}.${state.state === "running" ? " Send KILL to end it at once." : ""}`, { details: { id, signal, ...state } });
  },
});

const bashList = defineTool({
  name: "bash_list",
  description: `List this run's background processes: each one's id, whether it runs or how it ended, its output's size and its command's start, every running one first, then the newest that ended (${BACKGROUND_LIST_MAX} at most).`,
  parameters: schema({}, []),
  replay: "safe",
  execute: async (_args, api, context) => {
    const said = await inBox(api.env, "list", [String(BACKGROUND_LIST_MAX)], context);
    const [first = "", ...rows] = said.split("\n");
    const total = Number(/^total (\d+)$/.exec(first)?.[1] ?? 0);
    const all = rows.filter(Boolean).map((line) => {
      const [id = "", state = "", size = "0", started = "", ended = "", tty = "", command = ""] = line.split("\t");
      return { id, ...stateOf(state), size: Number(size) || 0, ...(started ? { started } : {}), ...(ended ? { ended_at_run_end: true } : {}), ...(tty ? { tty: true } : {}), command: new TextDecoder().decode(decode(command)) };
    }).sort((a, b) => Number(b.id) - Number(a.id));
    const shown = [...all.filter((p) => p.state === "running"), ...all.filter((p) => p.state !== "running")].slice(0, BACKGROUND_LIST_MAX);
    if (!shown.length) return forModel("No background processes in this run's box: bash_background starts one.", { details: { processes: [] } });
    const running = all.filter((p) => p.state === "running").length;
    const lines = shown.map((p) => `${p.id}: ${stateWords(p, p.ended_at_run_end === true)}; ${p.size.toLocaleString("en-US")} bytes of output; started ${p.started ?? "at an unknown time"}; ${JSON.stringify(p.command.replace(/\s+/g, " ").slice(0, 120))}${p.tty ? " (tty)" : ""}`);
    const left = total - shown.length;
    return forModel(`${running} of at most ${BACKGROUND_MAX} running.\n${lines.join("\n")}${left > 0 ? `\n(and ${left} older ones that ended)` : ""}`, { details: { running, processes: shown } });
  },
});

/** The background tools, each run on the environment its call gives (the box's, coding-tools.ts). */
export const backgroundTools = (): ToolRegistration[] => [bashBackground, bashOutput, bashInput, bashSignal, bashList] as unknown as ToolRegistration[];

/** The run's end: every background process still running in run `runId`'s box (found by `label`) is sent TERM, then
 *  KILL after 3 s, and marked as ended at the run's end, so its runner writes its exit code and its log is whole before
 *  the box is pulled and destroyed. How many it ended; a run with no box ends none. */
export async function endBackground(boxes: BoxProvider, label: Record<string, string>, context: Context): Promise<number> {
  const { finish } = await import("@parcha/pi-transport");
  const listed = await boxes.list(label, context);
  if (!listed.ok) throw listed.error;
  let ended = 0;
  for (const ref of listed.value) {
    const attached = await boxes.attach(ref.id, context);
    if (!attached.ok) throw attached.error;
    if (!attached.value) continue;
    const started = await attached.value.exec(["sh", "-c", SCRIPT, "agentrun-background", BOX_WORK, "end"], { timeoutMs: 20_000 }, context);
    if (!started.ok) throw started.error;
    const done = await finish(started.value);
    if (!done.ok) throw done.error;
    const said = new TextDecoder().decode(done.value.stdout).trim();
    if (done.value.exitCode !== 0) throw new Error(`ending the box's background processes failed (exit code ${done.value.exitCode}): ${done.value.stderr.trim().slice(0, 300)}`);
    ended += Number(/^ended (\d+)/.exec(said)?.[1] ?? 0);
  }
  return ended;
}
