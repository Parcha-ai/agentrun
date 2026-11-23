#!/bin/sh
# AgentRun Server on Fly.io, from fly.toml beside this script (deploy/README.md#flyio). It makes the app, then its token
# and seal key with openssl, once, as Fly secrets: handed to `fly secrets import` on stdin, never printed, never in a
# file or on a command line. Then it deploys one Machine with its volume and prints the setup link from the log.
# Run it again to upgrade to the image fly.toml pins: it keeps the app, the secrets and the volume, and deploys in the
# volume's region.
#
#   sh deploy/fly/launch.sh <app name> [region]     (region: iad unless given; `fly platform regions` lists them)

# `sh -x` would print the token and the seal key with each command that holds them, so tracing stays off.
set +x
set -eu
# Same-named variables from the caller's environment are exported: one would take the key into fly's environment.
unset token seal url names volumes at

app=${1:-}
region=${2:-}
case $app in
  "" | -* | *[!a-z0-9-]*)
    echo "launch.sh: name the app in lowercase letters, digits and dashes: sh deploy/fly/launch.sh <app name> [region]" >&2
    exit 2 ;;
esac
case $region in
  *[!a-z0-9]*) echo "launch.sh: $region is not a Fly region (fly platform regions lists them)" >&2; exit 2 ;;
esac
for tool in fly openssl; do
  command -v "$tool" > /dev/null 2>&1 || { echo "launch.sh: $tool is not installed (flyctl: https://fly.io/docs/flyctl/install/)" >&2; exit 1; }
done
config=$(cd "$(dirname "$0")" && pwd)/fly.toml

fly status -a "$app" > /dev/null 2>&1 || fly apps create "$app"

# The first deploy made the volume in its region. A deploy to another region would make a second, empty one there, so a
# run with no region deploys where the volume is, and one naming another region stops.
volumes=$(fly volumes list -a "$app" --json) || { echo "launch.sh: fly volumes list -a $app failed" >&2; exit 1; }
volumes=$(printf '%s' "$volumes" | tr -d ' \t\r\n')
case $volumes in
  "[]" | null | "[{"*"}]") ;;
  *) echo "launch.sh: fly volumes list -a $app --json gave no list of volumes this script can read" >&2; exit 1 ;;
esac
at=$(printf '%s' "$volumes" | tr '{' '\n' | grep '"name":"agentrun_data"' | sed -n 's/.*"region":"\([a-z0-9]*\)".*/\1/p' | sort -u)
case $at in
  *"
"*) echo "launch.sh: $app has agentrun_data volumes in more than one region ($(echo $at)); keep the one with the data" >&2; exit 1 ;;
esac
if [ -n "$at" ] && [ -n "$region" ] && [ "$region" != "$at" ]; then
  echo "launch.sh: $app's volume is in $at, so a deploy to $region would start on a new, empty one: run it with $at, or with no region" >&2
  exit 2
fi
region=${at:-${region:-iad}}

# Made only when Fly has none: a new seal key would leave every saved key sealed under the old one unreadable. So the
# names come from flyctl's JSON (an array of {name, digest, status}), and anything else stops the script before it
# makes a secret: a list that failed, came back empty on stdout, or came in a shape this script can't read.
names=$(fly secrets list -a "$app" --json) || {
  echo "launch.sh: fly secrets list -a $app failed, so no secret was made (a new seal key over the one Fly has would lose what it sealed)" >&2
  exit 1
}
names=$(printf '%s' "$names" | tr -d ' \t\r\n')
case $names in
  "[]" | null | "[{"*"}]") ;;
  *) echo "launch.sh: fly secrets list -a $app --json gave no list of secrets this script can read, so no secret was made" >&2; exit 1 ;;
esac
has() { case $names in *"\"name\":\"$1\""*) return 0 ;; esac; return 1; }
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
unset token seal

# One Machine: the SQLite store is on its one volume, which the first deploy makes from fly.toml's [[mounts]].
fly deploy -a "$app" -c "$config" --primary-region "$region" --ha=false --yes

echo ""
echo "AgentRun is at https://$app.fly.dev/"
line=$(fly logs -a "$app" --no-tail 2> /dev/null | sed -n 's/.*\(Set up this server: .*\)$/\1/p' | tail -n 1) || line=
[ -z "$line" ] || echo "$line"
echo "The setup code again later: fly logs -a $app --no-tail | grep 'Set up this server' | tail -n 1"
