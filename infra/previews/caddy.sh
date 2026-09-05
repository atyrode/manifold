#!/usr/bin/env bash
set -euo pipefail
# Called under preview.sh's registry lock.
router() {
  local name _kind port caddy unit config="$PREVIEW_HOME/caddy/Caddyfile" registry="$PREVIEW_HOME/registry"
  mkdir -p "$PREVIEW_HOME/caddy" "$HOME/.config/systemd/user"
  caddy=$(command -v caddy)
  {
    printf '{\n admin "unix/%s/caddy/admin.sock"\n auto_https off\n}\n' "$PREVIEW_HOME"
    printf 'http://:%s {\n bind 127.0.0.1\n route {\n' "$PREVIEW_ROUTER_PORT"
    printf ' handle /__preview/ask {\n  @known query domain=preview.%s' "$PREVIEW_DOMAIN"
    while read -r name _kind port; do printf ' domain=%s.%s' "$name" "$PREVIEW_DOMAIN"; done <"$registry"
    printf '\n  respond @known 200\n  respond 404\n }\n'
    while read -r name _kind port; do
      printf ' @p%s host %s.%s\n handle @p%s {\n  reverse_proxy 127.0.0.1:%s\n }\n' "$name" "$name" "$PREVIEW_DOMAIN" "$name" "$port"
    done <"$registry"
    printf ' respond 404\n }\n}\n'
  } >"$config"
  "$caddy" validate --config "$config" --adapter caddyfile
  unit="$HOME/.config/systemd/user/manifold-previews-caddy.service"
  {
    printf '[Unit]\nDescription=Manifold preview router\n[Service]\n'
    printf 'ExecStart="%s" run --config "%s" --adapter caddyfile\n' "$caddy" "$config"
    printf 'Restart=on-failure\n[Install]\nWantedBy=default.target\n'
  } >"$unit"
  systemctl --user daemon-reload
  systemctl --user enable manifold-previews-caddy.service
  if systemctl --user is-active --quiet manifold-previews-caddy.service; then
    "$caddy" reload --config "$config" --adapter caddyfile --address "unix/$PREVIEW_HOME/caddy/admin.sock"
  else
    systemctl --user start manifold-previews-caddy.service
  fi
  log 'router ready'
}
