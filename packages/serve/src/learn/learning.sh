#!/bin/sh
# learning.sh: the local learning store's one writer and reader of an agent's learning folder, a git repository
# (learn/store-local.ts runs it). POSIX sh only (/bin/sh may be dash), git 2.32 or later. The store runs
# `sh <this file> <op> [args]` with the folder as its working directory, under an environment it names whole. The
# store's other kind (code.storage, learn/code-storage.ts) answers the same ops over its API: what one does, the other
# does.
#
# The host computes everything it can (the files, the snapshot it commits, the marker files); this script does the git
# plumbing:
#   1. the commit: `git fast-import` writes the blobs and ONE commit on a temporary ref, then
#      `update-ref refs/heads/main <new> <old>`, the compare and swap. A lost race exits 3 and writes nothing;
#   2. the working tree brought in line with the new main (read-tree -u --reset), for a person who works in the folder
#      by hand. No read goes through it: every read is git's.
# A run's merge carries the marker file `.agentrun/runs/<key>` and a purge's scrub `.agentrun/purged/<key>`, in its
# own commit: a merge of a key whose marker (either) is on <old>, or a scrub whose marker is, exits 6 naming the commit
# that added it, and writes nothing. Two racing on one <old> both pass that check; the compare and swap lets one land.
#
# Ops:
#   head                 main's commit on stdout, or nothing when there is none
#   init                 make the folder a repository when it is not one, then commit as `commit` does with no parent;
#                        main must not be there yet (else 3, with main on stdout)
#   commit <old>         commit on main from <old>
#   read <ref> [path...] <ref>'s tree (`git ls-tree -r -l -z`, the paths alone when named) and those blobs
#                        (`git cat-file --batch`), after a header line; 1 when <ref> is not in the repository
#   log <ref> <n> [path] <ref>'s first-parent history, newest first, at most <n> commits (0: all), those that changed
#                        <path> alone when named; 1 when <ref> is not in the repository
#   diff <commit>        each path <commit> changed against its first parent, its patch as git writes it (hunks only),
#                        or withheld past PATCH_CAP, as one JSON array; 1 when <commit> is not in the repository
# stdin, for init and commit: header lines, a blank line, then a fast-import stream:
#   ref <name>           the temporary ref the stream commits on (refs/agentrun/import-<hex>)
#   run <key>            a run's merge: its marker must not be on <old>, nor its key's purged marker (else 6)
#   purged <key>         a purge's scrub: its marker must not be on <old> (else 6)
#   absent <path>        <path> must not be on <old>, any mode, any type (else 4: "absent <path>" on stdout)
#   same <commit> <path> <path> must be the same on <commit> as on <old> (else 4: "same <path>" on stdout); a
#                        <commit> the repository does not hold fails it (the folder was reset since it was read)
#   seed <commit>        the commit a run was seeded from, which the repository must hold still (else 4:
#                        "seed <commit>" on stdout): a reset since merges nothing
# Exit: 0 done (the new main on stdout), 3 stale (main as it is on stdout), 4 a precondition failed, 5 main moved but
# the working tree could not be brought in line (the new main on stdout), 6 the marker is there already (the commit
# that added it on stdout), 7 the commit would change nothing (nothing written), else git's error on stderr.
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
LOG_FORMAT='%x1e%H%x1f%P%x1f%cI%x1f%B%x1d'

die() {
  printf 'learning.sh: %s\n' "$*" >&2
  exit 2
}

# Every git call: no hook, no fsmonitor, no signing, no transport.
g() {
  git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false \
    -c protocol.allow=never "$@"
}

tmp=$(mktemp -d) || die "no temporary folder"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' HUP INT TERM

# git 2.32 or later (GIT_CONFIG_GLOBAL).
version=$(git --version 2>/dev/null) || die "git is not on PATH"
floor=$(printf '%s\n' "$version" | awk '{ split($3, v, "."); print (v[1] > 2 || (v[1] == 2 && v[2] >= 32)) ? "ok" : "old" }')
[ "$floor" = ok ] || die "learning needs git 2.32 or later, and this machine has $version"

