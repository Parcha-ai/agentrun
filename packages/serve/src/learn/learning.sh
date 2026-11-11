#!/bin/sh
# learning.sh: the one writer of an agent's learning folder (learn/folder.ts runs it). POSIX sh only (/bin/sh may be
# dash), git 2.32 or later. The host writes it into the folder once per version as `.agentrun/learning-<sha8>.sh` and
# runs `sh .agentrun/learning-<sha8>.sh <op> [args]` there, the folder its working directory, under an environment it
# names whole. Each run is one hold of the folder: on an Archil disk one exec, so what it writes lands together or not
# at all; on a local folder one process.
#
# The host computes everything it can (the tree, the front matter, the history, the log, the snapshot) and hands it in;
# this script does the git plumbing, the file writes and the atomic swap, in this order, and nothing else:
#   1. the commit: `git fast-import` writes the blobs and ONE commit on a temporary ref, then
#      `update-ref refs/heads/main <new> <old>`, the compare and swap. A lost race exits 3 and writes nothing;
#   2. the working tree brought in line with the new main (read-tree -u --reset);
#   3. for a run's merge, `.agentrun/diffs/<run>.json`: each path's patch, parent against merge, as git diffs it;
#   4. `.agentrun/snapshot.json`, written to a temporary name and moved into place, LAST.
# So a reader that finds snapshot.json finds every file it names at its main, or a newer one (a write in flight).
#
# Ops:
#   init                 make the folder a repository when it is not one, then commit as `commit` does with no parent;
#                        main must not be there yet (else 3, with main on stdout)
#   commit <old> [run]   commit on main from <old>; with <run>, a run's merge, which writes its diff file
#   snapshot <main>      the working tree and snapshot.json written again at <main>, which must be main (else 3)
#   read [commit]        main's (or <commit>'s) tree, its first-parent log and its blobs, for the host to build a
#                        snapshot from; 1 when <commit> is not in the repository
#   has <main> <path>    whether <main> holds anything at <path>, any mode, any type (0 yes, 1 no)
# stdin, for init, commit and snapshot: header lines, a blank line, then (init and commit) a fast-import stream:
#   ref <name>           the temporary ref the stream commits on (refs/agentrun/import-<hex>)
#   snapshot <json>      snapshot.json, one line, where a \001M\001 stands for the new main
#   path <path>          (a merge) a path its diff covers
#   absent <path>        <path> must not be on <old>, any mode, any type (else 4: "absent <path>" on stdout)
#   same <commit> <path> <path> must be the same on <commit> as on <old> (else 4: "same <path>" on stdout)
# Exit: 0 done (the new main on stdout), 3 stale (main as it is on stdout), 4 a precondition failed, 5 main moved but
# the files could not be brought in line (the new main on stdout; no snapshot written), else git's error on stderr.
set -u
set -f

LC_ALL=C
export LC_ALL
# The repository is the folder's own .git, named outright: never one found above it. No system or global config, no
# replace refs, no lazy fetch, no prompt.
GIT_DIR=$PWD/.git
GIT_WORK_TREE=$PWD
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_ATTR_NOSYSTEM=1
GIT_NO_REPLACE_OBJECTS=1
GIT_NO_LAZY_FETCH=1
GIT_OPTIONAL_LOCKS=0
GIT_TERMINAL_PROMPT=0
export GIT_DIR GIT_WORK_TREE GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_ATTR_NOSYSTEM GIT_NO_REPLACE_OBJECTS GIT_NO_LAZY_FETCH GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT

ZERO=0000000000000000000000000000000000000000
PATCH_CAP=65536
PH=$(printf '\001M\001')
LOG_FORMAT='%x1e%H%x1f%cI%x1f%s%x1f%b%x1f%(trailers:key=Run-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Changed-By,valueonly,separator=%x2C)%x1f%(trailers:key=Approved-Via,valueonly,separator=%x2C)'

die() {
  printf 'learning.sh: %s\n' "$*" >&2
  exit 2
}

# Every git call: no hook, no fsmonitor, no signing, no transport; objects and refs synced where git can (2.36+).
g() {
  git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false \
    -c protocol.allow=never -c core.fsync=committed "$@"
}

