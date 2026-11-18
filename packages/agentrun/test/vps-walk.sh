#!/usr/bin/env bash
# The installer's --vps walk, as root on a GitHub runner standing in for a fresh rented server (CI: install-walk.yml's vps
# job). The runner's own Docker is purged first, so the installer installs Docker Engine from Docker's apt repository.
#   1. Tailscale missing: AgentRun on loopback only, the steps and the command to run again said, exit 0. Health, the
#      API refused with no token (401), the first visit asking for the setup code, .env at mode 600.
#   2. Run again: the same Docker left alone, the same token and seal key, the same container.
#   3. An upgrade (--build: to this checkout's image) on the faux model (vps-faux-shell.mjs, through compose.override.yaml):
#      the same token, the data kept; then an agent whose place is the Docker box runs a shell command to completed, in a
#      sandbox with no Docker socket.
#   4. A fake tailscale (fake-tailscale.sh), logged in: served at its https address through `tailscale serve`, never
#      Funnel; with Funnel on, refused and nothing changed.
#   5. --public: every address, the warning said, the API refused with no token, and the printed setup code sets the
#      password. 6. Run again without it: back to private, and the owner is said.
#   vps-walk.sh [--build]
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
dir=/opt/agentrun
api=http://127.0.0.1:7340/v2
again='curl -fsSL https://agentrun.ai/install | sh -s -- --vps'
fake=/var/run/tailscale/fake
everywhere=0.0.0.0
logs=$(mktemp -d)
image=()
[ "${1:-}" != --build ] || image=(--image agentrun-vps:local)

