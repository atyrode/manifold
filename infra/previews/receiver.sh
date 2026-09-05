#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PREVIEW_HOME="${PREVIEW_HOME:-$HOME/manifold-previews}"
[[ -f $PREVIEW_HOME/env ]] || { echo "preview: missing $PREVIEW_HOME/env; configure the receiver first" >&2; exit 2; }
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
require_domain
usage() { fail 'usage: dev SHA | preview up N SHA | preview down N (bare SHA also means dev SHA)'; }
if [[ -v SSH_ORIGINAL_COMMAND ]]; then
  [[ $SSH_ORIGINAL_COMMAND != *$'\n'* && $SSH_ORIGINAL_COMMAND != *$'\r'* ]] || usage
  read -r -a args <<<"$SSH_ORIGINAL_COMMAND"
  set -- "${args[@]}"
fi
case "${1:-}:$#" in
  dev:2) sha_arg "$2"; exec "$here/deploy-dev.sh" "$2" ;;
  preview:4) [[ $2 == up ]] || usage; pr_name "$3"; sha_arg "$4"; exec "$here/preview.sh" up "$3" "$4" ;;
  preview:3) [[ $2 == down ]] || usage; pr_name "$3"; exec "$here/preview.sh" down "$3" ;;
  *:1) sha_arg "$1"; exec "$here/deploy-dev.sh" "$1" ;;
  *) usage ;;
esac
