{
  # Fleet packaging (issue #40): standalone binaries for dotfiles-managed nodes.
  #
  #   nix build .#manifold-agent    -> result/bin/manifold-agent (dial-out PTY daemon)
  #   nix build .#manifold-server   -> result/bin/manifold-server (hub + bundled web dist)
  #
  # Both are `bun build --compile` binaries: the Bun runtime plus the bundled
  # workspace sources, so nodes need no repo checkout and no bun install.
  # Configuration is env-only (see docs/CONTRACTS.md): the agent takes
  # MANIFOLD_SERVER_URL + MANIFOLD_MACHINE_TOKEN(_FILE) + MANIFOLD_MACHINE_NAME,
  # the server its MANIFOLD_* set. The packaged server defaults
  # MANIFOLD_SPAWN_AGENT=0 because the source-tree local-agent respawn
  # (agent-spawn.ts) execs `bun` against a repo checkout that does not exist on
  # a packaged node; a packaged hub's machine enrolls like any other node.
  description = "manifold - agent-native shared spatial workspace";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Single source of truth for the release version (kept current by scripts/release.ts).
      version = (builtins.fromJSON (builtins.readFile ./packages/web/package.json)).version;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # Fixed-output hash of the vendored node_modules tree, per system (native
      # packages differ). Filled in the first time a system builds: leave the
      # entry as lib.fakeHash, run `nix build .#manifold-agent`, copy the
      # "got:" hash here.
      depsHashes = {
        x86_64-linux = "sha256-MUrQk0kCoK58BSOrOMu9hoDMPOEfHMit6oe/299vK0A=";
        aarch64-linux = nixpkgs.lib.fakeHash;
        x86_64-darwin = nixpkgs.lib.fakeHash;
        aarch64-darwin = nixpkgs.lib.fakeHash;
      };
    in
    {
      packages = eachSystem (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) system;

          # Vendored node_modules keyed on bun.lock: the only network-touching
          # derivation. It must produce the installed tree, not bun's download
          # cache — every later derivation runs in the netless build sandbox and
          # cannot resolve anything bun has not already materialized. Its input
          # is the full workspace source because @manifold/protocol,
          # @manifold/scene and @manifold/sdk are consumed from source through
          # `workspace:*`, so bun links them only with the real package tree
          # present. `--ignore-scripts` keeps the output deterministic (no
          # lifecycle script output lands in the tree; nothing in this workspace
          # needs lifecycle scripts). Workspace symlinks (@manifold/* ->
          # ../packages/*) are relative, so they dangle in $out and resolve
          # again once the tree is copied back into a checkout.
          bunDeps = pkgs.stdenvNoCC.mkDerivation {
            pname = "manifold-bun-deps";
            inherit version;
            src = self;
            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
            ];
            dontConfigure = true;
            dontFixup = true;
            buildPhase = ''
              export HOME="$TMPDIR"
              export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-install-cache"
              bun install --frozen-lockfile --ignore-scripts --no-progress --backend=copyfile
            '';
            installPhase = ''
              mkdir -p "$out"
              find . -type d -name node_modules -prune -print0 |
                tar --null --files-from - -cf - |
                tar -xf - -C "$out"
            '';
            outputHashMode = "recursive";
            outputHash = depsHashes.${system};
          };

          # Materialize the vendored tree into the build's source copy. The
          # store copy is read-only; the web build writes vite caches under
          # node_modules, so grant the builder write permission. node_modules
          # bin stubs use `#!/usr/bin/env node` shebangs, which do not exist
          # in the sandbox — patch them to the build-time nodejs.
          restoreDeps = ''
            export HOME="$TMPDIR"
            cp -R ${bunDeps}/. .
            find . -type d -name node_modules -prune -exec chmod -R u+w {} +
            while IFS= read -r dir; do
              patchShebangs --build "$dir" >/dev/null
            done < <(find . -type d -name node_modules -prune)
          '';

          compiled =
            {
              pname,
              entry,
              extraBuild ? "",
              extraInstall ? "",
              # Raw shell fragment appended to the makeWrapper call; runs in
              # installPhase where $out is in scope.
              wrapperArgs ? "",
            }:
            pkgs.stdenvNoCC.mkDerivation {
              inherit pname version;
              src = self;
              nativeBuildInputs = [
                pkgs.bun
                pkgs.makeWrapper
                # Only the web build (vite) runs under node; the compiled
                # binaries embed the bun runtime and never reference it.
                pkgs.nodejs
              ];
              dontConfigure = true;
              # Stripping would corrupt the bundle appended to the bun runtime.
              dontStrip = true;
              buildPhase = ''
                runHook preBuild
                ${restoreDeps}
                ${extraBuild}
                bun build --compile ${entry} --outfile ${pname}
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                install -Dm755 ${pname} "$out/libexec/${pname}"
                ${extraInstall}
                makeWrapper "$out/libexec/${pname}" "$out/bin/${pname}" \
                  --set-default MANIFOLD_BUILD "${self.rev or self.dirtyRev or "unknown"}" ${wrapperArgs}
                runHook postInstall
              '';
              meta = {
                description = "manifold - agent-native shared spatial workspace (${pname})";
                homepage = "https://github.com/atyrode/manifold";
                mainProgram = pname;
                platforms = systems;
              };
            };
        in
        {
          manifold-agent = compiled {
            pname = "manifold-agent";
            entry = "packages/agent/src/main.ts";
          };

          manifold-server = compiled {
            pname = "manifold-server";
            entry = "packages/server/src/main.ts";
            extraBuild = ''
              (cd packages/web && bun run build)
            '';
            extraInstall = ''
              mkdir -p "$out/share/manifold"
              cp -r packages/web/dist "$out/share/manifold/web"
            '';
            wrapperArgs = ''--set-default MANIFOLD_WEB_DIST "$out/share/manifold/web" --set-default MANIFOLD_SPAWN_AGENT 0'';
          };
        }
      );
    };
}
