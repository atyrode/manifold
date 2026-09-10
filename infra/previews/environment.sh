#!/usr/bin/env bash
# Explicit retained hub replacement and disposable numbered-preview composition.
# The caller supplies its Compose command prefix; image is its next argument.
environment_image() {
  local image
  [[ -f "$here/environment-image.txt" && -r "$here/environment-image.txt" ]] ||
    fail 'expected a digest-pinned development image'
  if IFS= read -r -d '' image <"$here/environment-image.txt"; then
    fail 'expected a digest-pinned development image'
  fi
  image=${image%$'\n'}
  [[ $image =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    fail 'expected a digest-pinned development image'
  printf '%s' "$image"
}
require_environment_builder() {
  local builder_driver
  builder_driver=$(docker buildx inspect) ||
    fail 'development image composition requires the docker Buildx driver'
  [[ $builder_driver =~ (^|$'\n')Driver:[[:blank:]]+docker($|$'\n') ]] ||
    fail 'development image composition requires the docker Buildx driver'
}
build_environment() {
  local checkout=$1 base_image=$2 final_image=$3 project=$4 development_image=$5 revision probe
  shift 5
  revision=$(git -C "$checkout" rev-parse HEAD)
  "$@" "$base_image" build manifold
  docker buildx build --load --tag "$final_image" --file "$here/Dockerfile.environment" \
    --build-arg "MANIFOLD_APP_IMAGE=$base_image" \
    --build-arg "DEVELOPMENT_IMAGE=$development_image" \
    --build-arg "DEVELOPMENT_DIGEST=${development_image##*@}" \
    --build-arg "MANIFOLD_REVISION=$revision" \
    --build-arg "MANIFOLD_VERSION=$MANIFOLD_VERSION" \
    --build-arg "MANIFOLD_BUILD=$MANIFOLD_BUILD" \
    --build-arg "MANIFOLD_CHANNEL=$MANIFOLD_CHANNEL" "$here"
  log "probing $project development environment offline"
  probe=$(docker run --rm --network none --label "com.docker.compose.project=$project" "$final_image" bun -e '
    import { statSync } from "node:fs";
    if (process.getuid() !== 1000 || process.getgid() !== 1000)
      throw new Error("preview: development command must run as UID/GID 1000");
    if (process.env.HOME !== "/home/developer")
      throw new Error("preview: development command must use /home/developer");
    for (const path of [process.env.HOME, "/app", "/app/infra/entrypoint.sh", "/app/packages/server/src/main.ts"]) {
      const stat = statSync(path);
      if (stat.uid !== 1000 || stat.gid !== 1000)
        throw new Error(`preview: ${path} must be owned by UID/GID 1000`);
    }
    for (const tool of ["omp", "code"])
      if (!Bun.which(tool)) throw new Error(`preview: development environment requires ${tool}`);
    const required = (await Bun.file("/app/package.json").json())?.engines?.bun;
    if (typeof required !== "string" || !required.trim())
      throw new Error("preview: artifact contract requires nonempty /app/package.json engines.bun");
    if (!Bun.semver.satisfies(Bun.version, required))
      throw new Error(`preview: development Bun ${Bun.version} does not satisfy artifact engines.bun ${required}`);
    await import(Bun.resolveSync("@manifold/protocol", "/app/packages/server"));
    console.log("manifold-preview-environment-ok");
  ')
  [[ $probe == manifold-preview-environment-ok ]] ||
    fail 'development image did not execute the supplied command probe'
}
# Resolve the final callback merge, reducing it immediately to a bounded public
# record. Image defaults count only when the Compose environment omits the key;
# an explicit null/unknown value is not evidence for the supported persisted root.
retained_topology() {
  local volume=$1 image=$2 image_data
  shift 2
  image_data=$(docker image inspect --format '
    {{- $data := false -}}{{- $unsafe := false -}}
    {{- range .Config.Env -}}
      {{- if eq (index (split . "=") 0) "MANIFOLD_DATA_DIR" -}}
        {{- if or $data (ne . "MANIFOLD_DATA_DIR=/data") -}}{{- $unsafe = true -}}{{- end -}}{{- $data = true -}}
      {{- end -}}
    {{- end -}}
    {{- if and $data (not $unsafe) -}}retained-data-root{{- end -}}' "$image" 2>/dev/null) ||
    fail 'HOLD: cannot classify retained replacement data root'
  "$@" "$image" config --format json 2>/dev/null |
    jq -cer --arg volume "$volume" --arg image "$image" --arg image_data "$image_data" '
      . as $config | .services.manifold as $service |
      [$service.networks | keys[] | $config.networks[.].name] | sort as $networks |
      select(
        $service.image == $image and
        $service.environment.MANIFOLD_MACHINE_NAME == "dev-hub" and
        $service.environment.MANIFOLD_SPAWN_AGENT == "0" and
        (if $service.environment | has("MANIFOLD_DATA_DIR")
         then $service.environment.MANIFOLD_DATA_DIR == "/data"
         else $image_data == "retained-data-root" end) and
        ($service.network_mode == null) and
        ($service.volumes | length) == 1 and
        $service.volumes[0].type == "volume" and
        $service.volumes[0].target == "/data" and
        $config.volumes[$service.volumes[0].source].name == $volume and
        ($volume | test("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")) and
        ($networks | length) >= 1 and ($networks | length) <= 16 and
        ($networks | unique | length) == ($networks | length) and
        all($networks[]; type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"))
      ) |
      {machine: "dev-hub", volume: $volume, networks: $networks}
    ' 2>/dev/null ||
    fail 'HOLD: retained replacement requires supported final topology and /data data root'
}

# Desired Compose environment is not evidence about the container being replaced.
# Classify public topology and spawn settings without dumping Config.Env (or
# /proc/*/environ). Missing/default spawn configuration is owning.
require_retained_server_only() {
  local project=$1 volume=$2 topology=$3 incumbent configuration proof topology_template
  incumbent=$(docker ps --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=manifold') ||
    fail 'HOLD: cannot identify the retained incumbent'
  [[ -n $incumbent ]] || fail 'HOLD: retained incumbent is absent; refusing to create an identity'
  [[ $incumbent =~ ^[0-9a-f]{64}$ ]] ||
    fail 'HOLD: retained replacement requires one supported server-only incumbent'
  # Classify matching public settings inside Docker's template; even unexpected
  # values must not be printed. Reject command overrides and shared PID namespaces.
  configuration=$(docker inspect --format '
    {{- $spawn := false -}}{{- $unsafe := false -}}
    {{- range .Config.Env -}}
      {{- $key := index (split . "=") 0 -}}
      {{- if eq $key "MANIFOLD_SPAWN_AGENT" -}}
        {{- if or $spawn (ne . "MANIFOLD_SPAWN_AGENT=0") -}}{{- $unsafe = true -}}{{- end -}}{{- $spawn = true -}}
      {{- else if or (eq $key "BUN_OPTIONS") (eq $key "NODE_OPTIONS") (eq $key "MANIFOLD_LOCAL_JOB_OWNER_TEMPLATE") (eq $key "MANIFOLD_LOCAL_AGENT_SUPERVISION") -}}
        {{- $unsafe = true -}}
      {{- end -}}
    {{- end -}}
    {{- if and $spawn (not $unsafe) .State.Running (not .State.Paused) (not .State.Restarting) (eq .HostConfig.PidMode "") (eq .Config.WorkingDir "/app") (eq (json .Config.Cmd) "[\"/app/infra/entrypoint.sh\"]") (eq (json .Config.Entrypoint) "[\"/usr/local/bin/docker-entrypoint.sh\"]") -}}
      retained-config-server-only
    {{- end -}}' "$incumbent" 2>/dev/null) ||
    fail 'HOLD: cannot classify retained incumbent configuration'
  [[ $configuration == retained-config-server-only ]] ||
    fail 'HOLD: retained incumbent is owning or has unsupported spawn configuration'
  # Only validated public names enter the template. Unexpected actual values
  # remain inside Docker and can produce only a fixed classification token.
  topology_template=$(jq -er --arg volume "$volume" '
    select(.volume == $volume) |
    "{{- $machine := false -}}{{- $data := false -}}{{- $unsafe := false -}}" +
    "{{- range .Config.Env -}}{{- $key := index (split . \"=\") 0 -}}" +
    "{{- if eq $key \"MANIFOLD_MACHINE_NAME\" -}}" +
    "{{- if or $machine (ne . " + ("MANIFOLD_MACHINE_NAME=" + .machine | tojson) + ") -}}{{- $unsafe = true -}}{{- end -}}{{- $machine = true -}}" +
    "{{- else if eq $key \"MANIFOLD_DATA_DIR\" -}}" +
    "{{- if or $data (ne . \"MANIFOLD_DATA_DIR=/data\") -}}{{- $unsafe = true -}}{{- end -}}{{- $data = true -}}{{- end -}}{{- end -}}" +
    "{{- range .Mounts -}}{{- if or (ne .Destination \"/data\") (ne .Type \"volume\") (ne .Name " + (.volume | tojson) + ") -}}{{- $unsafe = true -}}{{- end -}}{{- end -}}" +
    "{{- if and $machine $data (not $unsafe) (eq (len .Mounts) 1) (eq (len .NetworkSettings.Networks) " + (.networks | length | tostring) + ")" +
    ([.networks[] | " (index .NetworkSettings.Networks " + tojson + ")"] | join("")) +
    " -}}retained-topology-matched{{- end -}}"
  ' <<<"$topology") || fail 'HOLD: retained topology evidence is unavailable'
  proof=$(docker inspect --format "$topology_template" "$incumbent" 2>/dev/null) ||
    fail 'HOLD: cannot classify retained incumbent topology'
  [[ $proof == retained-topology-matched ]] ||
    fail 'HOLD: retained incumbent topology or /data data root does not match the replacement'
  # Stream public code, not files from /data. A fixed token is the entire evidence
  # surface; raw process arguments and probe errors never leave the container.
  proof=$(docker exec -i "$incumbent" bun --no-env-file - <"$here/retained-server-only.ts" 2>/dev/null) ||
    fail 'HOLD: retained incumbent has owning or unknown processes'
  [[ $proof == retained-processes-server-only ]] ||
    fail 'HOLD: retained incumbent process proof is unavailable'
}

replace_environment() {
  local lifecycle=$1 volume=$2 final_image=$3 project=$4 health_url=$5 topology
  shift 5
  case "$lifecycle" in
    retained)
      topology=$(retained_topology "$volume" "$final_image" "$@") ||
        fail 'HOLD: retained replacement topology is unavailable'
      require_retained_server_only "$project" "$volume" "$topology"
      log "replacing only $project hub; retained owners and data are untouched"
      ;;
    disposable)
      log "redeploying $project retires existing PTYs and terminal entries and replaces the disposable development home"
      if [[ -n $("$@" "$final_image" ps --status running --quiet manifold) ]]; then
        "$@" "$final_image" exec -T manifold bun - retire <"$here/terminal-lifecycle.ts"
      fi
      ;;
    *) fail 'replacement requires an explicit retained or disposable lifecycle' ;;
  esac
  "$@" "$final_image" stop manifold
  if [[ $lifecycle == disposable ]]; then
    docker run --rm --network none --label "com.docker.compose.project=$project" --user 0:0 --entrypoint /bin/bash \
      --mount "type=volume,src=$volume,dst=/data" "$final_image" \
      -c 'chown -R --no-dereference 1000:1000 /data' ||
      fail "$project deployment failed while setting /data ownership"
  fi
  "$@" "$final_image" up -d --no-build --no-deps manifold
  log "waiting for $project health"
  wait_health "$health_url" "$MANIFOLD_BUILD" || fail "$project deployment failed health check"
  if [[ $lifecycle == disposable ]]; then
    "$@" "$final_image" exec -T manifold bun - resume <"$here/terminal-lifecycle.ts"
  fi
}