tmp=$(mktemp -d) || die "no temporary folder"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' HUP INT TERM

# git 2.32 or later (GIT_CONFIG_GLOBAL).
version=$(git --version 2>/dev/null) || die "git is not on PATH"
floor=$(printf '%s\n' "$version" | awk '{ split($3, v, "."); print (v[1] > 2 || (v[1] == 2 && v[2] >= 32)) ? "ok" : "old" }')
[ "$floor" = ok ] || die "learning needs git 2.32 or later, and this folder's exec has $version"

# main's commit, or nothing when there is none (no repository, or no main yet).
main_now() {
  [ -d "$GIT_DIR" ] || return 0
  g rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true
}

# Files synced where the platform syncs a file alone (GNU coreutils); elsewhere the exec's own end makes them durable.
durable() {
  sync -- "$@" 2> /dev/null || true
}

hex40() {
  case $1 in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ ${#1} -eq 40 ] || [ ${#1} -eq 64 ]
}

# Each line of stdin as a JSON string's content: backslash, quote and every control character escaped, a newline as \n
# after each line; any other byte as it is (the texts are UTF-8).
json_text() {
  awk 'BEGIN {
    for (i = 1; i < 32; i++) m[sprintf("%c", i)] = sprintf("\\u%04x", i)
    m["\t"] = "\\t"; m["\r"] = "\\r"; m["\\"] = "\\\\"; m["\""] = "\\\""; m[sprintf("%c", 127)] = "\\u007f"
  }
  {
    s = $0; out = ""; n = length(s)
    for (i = 1; i <= n; i++) { c = substr(s, i, 1); out = out ((c in m) ? m[c] : c) }
    printf "%s\\n", out
  }'
}

# stdin kept whole in $tmp/in, its header in $tmp/head and what follows the blank line in $tmp/rest.
take_stdin() {
  cat > "$tmp/in" || die "stdin could not be read"
  n=$(sed -n -e '/^$/{' -e '=' -e 'q' -e '}' "$tmp/in")
  [ -n "$n" ] || die "stdin has no blank line after its header"
  if [ "$n" -gt 1 ]; then sed -n "1,$((n - 1))p" "$tmp/in" > "$tmp/head"; else : > "$tmp/head"; fi
  tail -n "+$((n + 1))" "$tmp/in" > "$tmp/rest"
}

# The snapshot from the header, its \001M\001 the new main, written to a temporary name beside snapshot.json; the name
# in $snap_tmp.
stage_snapshot() {
  mkdir -p .agentrun || die "no .agentrun folder"
  grep -q '^snapshot ' "$tmp/head" || die "stdin names no snapshot"
  snap_tmp=$(mktemp .agentrun/snapshot.json.XXXXXX) || die "no temporary snapshot"
  sed -n 's/^snapshot //p' "$tmp/head" | sed "s/$PH/$1/g" > "$snap_tmp" || die "the snapshot could not be written"
}

# The snapshot moved into place: the last write of every op.
place_snapshot() {
  if [ "${AGENTRUN_LEARNING_FAIL:-}" = before-snapshot ]; then
    rm -f "$snap_tmp"
    die "failed before the snapshot, as the test asked"
  fi
  durable "$snap_tmp"
  mv -f "$snap_tmp" .agentrun/snapshot.json || die "the snapshot could not be moved into place"
  durable .agentrun/snapshot.json .agentrun
}

# The working tree as commit $1 holds it: files main no longer holds removed, the rest written. Untracked files
# (.agentrun/) are left alone.
check_out() {
  g read-tree -u --reset "$1" 2> "$tmp/checkout"
}

