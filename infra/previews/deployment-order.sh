#!/usr/bin/env bash
# Development deployment ancestry and installed-image provenance checks.
# The caller holds dev.lock and has fetched the Git objects used below.

full_commit() {
  local checkout=$1 candidate=$2 resolved
  resolved=$(git -C "$checkout" rev-parse --verify "$candidate^{commit}" 2>/dev/null) ||
    fail 'HOLD: deployment revision is missing or ambiguous'
  [[ $resolved =~ ^[0-9a-f]{40}$ ]] || fail 'HOLD: deployment revision is not a full commit'
  printf '%s' "$resolved"
}

legacy_image_revision() {
  local checkout=$1 build=$2 described candidate
  if [[ $build =~ ^(.+)\+([1-9][0-9]*)\.g([0-9a-f]{7,40})$ ]]; then
    candidate=$(full_commit "$checkout" "${BASH_REMATCH[3]}")
    described=$(git -C "$checkout" describe --tags --long --abbrev=7 --match 'v*' "$candidate" 2>/dev/null) ||
      fail 'HOLD: legacy development image provenance is not canonical'
    [[ $described =~ ^v(.+)-([0-9]+)-g([0-9a-f]{7,40})$ ]] ||
      fail 'HOLD: legacy development image provenance is not canonical'
    [[ "${BASH_REMATCH[1]}+${BASH_REMATCH[2]}.g${BASH_REMATCH[3]}" == "$build" ]] ||
      fail 'HOLD: legacy development image provenance does not identify its commit'
    printf '%s' "$candidate"
    return
  fi
  [[ $build =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] ||
    fail 'HOLD: legacy development image provenance is unsupported'
  candidate=$(full_commit "$checkout" "refs/tags/v$build")
  [[ $(git -C "$checkout" describe --tags --exact-match --match "v$build" "$candidate" 2>/dev/null) == "v$build" ]] ||
    fail 'HOLD: legacy release image provenance is not an exact tag'
  printf '%s' "$candidate"
}

installed_development_image() {
  local project=$1 incumbent image incumbent_list
  local -a incumbents=()
  incumbent_list=$(docker ps --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=manifold') ||
    fail 'HOLD: cannot identify the development incumbent'
  mapfile -t incumbents <<<"$incumbent_list"
  [[ ${#incumbents[@]} == 1 && ${incumbents[0]} =~ ^[0-9a-f]{64}$ ]] ||
    fail 'HOLD: deployment ordering requires one exact development incumbent'
  incumbent=${incumbents[0]}
  image=$(docker container inspect "$incumbent" 2>/dev/null | jq -er --arg project "$project" '
    select(length == 1) | .[0] |
    select(.Config.Labels["com.docker.compose.project"] == $project and
      .Config.Labels["com.docker.compose.service"] == "manifold") |
    .Image | select(test("^sha256:[0-9a-f]{64}$"))
  ') || fail 'HOLD: cannot identify the incumbent immutable image'
  printf '%s' "$image"
}

development_image_revision() {
  local image=$1 checkout=$2 image_data label build resolved provenance
  image_data=$(docker image inspect "$image" 2>/dev/null | jq -cer '
    select(length == 1) | .[0].Config |
    { provenance: (.Labels["io.manifold.deployment.provenance"] // ""),
      revision: (.Labels["org.opencontainers.image.revision"] // ""),
      builds: [.Env[]? | select(startswith("MANIFOLD_BUILD=")) | ltrimstr("MANIFOLD_BUILD=")] }
  ') || fail 'HOLD: incumbent image provenance is unavailable'
  provenance=$(jq -r '.provenance' <<<"$image_data")
  if [[ $provenance == git-v1 ]]; then
    label=$(jq -r '.revision' <<<"$image_data")
    [[ $label =~ ^[0-9a-f]{40}$ ]] ||
      fail 'HOLD: incumbent image revision label is malformed'
    resolved=$(full_commit "$checkout" "$label")
    [[ $resolved == "$label" ]] || fail 'HOLD: incumbent image revision label is not a commit'
    printf '%s' "$resolved"
    return
  fi
  [[ -z $provenance ]] || fail 'HOLD: incumbent application provenance is unsupported'
  # Base images can contribute their own OCI revision. Without our provenance
  # marker that label is not an application commit; use only canonical legacy metadata.
  [[ $(jq '.builds | length' <<<"$image_data") == 1 ]] ||
    fail 'HOLD: legacy incumbent has missing or ambiguous build provenance'
  build=$(jq -r '.builds[0]' <<<"$image_data")
  [[ $build != *.dirty ]] || fail 'HOLD: dirty legacy incumbent provenance is refused'
  legacy_image_revision "$checkout" "$build"
}

require_development_order() {
  local checkout=$1 current=$2 target=$3 mode=$4 expected=${5:-}
  current=$(full_commit "$checkout" "$current")
  target=$(full_commit "$checkout" "$target")
  case "$mode" in
    forward)
      if [[ $current == "$target" ]] || git -C "$checkout" merge-base --is-ancestor "$current" "$target" 2>/dev/null; then
        return
      fi
      fail 'HOLD: normal development deployment would move backward or across divergent history'
      ;;
    rollback)
      [[ $expected =~ ^[0-9a-f]{40}$ ]] || fail 'HOLD: rollback requires the full expected current revision'
      [[ $target == "$current" ]] && return
      [[ $expected == "$current" ]] || fail 'HOLD: rollback expectation is stale'
      git -C "$checkout" merge-base --is-ancestor "$target" "$current" 2>/dev/null ||
        fail 'HOLD: rollback target is not a strict ancestor of the incumbent'
      ;;
    *) fail 'HOLD: deployment ordering mode is invalid' ;;
  esac
}
