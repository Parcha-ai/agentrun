#!/bin/sh
# AgentRun Server on Fly.io, from fly.toml beside this script (deploy/README.md#flyio). It makes the app, then its token
# and seal key with openssl, once, as Fly secrets: handed to `fly secrets import` on stdin, never printed, never in a
# file or on a command line. Then it deploys one Machine with its volume and prints the setup link from the log.
# Run it again, with the same region, to upgrade to the image fly.toml pins: it keeps the app, the secrets and the volume.
#
#   sh deploy/fly/launch.sh <app name> [region]     (region: iad unless given; `fly platform regions` lists them)
set -eu

app=${1:-}
region=${2:-iad}
case $app in
  "" | -* | *[!a-z0-9-]*)
    echo "launch.sh: name the app in lowercase letters, digits and dashes: sh deploy/fly/launch.sh <app name> [region]" >&2
    exit 2 ;;
esac
case $region in
  "" | *[!a-z]*) echo "launch.sh: $region is not a Fly region (fly platform regions lists them)" >&2; exit 2 ;;
esac
for tool in fly openssl; do
  command -v "$tool" > /dev/null 2>&1 || { echo "launch.sh: $tool is not installed (flyctl: https://fly.io/docs/flyctl/install/)" >&2; exit 1; }
done
config=$(cd "$(dirname "$0")" && pwd)/fly.toml

fly status -a "$app" > /dev/null 2>&1 || fly apps create "$app"

# Made only when Fly has none: a new seal key would leave every saved key sealed under the old one unreadable.
names=$(fly secrets list -a "$app")
has() { printf '%s\n' "$names" | grep -qw "$1"; }
token= seal= url=
has AGENTRUN_TOKEN || token=$(openssl rand -hex 32)
has AGENTRUN_SEAL_KEY || seal=$(openssl rand -base64 32)
has AGENTRUN_PUBLIC_URL || url=https://$app.fly.dev/
if [ -n "$token$seal$url" ]; then
  {
    [ -z "$token" ] || printf 'AGENTRUN_TOKEN=%s\n' "$token"
    [ -z "$seal" ] || printf 'AGENTRUN_SEAL_KEY=%s\n' "$seal"
    [ -z "$url" ] || printf 'AGENTRUN_PUBLIC_URL=%s\n' "$url"
  } | fly secrets import --stage -a "$app"
fi
token= seal=

# One Machine: the SQLite store is on its one volume, which the first deploy makes from fly.toml's [[mounts]].
fly deploy -a "$app" -c "$config" --primary-region "$region" --ha=false --yes

echo ""
echo "AgentRun is at https://$app.fly.dev/"
line=$(fly logs -a "$app" --no-tail 2> /dev/null | sed -n 's/.*\(Set up this server: .*\)$/\1/p' | tail -n 1) || line=
[ -z "$line" ] || echo "$line"
echo "The setup code again later: fly logs -a $app --no-tail | grep 'Set up this server' | tail -n 1"
