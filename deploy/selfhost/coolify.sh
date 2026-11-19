# shellcheck shell=sh disable=SC2034,SC2154 # sourced by walk.sh: it sets deploy and work, and reads version, template and host
# walk.sh's Coolify part (sourced): Coolify v4.7.5 from its install script at that tag, driven through its API (v1) with a
# root token the walk makes in Coolify's own console (artisan tinker: Coolify has no other way to turn the API on). The
# template goes in as a service's raw compose, which Coolify parses for its magic variables (SERVICE_URL_*, SERVICE_HEX_*,
# SERVICE_REALBASE64_*) as it does its own templates'. Its compose project is the service's uuid; the server's container
# is agentrun-<uuid> and its volume <uuid>_agentrun-data.
version=4.7.5
template=$deploy/coolify/agentrun.yaml
base=http://127.0.0.1:8000/api/v1
key='' uuid=''

c() { curl -fsS -H "Authorization: Bearer $key" -H 'content-type: application/json' "$@"; }

install() {
  curl -fsSL "https://raw.githubusercontent.com/coollabsio/coolify/v$version/scripts/install.sh" -o "$work/install.sh"
  # No auto-update; Docker's address pool away from the VM's own network.
  # shellcheck disable=SC2024 # the log is the walk's own file
  sudo -H env AUTOUPDATE=false DOCKER_ADDRESS_POOL_BASE=172.16.0.0/12 DOCKER_ADDRESS_POOL_SIZE=24 \
    bash "$work/install.sh" "$version" >"$work/install.log" 2>&1 \
    || { tail -40 "$work/install.log" >&2; fail "installed" "Coolify's install script: $(tail -1 "$work/install.log")"; }
  tries=0
  until curl -fsS http://127.0.0.1:8000/api/health 2>/dev/null | grep -qx OK; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "installed" "Coolify's /api/health not OK within 300 s"
    sleep 3
  done
  # The API on, for any address, and a root token for the instance's root user (id 0, made here if the install made
  # none) in its root team (0).
  key=$(sudo docker exec -u www-data coolify php artisan tinker --execute '
    App\Models\InstanceSettings::find(0)->update(["is_api_enabled" => true, "allowed_ips" => null]);
    $u = App\Models\User::find(0);
    if (! $u) { $u = (new App\Models\User)->forceFill(["id" => 0, "name" => "Walk", "email" => "walk@walk.invalid", "password" => Illuminate\Support\Facades\Hash::make(bin2hex(random_bytes(16)))]); $u->save(); }
    echo $u->createToken("walk", ["root"], null, 0)->plainTextToken;' | tail -n 1)
  case $key in *"|"*) ;; *) fail "installed" "no API token from Coolify's console" ;; esac
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$key"
  have=$(c "$base/version")
  [ "$have" = "$version" ] || fail "installed" "Coolify's API reports version '$have', not $version"
}

deploy() {
  server=$(c "$base/servers" | jq -r '.[] | select(.name == "localhost") | .uuid')
  project=$(c -X POST "$base/projects" -d '{"name":"agentrun-walk"}' | jq -r .uuid)
  body=$(jq -n --arg p "$project" --arg s "$server" --arg c "$(base64 -w0 "$1")" \
    '{name: "agentrun", project_uuid: $p, environment_name: "production", server_uuid: $s, docker_compose_raw: $c, instant_deploy: true}')
  uuid=$(c -X POST "$base/services" -d "$body" | jq -r .uuid)
  made "$uuid" || fail "deployed" "Coolify made no service"
  container=agentrun-$uuid
  # The domain Coolify made the service (SERVICE_URL_AGENTRUN, http://agentrun-<uuid>.<ip>.sslip.io), host only.
  host=$(c "$base/services/$uuid/envs" | jq -r '.[] | select(.key == "SERVICE_URL_AGENTRUN") | .value' | sed 's|^[a-z]*://||; s|/$||')
  [ -n "$host" ] || fail "deployed" "Coolify made no SERVICE_URL_AGENTRUN for service $uuid"
  tries=0
  until docker inspect "$container" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "deployed" "no container $container within 300 s of the deploy"
    sleep 3
  done
}

remove() {
  [ -n "$uuid" ] || return 0
  c -X DELETE "$base/services/$uuid?delete_volumes=true&delete_connected_networks=true&delete_configurations=true&docker_cleanup=false" >/dev/null
}

left() {
  docker ps -aq --filter "label=com.docker.compose.project=$uuid"
  docker volume ls -q --filter "name=${uuid}_"
}

logs() {
  [ ! -f "$work/install.log" ] || tail -20 "$work/install.log"
  [ -z "$uuid" ] || c "$base/services/$uuid" | jq -r '"service status: \(.status)"' || true
  sudo docker logs --tail 40 coolify 2>&1 || true
}
