#!/bin/sh
# CI only, on a GitHub-hosted runner, before an image is built: Docker's daemon on its classic image store, not the
# containerd image store the runner turns on. On the containerd store, a `docker build` that loads its image compresses
# every layer at export and unpacks it again (about 42 s and 12 s for packages/serve/docker/Dockerfile); the classic
# store takes the layers as built. dockerd's reference: the daemon.json field `features`, `containerd-snapshotter` true
# for containerd snapshotters "instead of the classic storage drivers"; a feature set both there and by --feature is an
# error. The containerd store reads `[[driver-type io.containerd.snapshotter.v1]]` in `docker info`'s DriverStatus.
# The daemon's other settings are kept. Prints the store before and after, and fails unless the switch took.
set -eu
f=/etc/docker/daemon.json
store() { docker info -f 'driver={{.Driver}} status={{.DriverStatus}}'; }
echo "before: $(store)"
if systemctl cat docker.service 2>/dev/null | grep -q -- '--feature'; then
  echo "dockerd is started with --feature; a feature in daemon.json too would stop it starting:" >&2
  systemctl cat docker.service | grep -- '--feature' >&2
  exit 1
fi
{ sudo cat "$f" 2>/dev/null || echo '{}'; } | jq '.features["containerd-snapshotter"] = false' >"${RUNNER_TEMP:-/tmp}/daemon.json"
sudo install -m 0644 "${RUNNER_TEMP:-/tmp}/daemon.json" "$f"
sudo systemctl restart docker
after=$(store)
echo "after: $after"
case $after in
  *io.containerd.snapshotter*) echo "still the containerd image store after the restart" >&2; exit 1 ;;
esac