# Each path the working tree is about to hold or lose ($tmp/paths: "<mode> <path>" lines, mode 000000 for one it
# loses), checked: no folder on its way may be a symbolic link, and the path itself may be one only where main holds a
# link there, or the working tree's write would land where it points. The host's own folder too. Exits 2 naming the
# first; nothing is written.
no_links() {
  for q in .agentrun .agentrun/diffs .agentrun/snapshot.json; do
    [ -L "$q" ] && link "$q"
  done
  while read -r mode p; do
    [ -L "$p" ] && [ "$mode" != 120000 ] && link "$p"
    q=$p
    while :; do
      case $q in
        */*) q=${q%/*} ;;
        *) break ;;
      esac
      [ -L "$q" ] && link "$q"
    done
  done < "$tmp/paths"
}

# A link found where the script would write, in the words every learning read says it in.
link() {
  die "a link in the learning folder at $1 can't be followed, so nothing learned is read or written; remove the link"
}

# "<mode> <path>" of every path commit $1 holds.
paths_of() {
  g ls-tree -r --full-tree "$1" | awk -F '\t' '{ split($1, a, " "); print a[1] " " $2 }' > "$tmp/paths" || die "ls-tree failed"
}

# The preconditions on $old: what must be absent, and what must be the same as on another commit. Exits 4 naming each
# that failed.
preconditions() {
  : > "$tmp/failed"
  sed -n 's/^absent //p' "$tmp/head" > "$tmp/absent"
  while IFS= read -r p; do
    if [ -n "$old" ] && g cat-file -e "$old:$p" 2>/dev/null; then printf 'absent %s\n' "$p" >> "$tmp/failed"; fi
  done < "$tmp/absent"
  sed -n 's/^same //p' "$tmp/head" > "$tmp/same"
  while read -r c p; do
    a=$(g rev-parse -q --verify "$c:$p" 2>/dev/null || true)
    b=$(g rev-parse -q --verify "$old:$p" 2>/dev/null || true)
    [ "$a" = "$b" ] || printf 'same %s\n' "$p" >> "$tmp/failed"
  done < "$tmp/same"
  if [ -s "$tmp/failed" ]; then
    cat "$tmp/failed"
    exit 4
  fi
}

# The diff of run $1's merge: each header path changed between $old and $new, its patch as git writes it (hunks only),
# or withheld past PATCH_CAP; written to a temporary name and moved into place.
write_diff() {
  mkdir -p .agentrun/diffs || die "no diffs folder"
  out=$(mktemp ".agentrun/diffs/$1.json.XXXXXX") || die "no temporary diff"
  printf '{"v":1,"run":"%s","merge":"%s","parent":"%s","files":[' "$1" "$new" "$old" > "$out"
  sep=
  for p in $(sed -n 's/^path //p' "$tmp/head"); do
    if g cat-file -e "$old:$p" 2>/dev/null; then was=1; else was=0; fi
    if g cat-file -e "$new:$p" 2>/dev/null; then now=1; else now=0; fi
    case $was$now in
      00) continue ;;
      01) status=added ;;
      10) status=deleted ;;
      *)
        [ "$(g rev-parse "$old:$p")" = "$(g rev-parse "$new:$p")" ] && continue
        status=modified
        ;;
    esac
    g diff --no-ext-diff --no-textconv --no-renames --no-color --text -U3 "$old" "$new" -- "$p" > "$tmp/raw" || die "git diff failed on $p"
    sed -n '/^@@/,$p' "$tmp/raw" > "$tmp/patch"
    if [ "$(($(wc -c < "$tmp/patch")))" -gt "$PATCH_CAP" ]; then
      printf '%s{"path":"%s","status":"%s","withheld":"too_large"}' "$sep" "$p" "$status" >> "$out"
    else
      printf '%s{"path":"%s","status":"%s","patch":"' "$sep" "$p" "$status" >> "$out"
      json_text < "$tmp/patch" >> "$out"
      printf '"}' >> "$out"
    fi
    sep=,
  done
  printf ']}\n' >> "$out"
  durable "$out"
  mv -f "$out" ".agentrun/diffs/$1.json" || die "the diff could not be moved into place"
}

commit() {
  take_stdin
  ref=$(sed -n 's/^ref //p' "$tmp/head")
  case $ref in
    refs/agentrun/import-[0-9a-f]*) ;;
    *) die "stdin names no import ref" ;;
  esac
  case $ref in
    *[!0-9a-z/-]*) die "the import ref is not one this script takes" ;;
  esac
  cur=$(main_now)
  if [ "$cur" != "$old" ]; then
    printf '%s\n' "$cur"
    exit 3
  fi
  preconditions
  g fast-import --quiet --done < "$tmp/rest" > /dev/null || die "fast-import failed"
  new=$(g rev-parse -q --verify "$ref^{commit}") || die "fast-import made no commit"
  g update-ref -d "$ref" || die "the import ref could not be removed"
  if [ -n "$old" ]; then
    g diff-tree -r --no-renames "$old" "$new" | awk -F '\t' '{ split($1, a, " "); print a[2] " " $2 }' > "$tmp/paths" || die "git diff-tree failed"
  else
    paths_of "$new"
  fi
  no_links
  if ! g update-ref -m learning refs/heads/main "$new" "${old:-$ZERO}" 2> "$tmp/cas"; then
    cur=$(main_now)
    if [ "$cur" != "$old" ]; then
      printf '%s\n' "$cur"
      exit 3
    fi
    cat "$tmp/cas" >&2
    exit 2
  fi
  if ! check_out "$new"; then
    cat "$tmp/checkout" >&2
    printf '%s\n' "$new"
    exit 5
  fi
  [ -n "$run" ] && write_diff "$run"
  stage_snapshot "$new"
  place_snapshot
  printf '%s\n' "$new"
}

op=${1:-}
case $op in
  init)
    old=
    run=
    if [ ! -d "$GIT_DIR" ]; then
      # Without GIT_DIR and GIT_WORK_TREE, so the repository records no path of this machine's.
      (unset GIT_DIR GIT_WORK_TREE && g init -q --template= --initial-branch=main . > /dev/null) || die "git init failed"
    fi
    # The host's folder is never the repository's: kept out of git's view of the working tree.
    if ! grep -qx '/.agentrun/' "$GIT_DIR/info/exclude" 2> /dev/null; then
      mkdir -p "$GIT_DIR/info" && printf '/.agentrun/\n' >> "$GIT_DIR/info/exclude" || die "the exclude file could not be written"
    fi
    commit
    ;;
  commit)
    old=${2:-}
    run=${3:-}
    hex40 "$old" || die "commit takes the main it commits from"
    case $run in
      *[!A-Za-z0-9._-]*) die "a run id is letters, digits, dots, dashes and underscores" ;;
    esac
    [ -d "$GIT_DIR" ] || {
      printf '\n'
      exit 3
    }
    commit
    ;;
  snapshot)
    old=${2:-}
    hex40 "$old" || die "snapshot takes the main it is written at"
    take_stdin
    cur=$(main_now)
    if [ "$cur" != "$old" ]; then
      printf '%s\n' "$cur"
      exit 3
    fi
    paths_of "$old"
    no_links
    if ! check_out "$old"; then
      cat "$tmp/checkout" >&2
      printf '%s\n' "$old"
      exit 5
    fi
    stage_snapshot "$old"
    place_snapshot
    printf '%s\n' "$old"
    ;;
  read)
    if [ -n "${2:-}" ]; then
      hex40 "$2" || die "read takes a commit"
      g cat-file -e "$2^{commit}" 2> /dev/null || exit 1
      main=$2
    else
      main=$(main_now)
    fi
    : > "$tmp/tree"
    : > "$tmp/log"
    : > "$tmp/blobs"
    if [ -n "$main" ]; then
      g ls-tree -r -l -z --full-tree "$main" > "$tmp/tree" || die "ls-tree failed"
      g log --first-parent -z --name-only --no-renames "--format=$LOG_FORMAT" "$main" > "$tmp/log" || die "log failed"
      g ls-tree -r --full-tree "$main" > "$tmp/list" || die "ls-tree failed"
      awk '$2 == "blob" { print $3 }' "$tmp/list" > "$tmp/oids"
      g cat-file --batch < "$tmp/oids" > "$tmp/blobs" || die "cat-file failed"
    fi
    printf 'agentrun-read 1 %s %s %s %s\n' "${main:-none}" "$(($(wc -c < "$tmp/tree")))" "$(($(wc -c < "$tmp/log")))" "$(($(wc -c < "$tmp/blobs")))"
    cat "$tmp/tree" "$tmp/log" "$tmp/blobs"
    ;;
  has)
    main=${2:-}
    path=${3:-}
    hex40 "$main" || die "has takes a main"
    [ -n "$path" ] || die "has takes a path"
    g cat-file -e "$main:$path" 2> /dev/null || exit 1
    ;;
  *)
    die "no op $op: init, commit, snapshot, read or has"
    ;;
esac
