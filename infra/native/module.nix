{ self }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.services.manifold;
  native = cfg.execution.enable;
  local = cfg.hub.enable && native;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  data = "/var/lib/manifold";
  workload = "/var/lib/manifold-workload";
  output = "/var/lib/manifold-output";
  control = "${data}/job-owner";
  cgroup = "/sys/fs/cgroup/system.slice/manifold-owner.service";
  credentialSource = cfg.execution.tokenCredentialFile;
  credentialMode = credentialSource != null;
  tokenFile = if credentialMode then "%d/enrollment-token" else if local then "${data}/agent.token" else cfg.execution.tokenFile;
  containsPath = parent: path: parent == path || lib.hasPrefix "${parent}/" path;
  # The owner holds exclusion descriptors. A private source can sit beneath an
  # explicitly protected, traversable ancestor without opening its private parent.
  credentialSourceDirectories = lib.optional
    (credentialMode && !lib.any (path: containsPath path credentialSource) cfg.execution.protectedDirectories)
    (builtins.dirOf credentialSource);
  anchors = {
    home = "${workload}/home";
    data = "${workload}/data";
    state = "${workload}/state";
    cache = "${workload}/cache";
    config = "${workload}/config";
    # A named-output location must resolve from this anchor, not cross its mount
    # from a disk-backed ancestor. The runtime forbids descendant mount escapes.
    runtime = output;
  };
  template = {
    delegatedCgroup = "${cgroup}/jobs";
    bubblewrap = "${pkgs.bubblewrap}/bin/bwrap";
    protectedDirectories = lib.unique ([ data ] ++ cfg.execution.protectedDirectories
      ++ lib.optional (cfg.execution.tokenFile != null) (builtins.dirOf cfg.execution.tokenFile)
      ++ lib.optionals credentialMode ([ "/run/credentials" ] ++ credentialSourceDirectories)
      ++ map (credential: builtins.dirOf credential.source) (builtins.attrValues cfg.execution.serviceCredentials));
    inherit anchors;
    inherit (cfg.execution) runtimeTools artifactOrigins serviceCredentials;
  };
  templateFile = pkgs.writeText "manifold-owner-template.json" (builtins.toJSON template);
  remoteConfig = pkgs.writeText "manifold-owner-config.json" (builtins.toJSON (template // {
    machineId = cfg.execution.machineId;
    admissionPublicKey = cfg.execution.admissionPublicKey;
    stateDirectory = "${control}/state";
  }));
  # Never overwrite an incumbent configuration, even if no process appears online.
  # Explicit drained maintenance owns removing a retired configuration.
  # The immutable store copy uses the runtime's descriptor/publication implementation.
  installPrivateConfig = pkgs.writeText "manifold-install-private-config.ts" ''
    import { closeSync, fstatSync, readFileSync } from "node:fs";
    import { basename, dirname } from "node:path";
    import { HeldDirectory } from "${../../packages/agent/src/job-files.ts}";

    function install(source: string, destination: string): void {
      const parent = HeldDirectory.openAbsolute(dirname(destination), { private: true });
      try {
        const contents = readFileSync(source);
        if (contents.length > 65536) throw new Error("oversized_configuration");
        const name = basename(destination);
        try {
          parent.atomicWrite(name, contents, 0o600, true);
        } catch (error) {
          if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
        }
        // A concurrent publisher wins without replacement; compare its final inode and bytes.
        const fd = parent.openFile(name);
        try {
          const identity = fstatSync(fd);
          if (identity.uid !== process.getuid?.() || (identity.mode & 0o777) !== 0o600
              || identity.size > 65536 || !readFileSync(fd).equals(contents))
            throw new Error("unsafe_or_changed_configuration");
          const current = parent.openFile(name);
          try {
            const published = fstatSync(current);
            if (published.dev !== identity.dev || published.ino !== identity.ino)
              throw new Error("changed_configuration_identity");
          } finally {
            closeSync(current);
          }
        } finally {
          closeSync(fd);
        }
        parent.sync();
      } finally {
        parent.close();
      }
    }

    try {
      const [source, destination] = process.argv.slice(2);
      if (!source || !destination) throw new Error("missing_configuration_paths");
      install(source, destination);
    } catch {
      console.error("Manifold refuses unsafe or changed configuration: hold for drained owner maintenance");
      process.exitCode = 1;
    }
  '';
  installOnce = source: destination: ''
    ${packages.bun-runtime}/bin/bun ${installPrivateConfig} ${lib.escapeShellArg (toString source)} ${lib.escapeShellArg destination}
  '';
  prepareCgroup = pkgs.writeShellScript "manifold-owner-cgroup" ''
    set -eu
    test -z "$(cat ${cgroup}/cgroup.procs)"
    printf '+cpu +memory +pids\n' > ${cgroup}/cgroup.subtree_control
    mkdir -p ${cgroup}/jobs
    test -z "$(cat ${cgroup}/jobs/cgroup.procs)"
    printf '+cpu +memory +pids\n' > ${cgroup}/jobs/cgroup.subtree_control
    for controller in cpu memory pids; do
      case " $(cat ${cgroup}/jobs/cgroup.subtree_control) " in
        *" $controller "*) ;;
        *) echo 'Manifold requires cpu, memory and pids delegation' >&2; exit 1 ;;
      esac
    done
    help="$(${pkgs.bubblewrap}/bin/bwrap --help)"
    for flag in --bind-fd --ro-bind-fd --ro-bind-data --block-fd --info-fd --seccomp; do
      case "$help" in
        *"$flag"*) ;;
        *) echo 'Manifold bubblewrap lacks required descriptor enforcement' >&2; exit 1 ;;
      esac
    done
  '';
  waitForConfig = pkgs.writeShellScript "manifold-wait-owner-config" ''
    set -eu
    for attempt in $(seq 1 60); do
      if test -f ${control}/config.json && test -f ${data}/agent.token; then exit 0; fi
      sleep 1
    done
    echo 'Manifold authenticated local bootstrap did not prepare owner configuration' >&2
    exit 1
  '';
  checkCredentialSource = pkgs.writeShellScript "manifold-check-enrollment-credential-source" ''
    set -eu
    source=${lib.escapeShellArg (if credentialMode then credentialSource else "")}
    service_uid="$(${pkgs.coreutils}/bin/id -u manifold)"
    test -f "$source"
    path="$source"
    while :; do
      # A service-owned read-only inode is not protected: its owner can chmod it.
      # Check every component before PID 1 loads the credential; reject symlink
      # indirection and writable ancestors, including ACL-granted service access.
      test ! -L "$path"
      test "$(${pkgs.coreutils}/bin/stat -c %u "$path")" != "$service_uid"
      # A distinct success code prevents a privilege-drop failure from being
      # mistaken for "not writable". The probe never opens credential bytes.
      status=0
      ${pkgs.util-linux}/bin/setpriv --reuid=manifold --regid=manifold --init-groups \
        ${pkgs.runtimeShell} -c 'if test -w "$1"; then exit 10; else exit 20; fi' -- "$path" || status=$?
      if test "$status" != 20; then
        echo 'Manifold enrollment credential source custody check failed' >&2
        exit 1
      fi
      if test "$path" = /; then break; fi
      path="$(${pkgs.coreutils}/bin/dirname "$path")"
      test -d "$path"
    done
  '';
  commonService = {
    User = "manifold";
    Group = "manifold";
    UMask = "0077";
    WorkingDirectory = anchors.home;
    Restart = "on-failure";
    RestartSec = 3;
  };
  sockets = {
    MANIFOLD_TERMINAL_HOST_SOCKET = "${data}/terminal-host/host.sock";
    MANIFOLD_JOB_OWNER_SOCKET = "${control}/owner.sock";
  };