# main's commit, or nothing when there is none (no repository, or no main yet).
main_now() {
  [ -d "$GIT_DIR" ] || return 0
  g rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true
}

hex40() {
  case $1 in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ ${#1} -eq 40 ] || [ ${#1} -eq 64 ]
}

key_ok() {
  case $1 in
    '' | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
}

# Whether the repository holds commit $1.
holds() {
  [ -d "$GIT_DIR" ] && g cat-file -e "$1^{commit}" 2>/dev/null
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

# A link found where the script would write, in the words every learning read says it in.
link() {
  die "a link in the learning folder at $1 can't be followed, so nothing learned is read or written; remove the link"
}

# Each path the working tree is about to hold or lose ($tmp/paths: "<mode> <path>" lines), checked: no folder on its
# way may be a symbolic link, and the path itself may be one only where the new tree holds a link there, or the working
# tree's write would land where it points. Exits 2 naming the first; nothing is written.
no_links() {
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

# The commit that added marker $1 on $old (newest first, first parent), on stdout and exit 6, when $old holds it.
marker() {
  [ -n "$old" ] || return 0
  g cat-file -e "$old:$1" 2>/dev/null || return 0
  g log --first-parent -1 --format=%H "$old" -- "$1"
  exit 6
}

# The preconditions on $old: what must be absent, what must be the same as on another commit, the seed it must hold.
# Exits 4 naming each that failed.
preconditions() {
  : > "$tmp/failed"
  sed -n 's/^absent //p' "$tmp/head" > "$tmp/absent"
  while IFS= read -r p; do
    if [ -n "$old" ] && g cat-file -e "$old:$p" 2>/dev/null; then printf 'absent %s\n' "$p" >> "$tmp/failed"; fi
  done < "$tmp/absent"
  sed -n 's/^same //p' "$tmp/head" > "$tmp/same"
  while read -r c p; do
    # A commit this repository does not hold (the agent's learning reset after the run read it) is no ground to merge on.
    if ! g cat-file -e "$c^{commit}" 2>/dev/null; then
      printf 'same %s\n' "$p" >> "$tmp/failed"
      continue
    fi
    a=$(g rev-parse -q --verify "$c:$p" 2>/dev/null || true)
    b=
    [ -n "$old" ] && b=$(g rev-parse -q --verify "$old:$p" 2>/dev/null || true)
    [ "$a" = "$b" ] || printf 'same %s\n' "$p" >> "$tmp/failed"
  done < "$tmp/same"
  sed -n 's/^seed //p' "$tmp/head" > "$tmp/seed"
  while read -r c; do
    g cat-file -e "$c^{commit}" 2>/dev/null || printf 'seed %s\n' "$c" >> "$tmp/failed"
  done < "$tmp/seed"
  if [ -s "$tmp/failed" ]; then
    cat "$tmp/failed"
    exit 4
  fi
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
  run=$(sed -n 's/^run //p' "$tmp/head")
  [ -z "$run" ] || key_ok "$run" || die "a run's key is letters, digits, dots, dashes and underscores"
  cur=$(main_now)
  if [ "$cur" != "$old" ]; then
    printf '%s\n' "$cur"
    exit 3
  fi
  if [ -n "$run" ]; then
    marker ".agentrun/runs/$run"
    # A purged run (learn/purge.ts) merges no round again.
    marker ".agentrun/purged/$(printf '%s' "$run" | sed 's/\.r[0-9][0-9]*$//')"
  fi
  preconditions
  g fast-import --quiet --done < "$tmp/rest" > /dev/null || die "fast-import failed"
  new=$(g rev-parse -q --verify "$ref^{commit}") || die "fast-import made no commit"
  g update-ref -d "$ref" || die "the import ref could not be removed"
  if [ -n "$old" ]; then
    if [ "$(g rev-parse "$old^{tree}")" = "$(g rev-parse "$new^{tree}")" ]; then exit 7; fi
    g diff-tree -r --no-renames "$old" "$new" | awk -F '\t' '{ split($1, a, " "); print a[2] " " $2 }' > "$tmp/paths" || die "git diff-tree failed"
  else
    g ls-tree -r --full-tree "$new" | awk -F '\t' '{ split($1, a, " "); print a[1] " " $2 }' > "$tmp/paths" || die "ls-tree failed"
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
  if ! g read-tree -u --reset "$new" 2> "$tmp/checkout"; then
    cat "$tmp/checkout" >&2
    printf '%s\n' "$new"
    exit 5
  fi
  printf '%s\n' "$new"
}

# A rewrite's ref ($1): refs/agentrun/rewrite-<hex>, else die.
rewrite_ref() {
  case $1 in
    refs/agentrun/rewrite-[0-9a-f]*) ;;
    *) die "no rewrite ref" ;;
  esac
  case $1 in
    refs/agentrun/rewrite-*[!0-9a-f]*) die "the rewrite ref is not one this script takes" ;;
  esac
}

