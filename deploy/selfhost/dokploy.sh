# shellcheck shell=sh disable=SC2034,SC2154 # sourced by walk.sh: it sets deploy and work, and reads version, template and host
# walk.sh's Dokploy part (sourced): Dokploy v0.31.4 from its install script (Dokploy/website at a fixed commit), driven
# through its API with a key the walk makes as the first (owner) user. The template goes in through compose.import, the
# path the templates site's Import uses: Dokploy itself processes template.toml (its ${domain}, ${hash:N},
# ${base64:N}), writes the env and makes the domain. Its compose project is the app's name; the server's container is
# <app>-agentrun-1.
version=v0.31.4
installer=https://raw.githubusercontent.com/Dokploy/website/98be4f66a0faf8aaddfc13b8d2d2ac07f162c5b6/apps/website/public/install.sh
template=$deploy/dokploy/agentrun/docker-compose.yml
base=http://127.0.0.1:3000/api
key='' id='' app=''

d() { curl -fsS -H "x-api-key: $key" -H 'content-type: application/json' "$@"; }

install() {
  curl -fsSL "$installer" -o "$work/install.sh"
  addr=$(ip -o -4 addr show scope global | awk '$2 !~ /^(docker|br-|veth)/ { print $4 }' | cut -d/ -f1 | head -n1)
  # The swarm's address pool away from the VM's own network.
  # shellcheck disable=SC2024 # the log is the walk's own file
  sudo env DOKPLOY_VERSION="$version" ADVERTISE_ADDR="$addr" \
    DOCKER_SWARM_INIT_ARGS="--default-addr-pool 10.200.0.0/16 --default-addr-pool-mask-length 24" \
    bash "$work/install.sh" >"$work/install.log" 2>&1 \
    || { tail -40 "$work/install.log" >&2; fail "installed" "Dokploy's install script: $(tail -1 "$work/install.log")"; }
  tries=0
  until curl -fsS "$base/trpc/settings.health" 2>/dev/null | grep -q '"ok"'; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "installed" "Dokploy's settings.health not ok within 300 s"
    sleep 3
  done
  # Traefik starts 4 s after Dokploy, often before Dokploy has written its traefik.yml: start it again once it has.
  tries=0
  until sudo test -f /etc/dokploy/traefik/traefik.yml; do
    tries=$((tries + 1))
    [ "$tries" -le 60 ] || fail "installed" "Dokploy wrote no /etc/dokploy/traefik/traefik.yml within 180 s"
    sleep 3
  done
  sudo docker restart dokploy-traefik >/dev/null
  # The first sign-up is the owner; its session makes the API key (unlimited: the plugin's default is 10 a day).
  jar="$work/cookies"
  password=$(openssl rand -hex 24)
  curl -fsS -c "$jar" -H 'content-type: application/json' "$base/auth/sign-up/email" \
    -d "{\"email\":\"walk@walk.invalid\",\"password\":\"$password\",\"name\":\"Walk\",\"lastName\":\"Walk\"}" >/dev/null \
    || fail "installed" "Dokploy's first sign-up failed"
  org=$(curl -fsS -b "$jar" "$base/organization.all" | jq -r '.[0].id')
  key=$(curl -fsS -b "$jar" -H 'content-type: application/json' "$base/user.createApiKey" \
    -d "{\"name\":\"walk\",\"metadata\":{\"organizationId\":\"$org\"},\"rateLimitEnabled\":false}" | jq -r .key)
  made "$key" || fail "installed" "no API key from Dokploy"
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$key"
  sudo docker service inspect -f '{{.Spec.TaskTemplate.ContainerSpec.Image}}' dokploy 2>/dev/null | grep -q ":$version" \
    || fail "installed" "the dokploy service runs $(sudo docker service inspect -f '{{.Spec.TaskTemplate.ContainerSpec.Image}}' dokploy 2>&1), not $version"
}

deploy() {
  environment=$(d "$base/project.create" -d '{"name":"agentrun-walk"}' | jq -r .environment.environmentId)
  made=$(d "$base/compose.create" -d "{\"name\":\"agentrun\",\"appName\":\"agentrun\",\"environmentId\":\"$environment\",\"composeType\":\"docker-compose\"}")
  id=$(printf '%s' "$made" | jq -r .composeId)
  app=$(printf '%s' "$made" | jq -r .appName)
  made "$id" || fail "deployed" "Dokploy made no compose app"
  # What the templates site's Import takes: base64 of {"compose": <docker-compose.yml>, "config": <template.toml>}.
  payload=$(jq -n --rawfile compose "$1" --rawfile config "$deploy/dokploy/agentrun/template.toml" '{compose: $compose, config: $config}' | base64 -w0)
  d "$base/compose.import" -d "{\"composeId\":\"$id\",\"base64\":\"$payload\"}" >/dev/null || fail "deployed" "Dokploy's compose.import refused the template"
  host=$(d "$base/compose.one?composeId=$id" | jq -r '.domains[0].host')
  made "$host" || fail "deployed" "Dokploy made no domain for $app"
  d "$base/compose.deploy" -d "{\"composeId\":\"$id\"}" >/dev/null
  tries=0
  until [ "$(d "$base/compose.one?composeId=$id" | jq -r .composeStatus)" = "done" ]; do
    status=$(d "$base/compose.one?composeId=$id" | jq -r .composeStatus)
    [ "$status" != error ] || fail "deployed" "Dokploy's deploy of $app ended in error"
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "deployed" "Dokploy's deploy of $app is $status after 300 s"
    sleep 3
  done
  container=$(docker ps -q --filter "label=com.docker.compose.project=$app" --filter label=com.docker.compose.service=agentrun | head -n1)
  [ -n "$container" ] || fail "deployed" "no agentrun container in Dokploy's project $app"
  container=$(docker inspect -f '{{.Name}}' "$container" | sed 's|^/||')
}

remove() {
  [ -n "$id" ] || return 0
  d "$base/compose.delete" -d "{\"composeId\":\"$id\",\"deleteVolumes\":true}" >/dev/null
}

left() {
  docker ps -aq --filter "label=com.docker.compose.project=$app"
  docker volume ls -q --filter "label=com.docker.compose.project=$app"
}

logs() {
  [ ! -f "$work/install.log" ] || tail -20 "$work/install.log"
  [ -z "$id" ] || d "$base/compose.one?composeId=$id" | jq -r '"compose status: \(.composeStatus)", (.deployments[0].logPath // empty)' || true
  sudo docker service logs --tail 40 dokploy 2>&1 || true
}
