{
  # Fleet packaging (issue #40): standalone binaries for dotfiles-managed nodes.
  #
  #   nix build .#manifold-agent    -> result/bin/manifold-agent (transport or --terminal-host)
  #   nix build .#manifold-server   -> result/bin/manifold-server (hub + bundled web dist)
  #
  # Both are `bun build --compile` binaries: the Bun runtime plus the bundled
  # workspace sources, so nodes need no repo checkout and no bun install.
  # Configuration (see docs/CONTRACTS.md): both agent modes require
  # MANIFOLD_TERMINAL_HOST_SOCKET. Plain agent is the replaceable transport and
  # also takes MANIFOLD_SERVER_URL + MANIFOLD_MACHINE_TOKEN(_FILE) +
  # MANIFOLD_MACHINE_NAME; --terminal-host owns PTYs independently.
  # The standalone packaged server defaults to hub-only. The native NixOS module
  # enables authenticated preparation, then independently supervises the packaged
  # owner and transport. No packaged process tries to execute a source checkout.
  description = "manifold - agent-native shared spatial workspace";

  # The stable branch still supports every advertised target, including Intel macOS.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

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
      # Fixed-output hash of the vendored node_modules tree, per system (the
      # native optionalDependencies bun materializes differ per platform).
      # Measured with the pinned Bun's explicit optional-dependency target selectors.
      # Regenerate and independently rebuild these trees when their inputs change.
      depsHashes = {
        x86_64-linux = "sha256-0paLt9t5ds7yb1qNvL55jI7iqq3jVLVa0CX2HQO2DBs=";
        aarch64-linux = "sha256-hOVg3G0Urms8rulRfQMhyX4dS23GOmFIAm3PW6V/BAc=";
        x86_64-darwin = "sha256-gT5aDGDbf2yybZaGUbbETgyibZwCxRH8wW5MvXwlWSM=";
        aarch64-darwin = "sha256-PL/Ez5Y4VYgmzziKupeE+ySsRuDt1WCt7cXW7S5dl5E=";
      };

      # Input of the vendored-dependency FOD. Deliberately not `self`: keying it
      # on the whole workspace re-derives the FOD on every unrelated commit, so
      # nothing is ever reused from the store and each commit re-runs a cold,
      # live-network `bun install` — re-rolling the dice on exactly the
      # nondeterminism issue #51 tracks, and re-downloading ~240 MB to produce a
      # tree that did not change. bun needs only the dependency-defining files:
      # it resolves the `workspace:*` members from their package.json manifests
      # and links them as relative symlinks without reading their sources.
      # Verified: installing from this subset yields a node_modules tree
      # byte-identical to installing from the full workspace, so the FOD is now
      # rebuilt only when the dependencies themselves change.
      bunDepsSrc = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./bun.lock
          ./bunfig.toml
          ./package.json
          ./patches
          (nixpkgs.lib.fileset.fileFilter (file: file.name == "package.json") ./packages)
        ];
      };
    in
    {
      nixosModules.native = import ./infra/native/module.nix { inherit self; };
      checks = eachSystem (
        pkgs: nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          native-profile = (import (nixpkgs + "/nixos/lib") { inherit (pkgs) lib; }).runTest (
            import ./infra/native/module-test.nix { inherit self pkgs; }
          );
        }
      );
      packages = eachSystem (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) system;
          # Pin the required runtime independently of the package collection;
          # an assertion cannot upgrade its older Bun.
          # Digests: official bun-v1.4.2 release asset metadata (2026-09-09),
          # https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.2
          bunSources = {
            x86_64-linux = {
              archive = "bun-linux-x64-baseline.zip";
              sha256 = "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f";
            };
            aarch64-linux = {
              archive = "bun-linux-aarch64.zip";
              sha256 = "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7";
            };
            x86_64-darwin = {
              archive = "bun-darwin-x64-baseline.zip";
              sha256 = "bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0";
            };
            aarch64-darwin = {
              archive = "bun-darwin-aarch64.zip";
              sha256 = "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f";
            };
          };
          bun = pkgs.bun.overrideAttrs (_final: previous: {
            version = "1.4.2";
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${bunSources.${system}.archive}";
              inherit (bunSources.${system}) sha256;
            };
            meta = previous.meta // { platforms = systems; };
          });

          # Vendored node_modules keyed on bun.lock: the only network-touching
          # derivation. It must produce the installed tree, not bun's download
          # cache — every later derivation runs in the netless build sandbox and
          # cannot resolve anything bun has not already materialized.
          # `--ignore-scripts` keeps the output deterministic (no lifecycle
          # script output lands in the tree; nothing in this workspace needs
          # lifecycle scripts).
          #
          # `--linker=hoisted` is load-bearing, not a style choice (issue #51).
          # bun >=1.3 defaults workspaces to the isolated linker, which stages
          # every package under node_modules/.bun/<name>@<version>+<peerhash>/
          # and then races on whether it materializes the .bin shims a store
          # entry inherits from its *peer* dependencies. Eight cold builds of
          # this derivation in the nix sandbox on one machine produced three
          # different output hashes, differing only in
          #   .bun/@eslint-community+eslint-utils@…/node_modules/.bin/eslint
          #   .bun/update-browserslist-db@…/node_modules/.bin/browserslist
          # (eslint and browserslist are peerDependencies of those two
          # packages, and neither shim is ever executed). A fixed-output
          # derivation cannot tolerate that: the output hash becomes a coin flip
          # decided by scheduling, which is why the same drv hashed differently
          # on a CI runner than on the machine that pinned it. The hoisted
          # linker builds no peer-scoped store, so the race has nowhere to
          # happen: eleven consecutive cold builds reproduce bit for bit. It
          # also restores the layout the rest of this flake documents and
          # depends on — relative workspace symlinks
          # (node_modules/@manifold/* -> ../../packages/*), which the isolated
          # linker does not create at all.
          bunDeps = pkgs.stdenvNoCC.mkDerivation {
            pname = "manifold-bun-deps";
            inherit version;
            src = bunDepsSrc;
            nativeBuildInputs = [
              bun
              pkgs.cacert
            ];
            dontConfigure = true;
            dontFixup = true;
            buildPhase = ''
              export HOME="$TMPDIR"
              export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-install-cache"
              bun install --frozen-lockfile --ignore-scripts --no-progress \
                --backend=copyfile --linker=hoisted \
                --os=${if pkgs.stdenv.hostPlatform.isLinux then "linux" else "darwin"} \
                --cpu=${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}
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
                bun
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
                  --set-default MANIFOLD_VERSION "${version}" \
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
          # Exposed so the vendored tree can be re-pinned and its
          # reproducibility checked on its own, without building a binary:
          #   nix build .#bun-deps
          #   nix build .#bun-deps --rebuild   # must not report a hash mismatch
          bun-deps = bunDeps;
          bun-runtime = bun;

          manifold-agent = compiled {
            pname = "manifold-agent";
            entry = "packages/agent/src/main.ts";
            wrapperArgs = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux
              ''--prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath [ pkgs.glibc ]}"'';
          };

          manifold-server = compiled {
            pname = "manifold-server";
            entry = "packages/server/src/main.ts";
            extraBuild = ''
              bun run changelog:generate
              (cd packages/web && bun run build)
            '';
            extraInstall = ''
              mkdir -p "$out/share/manifold"
              cp -r packages/web/dist "$out/share/manifold/web"
            '';
            wrapperArgs = ''--set-default MANIFOLD_WEB_DIST "$out/share/manifold/web" --set-default MANIFOLD_SPAWN_AGENT 0 --prefix PATH : "${bun}/bin"'';
          };
        }
      );
    };
}
