#!/bin/sh
# A fake `tailscale` for tests (service.test.mjs, install-walk.sh), copied as `tailscale` into a folder first on PATH. It
# changes nothing on the machine: its state is files in $FAKE_TAILSCALE_DIR, and each call's arguments are appended to
# its `calls` file.
#   mode     ok (default): logged in, HTTPS certificates on; missing-https; logged-out; down (tailscaled not running);
#            denied (a non-operator on Linux: serve settings refused)
#   served   the proxy target of https://box.tail1234.ts.net/ (empty: none)
#   funnel   present: Funnel is on for box.tail1234.ts.net:443
#   other    present: another serve entry, https://box.tail1234.ts.net:8443/ to http://127.0.0.1:3000
set -eu
dir=${FAKE_TAILSCALE_DIR:?names the folder of the fake state}
# Shell builtins only, so a test can run it with nothing else on PATH (a real tailscale there would be found too).
mode=ok
[ ! -f "$dir/mode" ] || read -r mode < "$dir/mode"
served=
[ ! -s "$dir/served" ] || read -r served < "$dir/served"
host=box.tail1234.ts.net
printf '%s\n' "$*" >> "$dir/calls"

denied() {
  printf "Access denied: serve config denied\n\nUse 'sudo tailscale %s'.\nTo not require root, use 'sudo tailscale set --operator=\$USER' once.\n" "$*" >&2
  exit 1
}

case "$*" in
  version) echo 1.90.6 ;;
  "status --json")
    case $mode in
      down)
        echo "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)" >&2
        exit 1
        ;;
      logged-out) echo '{"BackendState":"NeedsLogin","Self":{"DNSName":""},"CertDomains":null}' ;;
      missing-https) echo "{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"$host.\"},\"CertDomains\":null}" ;;
      *) echo "{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"$host.\"},\"CertDomains\":[\"$host\"]}" ;;
    esac
    ;;
  "serve status --json")
    tcp=
    web=
    if [ -n "$served" ]; then
      tcp="\"443\":{\"HTTPS\":true}"
      web="\"$host:443\":{\"Handlers\":{\"/\":{\"Proxy\":\"$served\"}}}"
    fi
    if [ -f "$dir/other" ]; then
      tcp="${tcp:+$tcp,}\"8443\":{\"HTTPS\":true}"
      web="${web:+$web,}\"$host:8443\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:3000\"}}}"
    fi
    funnel=
    [ ! -f "$dir/funnel" ] || funnel=",\"AllowFunnel\":{\"$host:443\":true}"
    if [ -n "$tcp" ]; then echo "{\"TCP\":{$tcp},\"Web\":{$web}$funnel}"; else echo "{}"; fi
    ;;
  "serve --bg --https=443 "*)
    [ "$mode" != denied ] || denied "$@"
    printf '%s\n' "$4" > "$dir/served"
    printf 'Available within your tailnet:\n\nhttps://%s/\n|-- proxy %s\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=443 off\n' "$host" "$4"
    ;;
  "serve --https=443 off")
    [ "$mode" != denied ] || denied "$@"
    : > "$dir/served"
    ;;
  *)
    echo "fake tailscale: no answer for: $*" >&2
    exit 2
    ;;
esac