step() { printf '\n== %s\n' "$*"; }
dc() { (cd "$dir" && docker compose "$@"); }
die() {
  echo "FAIL: $*" >&2
  if command -v docker > /dev/null && [ -f "$dir/compose.yaml" ]; then dc logs --no-color --tail 60 >&2 || true; fi
  exit 1
}
setting() { sed -n "s/^$1=//p" "$dir/.env" | tail -n 1; }
secrets() { printf '%s %s' "$(setting AGENTRUN_TOKEN)" "$(setting AGENTRUN_SEAL_KEY)" | sha256sum | cut -d ' ' -f 1; }
authed() { curl -fsS -H "authorization: Bearer $(setting AGENTRUN_TOKEN)" "$@"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
container() { docker inspect -f '{{.Id}}' "$(dc ps -q agentrun)"; }
said() { grep -qF -- "$2" "$1" || die "the installer did not say: $2"; }
# The installer as `curl | sh` runs it: it returns 0 within $1 seconds, or the walk fails. Its output goes to $2.
piped_install() {
  local bound=$1 out=$2
  shift 2
  timeout "$bound" bash -c 'cat "$0" | sh -s -- "$@" 2>&1 | cat' "$here/install.sh" "$@" > "$out" || {
    cat "$out"
    die "the installer did not return 0 within $bound s"
  }
  cat "$out"
}
healthy() { curl -fsS --max-time 5 "$api/health" | grep -q '"status": *"ok"' || die "/v2/health is not ok"; }
# Where the port is published: the one address Docker binds 7340 on.
bound() { dc port agentrun 7340; }

step "a fresh server: root, no Docker, no Tailscale"
[ "$(id -u)" = 0 ] || die "the walk runs as root, as on a rented server"
dpkg-query -W -f '${Package} ${Version}\n' 2> /dev/null | grep -iE 'docker|moby|containerd' || true
installed=$(dpkg-query -W -f '${Package}\n' 2> /dev/null | grep -E '^(docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker-buildx-plugin|docker-compose-plugin|containerd\.io|moby-.*)$' || true)
if [ -n "$installed" ]; then
  systemctl stop docker.socket docker.service containerd.service > /dev/null 2>&1 || true
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq $installed > /dev/null
fi
hash -r
if command -v docker; then die "docker is still on PATH"; fi
if command -v tailscale; then die "tailscale is on PATH"; fi

step "1. --vps with no Docker and no Tailscale: Docker from its apt repository, AgentRun on loopback, the steps said, exit 0"
piped_install 900 "$logs/1.log" --vps
said "$logs/1.log" "Installing Docker Engine and its compose plugin from Docker's apt repository (https://download.docker.com/linux/ubuntu)"
said "$logs/1.log" "Installed Docker Engine"
said "$logs/1.log" "Tailscale is not installed here, so AgentRun is on this machine only for now."
said "$logs/1.log" "1. Install Tailscale: https://tailscale.com/download/linux"
said "$logs/1.log" "2. Connect this machine to your tailnet: tailscale up"
said "$logs/1.log" "Then run again: $again"
said "$logs/1.log" "Made the API token and the seal key in $dir/.env (mode 600)"
said "$logs/1.log" "is running at http://127.0.0.1:7340/"
said "$logs/1.log" "From your computer: ssh -N -L 7340:127.0.0.1:7340 root@<this server>"
said "$logs/1.log" "Read the newest one later: cd $dir && docker compose logs agentrun | grep 'Set up this server' | tail -n 1"
grep -qE '^Set up this server: http://127\.0\.0\.1:7340/setup#code=[A-Za-z0-9_-]+ \(or paste AGENTRUN_TOKEN\)$' "$logs/1.log" || die "no setup link printed"
docker version --format 'Docker Engine {{.Server.Version}}'
# The release the installer names: the server the published launcher depends on, as v<its version>.
serve=$(curl -fsS https://registry.npmjs.org/@parcha%2fagentrun/latest | jq -r '.dependencies["@parcha/agentrun-serve"]')
[ "$(setting AGENTRUN_IMAGE)" = "ghcr.io/parcha-ai/agentrun-server:v$serve" ] || die "the image is $(setting AGENTRUN_IMAGE), not the release's v$serve"
said "$logs/1.log" "AgentRun v$serve is running at"
[ "$(stat -c '%a %U' "$dir/.env")" = "600 root" ] || die ".env is $(stat -c '%a %U' "$dir/.env")"
[ "$(stat -c '%a' "$dir")" = 700 ] || die "$dir is mode $(stat -c '%a' "$dir")"
setting AGENTRUN_TOKEN | grep -qE '^[0-9a-f]{64}$' || die "the token is not 32 random bytes in hex"
[ "$(setting AGENTRUN_SEAL_KEY | base64 -d | wc -c)" = 32 ] || die "the seal key is not 32 bytes in base64"
[ "$(bound)" = 127.0.0.1:7340 ] || die "the port is published at $(bound)"
healthy
[ "$(status_of "$api/agents")" = 401 ] || die "the API answered $(status_of "$api/agents") with no token"
authed "$api/agents" > /dev/null || die "the API refused the token in .env"
session=$(curl -fsS "$api/auth/session")
echo "$session"
jq -e '.password_set == false and .setup_code == true' <<< "$session" > /dev/null || die "the first visit takes no setup code: an open server"
code=$(curl -s -o "$logs/setup.json" -w '%{http_code}' -X POST -H 'Origin: http://127.0.0.1:7340' -H 'content-type: application/json' --data '{"password":"not-a-secret"}' "$api/setup")
cat "$logs/setup.json"
echo
[ "$code" = 403 ] && grep -q "takes the setup code in its log" "$logs/setup.json" || die "a setup with no code answered $code"
later=$(cd "$dir" && docker compose logs agentrun | grep 'Set up this server' | tail -n 1)
[[ "$later" == *"Set up this server: http://127.0.0.1:7340/setup#code="* ]] || die "the read-later line finds: $later"
kept=$(authed -X POST -H 'content-type: application/json' --data '{"definition":{"name":"kept","instructions":"Answer.","tools":[]}}' "$api/agents" | jq -r .agent_id)
echo "an agent to keep across the runs: $kept"
first=$(secrets)
before=$(container)

step "2. the same command again: Docker left alone, the same token and seal key, the same container"
piped_install 600 "$logs/2.log" --vps
said "$logs/2.log" "Docker Engine $(docker version --format '{{.Server.Version}}') is already here; the installer leaves it as it is."
said "$logs/2.log" "Kept the API token and the seal key in $dir/.env"
[ "$(secrets)" = "$first" ] || die "the token or the seal key changed"
[ "$(container)" = "$before" ] || die "the container was made again with nothing changed"
healthy

step "3. an upgrade${image[*]:+ to the image built from this checkout}, on the faux model: the same token, the data kept"
if [ ${#image[@]} -gt 0 ]; then
  docker build -q -f "$repo/packages/serve/docker/Dockerfile" -t agentrun-vps:local "$repo" > /dev/null || die "the image did not build"
fi
cat > "$dir/compose.override.yaml" << EOF
services:
  agentrun:
    command: ["--data", "/data", "--listen", "0.0.0.0", "--port", "7340", "--drain-timeout", "6s", "--faux", "/walk/vps-faux-shell.mjs"]
    environment:
      AGENTRUN_SERVE_FAUX_MOUNTINFO: /proc/self/mountinfo
    volumes:
      - $here/test:/walk:ro
EOF
piped_install 600 "$logs/3.log" --vps "${image[@]}"
[ "$(secrets)" = "$first" ] || die "the token or the seal key changed"
[ "$(container)" != "$before" ] || die "the container was not made again"
[ ${#image[@]} -eq 0 ] || [ "$(docker inspect -f '{{.Config.Image}}' "$(dc ps -q agentrun)")" = agentrun-vps:local ] || die "the container does not run agentrun-vps:local"
healthy
authed "$api/agents/$kept" > /dev/null || die "the agent made before the upgrade is gone"

step "an agent in the Docker box runs a shell command to completed, in a sandbox with no Docker socket"
box=$(authed "$api/capabilities" | jq -c '.places.boxes[] | select(.id == "docker")')
echo "$box"
jq -e '.available == true' <<< "$box" > /dev/null || die "the Docker box is not available"
agent=$(authed -X POST -H 'content-type: application/json' --data '{"definition":{"name":"vps-shell","instructions":"Run the command you are given.","harness":"pi","tools":["bash"],"place":{"mode":"sandbox","box":"docker"},"approvals":"never"}}' "$api/agents" | jq -r .agent_id)
# The marker is what the command prints, never in its own text.
input=$(jq -n --arg c "shell: printf 'box-%s-%s\\n' \"\$(uname -s)\" \"\$(test -S /var/run/docker.sock && echo socket || echo nosocket)\"" '{input: {content: $c}}')
run=$(authed -X POST -H 'content-type: application/json' --data "$input" "$api/agents/$agent/runs" | jq -r .run_id)
echo "run $run of agent $agent"
for _ in $(seq 1 600); do
  state=$(authed "$api/runs/$run")
  case $(jq -r .status <<< "$state") in completed | failed | cancelled) break ;; esac
  sleep 1
done
echo "$state"
[ "$(jq -r .status <<< "$state")" = completed ] || die "the run ended $(jq -r .status <<< "$state"): $(jq -c .error <<< "$state")"
authed "$api/runs/$run/timeline?after=0" > "$logs/timeline.json"
grep -q 'box-Linux-nosocket' "$logs/timeline.json" || { cat "$logs/timeline.json"; die "the command's output is not in the run's timeline"; }
echo "the command printed box-Linux-nosocket in its box"

step "4. Tailscale logged in (a fake tailscale): served at its https address, never Funnel"
mkdir -p "$fake"
cp "$here/test/fake-tailscale.sh" "$fake/tailscale.sh"
printf '#!/bin/sh\nFAKE_TAILSCALE_DIR=%s exec sh %s/tailscale.sh "$@"\n' "$fake" "$fake" > /usr/local/bin/tailscale
chmod 755 /usr/local/bin/tailscale
name=box.tail1234.example
piped_install 600 "$logs/4.log" --vps "${image[@]}"
said "$logs/4.log" "AgentRun is on your tailnet at https://$name/ (tailscale serve): only your devices on your tailnet open it; nothing is on the public internet."
[ ${#image[@]} -eq 0 ] || said "$logs/4.log" "the newest \"Set up this server\" line in \`docker compose logs\` in $dir has the link."
grep -qE "^Set up this server: https://$name/setup#code=[A-Za-z0-9_-]+ " "$logs/4.log" || die "no setup link at https://$name/"
cat "$fake/calls"
grep -qx "serve --bg --https=443 http://127.0.0.1:7340" "$fake/calls" || die "tailscale serve was not run to the loopback port"
if grep -qE "funnel|up|login" "$fake/calls"; then die "the installer ran tailscale funnel, up or login"; fi
[ "$(setting AGENTRUN_PUBLIC_URL)" = "https://$name/" ] && [ "$(setting AGENTRUN_TRUSTED_PROXIES)" = uniquelocal ] || die "the server was not given its tailnet address"
[ -f "$dir/tailscale/tailscale.json" ] || die "the serve entry was not recorded"
[ "$(bound)" = 127.0.0.1:7340 ] || die "the port is published at $(bound)"
[ "$(secrets)" = "$first" ] || die "the token or the seal key changed"
jq -e '.setup_code == true' <<< "$(curl -fsS -H "Host: $name" "$api/auth/session")" > /dev/null || die "the served name opens no setup code"

step "Funnel on at that address: refused by name, nothing changed"
touch "$fake/funnel"
env_before=$(sha256sum "$dir/.env")
running=$(container)
code=0
timeout 300 sh "$here/install.sh" --vps "${image[@]}" > "$logs/funnel.log" 2>&1 || code=$?
cat "$logs/funnel.log"
[ "$code" = 1 ] || die "the installer exited $code with Funnel on"
said "$logs/funnel.log" "Tailscale Funnel is on for https://$name/"
[ "$(sha256sum "$dir/.env")" = "$env_before" ] && [ "$(container)" = "$running" ] || die "something changed"
healthy
mv "$fake/funnel" "$fake/funnel.off"

step "5. --public: every address, the warning said, the code required, and the printed code sets the password"
address=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
calls=$(wc -l < "$fake/calls")
piped_install 600 "$logs/5.log" --vps --public "${image[@]}"
said "$logs/5.log" "--public: AgentRun listens on every address of this server, port 7340, over plain HTTP, at http://$address:7340/"
said "$logs/5.log" "the setup code, your password and the API"
[ "$(bound)" = "$everywhere:7340" ] || die "the port is published at $(bound)"
[ "$(wc -l < "$fake/calls")" = "$calls" ] || die "--public ran tailscale"
[ "$(status_of "http://$address:7340/v2/agents")" = 401 ] || die "the API answered with no token"
jq -e '.setup_code == true' <<< "$(curl -fsS "http://$address:7340/v2/auth/session")" > /dev/null || die "the first visit takes no setup code: an open server"
code=$(sed -n 's/^Set up this server: .*#code=\([A-Za-z0-9_-]*\) .*/\1/p' "$logs/5.log" | tail -n 1)
[ -n "$code" ] || die "no setup code printed"
setup=$(jq -n --arg code "$code" '{password: "not-a-secret", code: $code}')
answer=$(curl -s -o "$logs/setup.json" -w '%{http_code}' -X POST -H "Origin: http://$address:7340" -H 'content-type: application/json' --data "$setup" "http://$address:7340/v2/setup")
cat "$logs/setup.json"
echo
[ "$answer" = 201 ] || die "the printed setup code answered $answer"

step "6. again without --public: back to private, and the owner said"
piped_install 600 "$logs/6.log" --vps "${image[@]}"
said "$logs/6.log" "This server has its owner: sign in at https://$name/"
[ "$(bound)" = 127.0.0.1:7340 ] || die "the port is published at $(bound)"
[ "$(secrets)" = "$first" ] || die "the token or the seal key changed"
healthy
echo
echo "PASS: the --vps walk"
