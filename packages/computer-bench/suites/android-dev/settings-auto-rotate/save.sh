# Setup, run on the phone as: sh -c "<this file>" sh "NAMESPACE KEY"... Keep the phone's own value of each setting once,
# one "NAMESPACE KEY VALUE" line each, in this run's .orig file (a retried setup keeps the first copy), for restore.sh.
# "uimode night" is night mode, kept as `cmd uimode night`'s last word.
f=/data/local/tmp/computer-bench-{{nonce}}.orig
[ -e "$f" ] && exit 0
for one in "$@"; do
	set -- $one
	case "$1" in
	uimode) echo "uimode night $(cmd uimode night | sed 's/.* //')" ;;
	*) echo "$1 $2 $(settings get "$1" "$2")" ;;
	esac
done > "$f.part" && mv "$f.part" "$f"