op=${1:-}
# Every way back to a history main no longer holds gone: every ref but main (a leftover import's, a rewrite's), the
# reflogs, and the objects nothing reaches then.
tidy_history() {
  g for-each-ref --format='%(refname)' > "$tmp/refs" || die "for-each-ref failed"
  while IFS= read -r r; do
    [ "$r" = refs/heads/main ] || g update-ref -d "$r" || die "ref $r could not be removed"
  done < "$tmp/refs"
  g reflog expire --expire=now --expire-unreachable=now --all || die "the reflog could not be expired"
  g gc --prune=now --quiet || die "git gc failed"
}

case $op in
  head)
    main_now
    ;;
  init)
    old=
    if [ ! -f "$GIT_DIR/HEAD" ]; then
      # Without GIT_DIR and GIT_WORK_TREE, so the repository records no path of this machine's. A first save racing
      # another fails its init on the other's config lock: it waits (up to 5 s) for that init to finish, then commits
      # from no main as the other did, and exactly one of them lands (the other is stale).
      (unset GIT_DIR GIT_WORK_TREE && g init -q --template= --initial-branch=main . > /dev/null 2> "$tmp/init.err") || {
        waited=0
        until [ -f "$GIT_DIR/HEAD" ] && [ ! -e "$GIT_DIR/config.lock" ] && g rev-parse -q --git-dir > /dev/null 2>&1; do
          waited=$((waited + 1))
          [ "$waited" -le 50 ] || { cat "$tmp/init.err" >&2; die "git init failed"; }
          sleep 0.1
        done
      }
    fi
    commit
    ;;
  commit)
    old=${2:-}
    hex40 "$old" || die "commit takes the main it commits from"
    [ -d "$GIT_DIR" ] || {
      printf '\n'
      exit 3
    }
    commit
    ;;
  read)
    ref=${2:-}
    hex40 "$ref" || die "read takes a commit"
    holds "$ref" || exit 1
    shift 2
    if [ $# -gt 0 ]; then
      g ls-tree -r -l -z --full-tree "$ref" -- "$@" > "$tmp/tree" || die "ls-tree failed"
    else
      g ls-tree -r -l -z --full-tree "$ref" > "$tmp/tree" || die "ls-tree failed"
    fi
    tr '\0' '\n' < "$tmp/tree" | awk '$2 == "blob" { print $3 }' > "$tmp/oids"
    : > "$tmp/blobs"
    if [ -s "$tmp/oids" ]; then g cat-file --batch < "$tmp/oids" > "$tmp/blobs" || die "cat-file failed"; fi
    printf 'agentrun-read 2 %s %s %s\n' "$ref" "$(($(wc -c < "$tmp/tree")))" "$(($(wc -c < "$tmp/blobs")))"
    cat "$tmp/tree" "$tmp/blobs"
    ;;
  log)
    ref=${2:-}
    n=${3:-0}
    hex40 "$ref" || die "log takes a commit"
    case $n in
      '' | *[!0-9]*) die "log takes a count" ;;
    esac
    holds "$ref" || exit 1
    path=${4:-}
    # A count of 0 is the whole history: git's own default, with no -n.
    set -- log --first-parent -z --name-only --no-renames "--format=$LOG_FORMAT"
    [ "$n" -gt 0 ] && set -- "$@" -n "$n"
    set -- "$@" "$ref"
    [ -n "$path" ] && set -- "$@" -- "$path"
    g "$@" || die "log failed"
    ;;
  diff)
    new=${2:-}
    hex40 "$new" || die "diff takes a commit"
    holds "$new" || exit 1
    if old=$(g rev-parse -q --verify "$new^1^{commit}" 2>/dev/null); then
      :
    else
      old=$(g hash-object -t tree --stdin < /dev/null) || die "no empty tree"
    fi
    g diff-tree -r --no-renames --name-only "$old" "$new" > "$tmp/changed" || die "git diff-tree failed"
    printf '['
    sep=
    while IFS= read -r p; do
      if g cat-file -e "$old:$p" 2>/dev/null; then was=1; else was=0; fi
      if g cat-file -e "$new:$p" 2>/dev/null; then now=1; else now=0; fi
      case $was$now in
        01) status=added ;;
        10) status=deleted ;;
        *) status=modified ;;
      esac
      g diff --no-ext-diff --no-textconv --no-renames --no-color --text -U3 "$old" "$new" -- "$p" > "$tmp/raw" || die "git diff failed on $p"
      sed -n '/^@@/,$p' "$tmp/raw" > "$tmp/patch"
      printf '%s{"path":"' "$sep"
      printf '%s\n' "$p" | json_text | sed 's/\\n$//' | tr -d '\n'
      if [ "$(($(wc -c < "$tmp/patch")))" -gt "$PATCH_CAP" ]; then
        printf '","status":"%s","withheld":"too_large"}' "$status"
      else
        printf '","status":"%s","patch":"' "$status"
        json_text < "$tmp/patch" | tr -d '\n'
        printf '"}'
      fi
      sep=,
    done < "$tmp/changed"
    printf ']\n'
    ;;
  build)
    # One commit of a rewrite's chain (stdin: fast-import's stream of it, on the rewrite's ref), its id printed. Nothing
    # reaches it but that ref until the rewrite moves main to the chain's tip.
    ref=${2:-}
    rewrite_ref "$ref"
    [ -d "$GIT_DIR" ] || die "there is no learning to rewrite"
    g fast-import --quiet --done > /dev/null || die "fast-import failed"
    g rev-parse -q --verify "$ref^{commit}" || die "fast-import made no commit"
    ;;
  drop)
    # A rewrite given up: its ref goes, and its commits with it at the next prune.
    ref=${2:-}
    rewrite_ref "$ref"
    [ -d "$GIT_DIR" ] && g update-ref -d "$ref" 2> /dev/null
    :
    ;;
  rewrite)
    # main moved from $2 to the chain's tip $3 (built on ref $4), by compare and swap: exit 3 naming main when it is not
    # $2. Then every way back to the old history goes: every ref but main (a leftover import's, a rewrite's), the
    # reflogs, and the objects nothing reaches then, so the old history's bytes leave the repository.
    old=${2:-}
    new=${3:-}
    ref=${4:-}
    hex40 "$old" && hex40 "$new" || die "rewrite takes the main it moves from and the chain's tip"
    rewrite_ref "$ref"
    [ -d "$GIT_DIR" ] || {
      printf '\n'
      exit 3
    }
    g ls-tree -r --full-tree "$new" | awk -F '\t' '{ split($1, a, " "); print a[1] " " $2 }' > "$tmp/paths" || die "ls-tree failed"
    no_links
    if ! g update-ref -m learning refs/heads/main "$new" "$old" 2> "$tmp/cas"; then
      g update-ref -d "$ref" 2> /dev/null
      cur=$(main_now)
      if [ "$cur" != "$old" ]; then
        printf '%s\n' "$cur"
        exit 3
      fi
      cat "$tmp/cas" >&2
      exit 2
    fi
    g read-tree -u --reset "$new" 2> "$tmp/checkout" || cat "$tmp/checkout" >&2
    tidy_history
    printf '%s\n' "$new"
    ;;
  tidy)
    # What a rewrite stopped after moving main left of the old history gone (a purge sent again runs it).
    [ -d "$GIT_DIR" ] || exit 0
    tidy_history
    ;;
  *)
    die "no op $op: head, init, commit, read, log, diff, build, drop, rewrite or tidy"
    ;;
esac
