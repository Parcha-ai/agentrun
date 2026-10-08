#!/bin/sh
# The container's program under tini. With `run`, the host driver (dockerHost) has copied the run's mount token into
# /run/pda/token (root-only, 0600) between `docker create` and `docker start`: it becomes the instance's stdin, the path is
# removed before the instance starts, and the instance reads the token once and closes its stdin. The token is never in
# the container's configuration (`docker inspect` shows env and argv), an argument or an environment variable; only the
# archil daemon's own environment holds it, which the run user cannot read. Any other first argument runs the CLI as is.
set -eu
token=/run/pda/token
if [ "${1:-}" = run ] && [ -f "$token" ]; then
  exec 0<"$token"
  rm -f "$token"
fi
exec /usr/local/bin/node /opt/pda/node_modules/@parcha/pi-durable-archil/dist/cli.js "$@"
