# Teardown, run on the phone as: sh -c "<this file>". Setup saved the phone's own values once, one "NAMESPACE KEY VALUE"
# line each, in this run's .orig file; put each back (a setting it had none of is deleted), then drop the file.
# NAMESPACE uimode is night mode, its VALUE `cmd uimode night`'s last word (yes, no or auto).
f=/data/local/tmp/computer-bench-{{nonce}}.orig
[ -e "$f" ] || exit 0
while read -r ns key v; do
	case "$ns:$v" in
	uimode:*) cmd uimode night "$v" > /dev/null ;;
	*:null | *:) settings delete "$ns" "$key" > /dev/null ;;
	*) settings put "$ns" "$key" "$v" ;;
	esac
done < "$f"
rm -f "$f"
