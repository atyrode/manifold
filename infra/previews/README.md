# Preview environments

| Address            | Runs                                                |
| ------------------ | --------------------------------------------------- |
| `preview.<domain>` | Integrated `main` (existing dev stack on port 7912) |
| `<N>.<domain>`     | PR N's head in `manifold-pr-N`; machine `pr-N`      |
| `<name>.<domain>`  | Live host worktree: Vite HMR and Bun watch          |

Requirements: Bash, Bun, Docker Compose, Caddy, curl, jq, flock, Git and systemd
user services. Enable linger for the deployment user. Keep this tooling in a stable
checkout outside disposable preview checkouts. One hub uses approximately 140 MiB.
The registry (`name kind port` per line) and data live under `PREVIEW_HOME`, default
`$HOME/manifold-previews`. Only this user may write it; lifecycle operations serialize.
The router and live user units are generated, enabled at boot, and survive logout.
`deploy-preview.yml` skips `up` for a head whose whole diff is Markdown outside `changes/`
(nothing to show); `down` on a PR that never came up is a no-op, so teardown is unconditional.

Numbered previews build with the title `pr-N - manifold` and a teal favicon (`#0f766e`),
distinct from production and the integrated preview. Both use the existing shell-identity
build inputs; the PR number comes from the deployment's `PREVIEW_MACHINE`.

## Configuration

Write `$PREVIEW_HOME/env` before using the SSH receiver. It is literal `KEY=VALUE`,
without shell quoting, expansion or secrets; blank lines and `#` comments are allowed.
The CLI also reads this file; file values override inherited environment values.

- `PREVIEW_DOMAIN`: required base domain (without `preview.`).
- `PREVIEW_DEV_CHECKOUT`: existing dev checkout; default `$HOME/manifold-dev`.
- `PREVIEW_DEV_URL`: dev health URL; default `https://preview.<domain>`.
- `PREVIEW_SEED`: optional absolute path to a `/data` backup `.tgz`; new PR volumes only. The
  production assertion signing key is always excluded so every preview generates its own.
- `PREVIEW_PORT_RANGE`: default `7920-7999`; live servers use routed port + 1000.
- `PREVIEW_ROUTER_PORT`: default `7900`; change the public proxy and ask URL to match.
- `MANIFOLD_DEV_SPOKE_UNIT`: optional user unit; unset skips the dev spoke rebuild.
- `MANIFOLD_DEV_SPOKE_BINARY`: default `$HOME/.local/share/manifold-dev-agent/manifold-agent`.
- `MANIFOLD_DEV_SPOKE_ENV`: build stamp file; default `$HOME/.config/manifold/dev/agent.env`.

Production browser identity is the normal preview admission path. Set
`MANIFOLD_PREVIEW_DOMAIN=<domain>` on the production manifold instance whose public URL is
`https://<domain>`; the preview tooling automatically gives integrated and numbered preview
processes `MANIFOLD_IDENTITY_AUTHORITY=https://<domain>`. Production issues only for those hosts;
a live worktree keeps its own key and does not advertise the production authority. No production
owner key, bearer, signing private key or per-preview secret belongs on the preview host.

Rollout has two independent inputs: deploy the issuer support and namespace configuration on
production, then update the stable tooling checkout used by the SSH receiver before redeploying
previews. `compose.preview.yaml` is loaded from that stable checkout, not from the PR being
built. A successful app build does not prove admission is configured: check each preview's
`GET /api/identity/preview-config` names the production origin, then exercise the browser
handoff through its ordinary public URL.

Set `PREVIEW_HOME` in the invoking environment, not inside its own env file. The dev
checkout keeps its existing Compose configuration; no preview verb changes that stack.
Create `preview` and `*` DNS A records pointing to the host's public address.
In the operator-owned public Caddy configuration **outside this repository**, substitute
`<domain>` and add the global option to your existing global block:

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:7900/__preview/ask
  }
}
preview.<domain> {
  reverse_proxy 127.0.0.1:7912
}
*.<domain> {
  tls { on_demand }
  reverse_proxy 127.0.0.1:7900
}
```

With `on_demand`, Caddy issues a certificate for each requested hostname at handshake time
(HTTP validation), never a wildcard certificate, so no DNS plugin or zone credential is
needed; the ask endpoint permits only `preview.<domain>` and registered names. Prefer the
`*.<domain>` site address over a catch-all `https://` on a host that fronts other sites.
Forced-command `authorized_keys` entry (use absolute paths; no forwarding or PTY):

```text
restrict,command="env PREVIEW_HOME=/path/to/previews /path/to/repo/infra/previews/receiver.sh" ssh-ed25519 <public-key>
```

## Operations

Run `infra/previews/preview.sh` with: `router`; `up 123 <sha>`; `down 123`; `ls`;
`url 123`; `live feature /path/to/worktree`; `url feature`; `unlive feature`; `gc`.
`up` reuses the port and data on redeploy, waits for the exact build, then prints its URL.
`down` destroys the container, volume and checkout. `unlive` retains live data.
`gc` removes PRs reported CLOSED or MERGED by `gh pr view`; without `gh` it is a no-op.
The receiver accepts `dev <sha>`, `preview up 123 <sha>`, `preview down 123`, or a
bare `<sha>` (legacy dev deployment). Other commands are refused.

Integrated and numbered previews normally admit an existing production browser identity through
the POST handoff in ADR 0027. The ordinary public URL carries no credential. A fresh seeded
preview still accepts the development owner key as break-glass; `url 123` prints its pre-auth
`/#key=…` URL **only in the operator's local terminal**, and automated deployment never announces
it. Live keys stay in `$PREVIEW_HOME/live/<name>/data/owner.key`; journals contain no pre-auth URL.
Observe live processes with `journalctl --user -u manifold-live-feature` and restart
with `systemctl --user restart manifold-live-feature`. Install worktree dependencies
with `bun install --frozen-lockfile` before `live`; source changes update without redeploy.