in
{
  options.services.manifold = {
    enable = mkEnableOption "the packaged Manifold Linux deployment";
    hub.enable = mkOption { type = types.bool; default = true; description = "Run the HTTP/WebSocket hub and durable authority store."; };
    hub.publicUrl = mkOption { type = types.str; default = "http://localhost:7777"; description = "Canonical external URL; terminate TLS in an independently configured reverse proxy."; };
    hub.bind = mkOption { type = types.str; default = "127.0.0.1"; };
    hub.port = mkOption { type = types.port; default = 7777; };
    hub.serviceOwnerMachineId = mkOption { type = types.nullOr types.str; default = null; description = "Explicit enrolled remote service owner ID; null selects authenticated local identity when provisioned. No name lookup or failover."; };
    hub.environmentFile = mkOption { type = types.nullOr types.str; default = null; description = "Optional private runtime server environment; never a Nix store secret."; };
    execution = {
      enable = mkEnableOption "an independently supervised terminal/native owner and transport";
      machineName = mkOption { type = types.str; default = "local"; };
      serverUrl = mkOption { type = types.str; default = ""; description = "Remote hub origin for execution-only nodes."; };
      machineId = mkOption { type = types.str; default = ""; description = "Execution-only node's ID returned by core.machines.enroll."; };
      admissionPublicKey = mkOption { type = types.str; default = ""; description = "Public SPKI key from authenticated engine.jobs.describe; never the hub private key."; };
      tokenFile = mkOption { type = types.nullOr types.str; default = null; description = "Execution-only node's retained 0600 machine token file, owned by manifold. Never put its contents in Nix."; };
      tokenCredentialFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Explicit static absolute enrollment credential source under its declaring tool's custody, not writable or owned by manifold. PID 1 delivers it with LoadCredential; never put bytes or a Nix path literal here. Mutually exclusive with tokenFile. No symlinks, path traversal or systemd specifiers. The source parent must be traversable by manifold for workload exclusion, or lie beneath a traversable directory declared in protectedDirectories; private descendants and the source itself need not be readable. Changing the owner exclusion configuration requires positive drain/shutdown maintenance.";
      };
      artifactOrigins = mkOption { type = types.listOf types.str; default = []; description = "Reviewed HTTPS origins for artifact acquisition, including permitted redirect origins."; };
      runtimeTools = mkOption { type = types.attrsOf (types.listOf (types.attrsOf types.str)); default = {}; description = "Reviewed source/target/kind runtime closure bindings, keyed by declared tool name. No host PATH discovery."; };
      serviceCredentials = mkOption {
        type = types.attrsOf (types.submodule {
          options = {
            source = mkOption {
              type = types.strMatching "/.*";
              description = "Absolute private runtime credential file owned by manifold, never secret bytes or a Nix path literal.";
            };
            origins = mkOption {
              type = types.listOf types.str;
              description = "Allowed canonical HTTPS origins (HTTP only for 127.0.0.1 or [::1]), checked by the owner schema.";
            };
          };
        });
        default = {};
        description = "Reviewed credentialRef sources keyed by reference name. Parent directories are excluded from workload mounts; credential bytes never enter the Nix store.";
      };
      protectedDirectories = mkOption { type = types.listOf types.str; default = []; description = "Existing control/credential directories excluded from all workload mounts in addition to /var/lib/manifold."; };
      outputBytes = mkOption { type = types.ints.positive; default = 1048576; description = "Dedicated named-output tmpfs capacity. Every job using it reserves the entire capacity from outputBytes, before stdout/stderr."; };
      outputInodes = mkOption { type = types.ints.between 1 10000; default = 4096; };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      { assertion = pkgs.stdenv.hostPlatform.isLinux && builtins.elem pkgs.stdenv.hostPlatform.system [ "x86_64-linux" "aarch64-linux" ]; message = "Native Manifold supports Linux x64/arm64 only."; }
      { assertion = cfg.hub.enable || native; message = "Select at least one Manifold role."; }
      { assertion = !local || cfg.hub.port > 0 && builtins.elem cfg.hub.bind [ "127.0.0.1" "0.0.0.0" ]; message = "Single-node Manifold requires a fixed port reachable on IPv4 loopback by its transport."; }
      { assertion = !native || lib.versionAtLeast config.systemd.package.version "254"; message = "Native Manifold requires systemd >= 254 (DelegateSubgroup)."; }
      { assertion = !native || cfg.execution.artifactOrigins != []; message = "Declare reviewed Manifold artifact origins."; }
      { assertion = !native || cfg.execution.outputBytes <= 1073741824; message = "Named output backing cannot exceed the runtime's 1 GiB aggregate output ceiling."; }
      { assertion = !native || cfg.execution.outputBytes >= 4096 && lib.mod cfg.execution.outputBytes 4096 == 0; message = "Named output capacity must be a positive whole number of 4 KiB pages."; }
      { assertion = !native || local || (cfg.execution.serverUrl != "" && cfg.execution.machineId != "" && cfg.execution.admissionPublicKey != "" && (cfg.execution.tokenFile != null || credentialMode)); message = "Execution-only nodes require explicit supported enrollment, verifier key and a private token file or systemd credential reference."; }
      { assertion = !native || !credentialMode || cfg.execution.tokenFile == null; message = "Select only one Manifold enrollment token input: tokenFile or tokenCredentialFile."; }
      {
        assertion = !native || !credentialMode || (
          lib.hasPrefix "/" credentialSource
          && lib.all (part: part != "" && part != "." && part != "..") (lib.drop 1 (lib.splitString "/" credentialSource))
          && lib.all (character: !lib.hasInfix character credentialSource) [ "%" ":" "\n" "\r" "\\" ]
          && !lib.any (path: containsPath path credentialSource) [ data workload output "/run/credentials" "/proc" "/sys" "/dev" "/nix/store" ]
        );
        message = "tokenCredentialFile must be a static normalized absolute runtime path outside Manifold's service/workload areas, systemd credentials, kernel interfaces and the Nix store.";
      }
    ];

    users.groups.manifold = {};
    users.users.manifold = {
      isSystemUser = true;
      group = "manifold";
      home = anchors.home;
      shell = pkgs.bashInteractive;
    };
    systemd.tmpfiles.rules = [
      "d ${data} 0700 manifold manifold -"
      "d ${workload} 0700 manifold manifold -"
    ] ++ map (path: "d ${path} 0700 manifold manifold -") (builtins.attrValues (builtins.removeAttrs anchors [ "runtime" ]))
      ++ lib.optionals (native && credentialMode) [
        # Unspecified metadata creates the default root 0755 directory only if
        # absent; it never chmods/chowns an existing systemd credential store.
        "d /run/credentials - - - -"
      ]
      ++ lib.optionals native [
        "d ${control} 0700 manifold manifold -"
        "d ${control}/state 0700 manifold manifold -"
        "d ${data}/terminal-host 0700 manifold manifold -"
        "d ${output} 0700 manifold manifold -"
      ];

    # These are deliberate Linux prerequisites, not container privileges. The owner
    # opens held descriptors and creates user/mount/PID/network namespaces itself.
    security.allowUserNamespaces = mkIf native true;
    systemd.mounts = lib.optionals native [{
      what = "tmpfs";
      where = output;
      type = "tmpfs";
      options = "mode=0700,uid=manifold,gid=manifold,nosuid,nodev,noexec,size=${toString cfg.execution.outputBytes},nr_inodes=${toString cfg.execution.outputInodes}";
      wantedBy = [ "multi-user.target" ];
      before = [ "manifold-owner.service" "manifold-server.service" ];
      after = [ "systemd-sysusers.service" ];
      unitConfig.RefuseManualStop = true;
    }];

    systemd.services.manifold-server = mkIf cfg.hub.enable {
      description = "Manifold hub (no child-owned execution lifetime)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "systemd-tmpfiles-setup.service" ];
      requires = lib.optionals native [ "var-lib-manifold\\x2doutput.mount" ];
      environment = {
        MANIFOLD_DATA_DIR = data;
        MANIFOLD_PUBLIC_URL = cfg.hub.publicUrl;
        MANIFOLD_BIND = cfg.hub.bind;
        MANIFOLD_PORT = toString cfg.hub.port;
        MANIFOLD_SPAWN_AGENT = if local then "1" else "0";
      } // lib.optionalAttrs local {
        MANIFOLD_LOCAL_AGENT_SUPERVISION = "external";
        MANIFOLD_LOCAL_JOB_OWNER_TEMPLATE = "${data}/owner-template.json";
        MANIFOLD_MACHINE_NAME = cfg.execution.machineName;
      } // lib.optionalAttrs (cfg.hub.serviceOwnerMachineId != null) {
        MANIFOLD_SERVICE_OWNER_MACHINE_ID = cfg.hub.serviceOwnerMachineId;
      };
      preStart = lib.optionalString local (installOnce templateFile "${data}/owner-template.json");
      serviceConfig = commonService // {
        ExecStart = "${packages.manifold-server}/bin/manifold-server";
      } // lib.optionalAttrs (cfg.hub.environmentFile != null) {
        EnvironmentFile = cfg.hub.environmentFile;
      };
    };

    systemd.services.manifold-owner = mkIf native {
      description = "Manifold retained terminal and native job owner";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-tmpfiles-setup.service" "var-lib-manifold\\x2doutput.mount" ] ++ lib.optional local "manifold-server.service";
      wants = [ "var-lib-manifold\\x2doutput.mount" ];
      # No PartOf/BindsTo/Requires on the hub or transport. A hub restart must not
      # signal this cgroup. Nix activation may update its definition, never restart it.
      restartIfChanged = false;
      stopIfChanged = false;
      unitConfig.RefuseManualStop = true;
      environment = sockets // { MANIFOLD_JOB_OWNER_CONFIG = "${control}/config.json"; };
      preStart = if local then "${waitForConfig}" else installOnce remoteConfig "${control}/config.json";
      # The main executor must enter its delegated subgroup before parent controllers
      # are enabled; doing this in ExecStartPre prevents systemd from spawning it.
      script = ''
        set -eu
        ${prepareCgroup}
        exec ${packages.manifold-agent}/bin/manifold-agent --terminal-host
      '';
      serviceConfig = commonService // {
        Delegate = "cpu memory pids";
        DelegateSubgroup = "supervisor";
        TimeoutStartSec = 75;
        TimeoutStopSec = 90;
      };
    };

    # A separate prerequisite, rather than ExecStartPre, runs before PID 1 reads
    # LoadCredential. It never reads bytes or repairs the declaring tool's custody.
    # No RemainAfterExit: every transport start rechecks the source and its parents.
    systemd.services.manifold-token-credential-source = mkIf (native && credentialMode) {
      description = "Check Manifold enrollment credential source custody";
      after = [ "systemd-tmpfiles-setup.service" ];
      script = "${checkCredentialSource}";
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
    };

    systemd.services.manifold-transport = mkIf native {
      description = "Manifold replaceable machine transport";
      wantedBy = [ "multi-user.target" ];
      after = [ "manifold-owner.service" "network-online.target" ] ++ lib.optional credentialMode "manifold-token-credential-source.service";
      requires = lib.optional credentialMode "manifold-token-credential-source.service";
      wants = [ "network-online.target" ];
      environment = sockets // {
        MANIFOLD_SERVER_URL = if local then "http://127.0.0.1:${toString cfg.hub.port}" else cfg.execution.serverUrl;
        MANIFOLD_MACHINE_NAME = cfg.execution.machineName;
        MANIFOLD_MACHINE_TOKEN_FILE = tokenFile;
      };
      preStart = lib.optionalString local "${waitForConfig}\n" + (if credentialMode then ''
        token="$CREDENTIALS_DIRECTORY/enrollment-token"
        test ! -L "$token"
        test -f "$token"
        test -r "$token"
        test ! -w "$token"
        test ! -w "$CREDENTIALS_DIRECTORY"
      '' else ''
        token=${lib.escapeShellArg (if tokenFile == null then "" else tokenFile)}
        test ! -L "$token"
        test -f "$token"
        test "$(stat -c '%u:%a' "$token")" = "$(id -u):600"
        test "$(stat -c '%u:%a' "$(dirname "$token")")" = "$(id -u):700"
      '');
      serviceConfig = commonService // {
        ExecStart = "${packages.manifold-agent}/bin/manifold-agent";
      } // lib.optionalAttrs credentialMode {
        LoadCredential = [ "enrollment-token:${credentialSource}" ];
      };
    };
  };
}
