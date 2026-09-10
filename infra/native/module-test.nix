{ self, pkgs }:
let
  platform = "linux-${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}";
  inspect = pkgs.writeText "manifold-native-profile-inspect.py" ''
    import base64
    import hashlib
    import json
    import os
    import socket
    import sys
    from pathlib import Path
    from urllib.request import Request, urlopen

    key = Path("/var/lib/manifold/owner.key").read_text().strip()

    def action(name, args):
        request = Request(
            "http://127.0.0.1:7777/api/actions/" + name,
            data=json.dumps(args).encode(),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        )
        with urlopen(request, timeout=120) as response:
            outcome = json.load(response)
        assert outcome["ok"], outcome.get("denial")
        return outcome["result"]

    machines = action("core.machines.list", {})["machines"]
    assert len(machines) == 1, "local bootstrap must retain one machine identity"
    machine = machines[0]
    assert machine["online"] and machine.get("terminalExecution") == "governed"
    owner = action("engine.jobs.describe", {"machineId": machine["id"], "pluginId": "sample.worker"})
    assert owner["connected"] and "${platform}" in owner["platforms"]
    mode = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    plugin_id = "fixture.native-profile"
    operation_id = plugin_id + (".hold" if mode.endswith("-hold") else ".run")
    mode = mode.removesuffix("-hold")
    job_id = sys.argv[2] if len(sys.argv) > 2 else "module-native-first"
    node = {"kind": "job", "machineId": machine["id"], "operationId": operation_id, "jobId": job_id}
    limits = {"timeoutMs": 30000, "memoryBytes": 134217728, "processes": 32, "outputBytes": 1024}

    if mode == "install":
        executable = b"#!/bin/busybox sh\nif test -e /var/lib/manifold/owner.key || test -e /etc/manifold-fixture/private/enrollment-token || test -e /run/credentials/manifold-transport.service/enrollment-token; then exit 90; fi\nif test \"$1\" = hold; then /bin/busybox sleep 15; fi\nprintf 'native-module:bounded\\n'\nexit 23\n"
        artifact_hash = hashlib.sha256(executable).hexdigest()
        declaration = {
            "artifacts": {"${platform}": {
                "bundleFile": "worker", "sha256": artifact_hash, "format": "raw",
                "entry": ["fixture"], "entrySha256": artifact_hash,
                "maxBytes": len(executable), "maxExpandedBytes": len(executable), "maxMembers": 1,
            }},
            "locations": {},
            "operations": {operation: {
                "argv": [{"literal": "hold"}] if operation.endswith(".hold") else [],
                "input": {}, "runtimeTools": ["busybox"], "locations": [],
                "outputs": [], "network": "none", "limits": limits, "stdin": False,
            } for operation in [operation_id, plugin_id + ".hold"]},
        }
        bundle = json.dumps({
            "format": 1,
            "manifest": {
                "id": plugin_id, "version": "1.0.0", "title": "Native profile acceptance",
                "description": "Disposable module execution proof", "capabilities": [], "entry": {},
                "contributes": {"panels": [], "sections": [], "elements": [], "tools": [], "events": []},
                "machine": declaration,
            },
            "files": {"worker": base64.b64encode(executable).decode()},
        }).encode()
        bundle_path = Path("/var/lib/manifold/native-profile-fixture.json")
        with os.fdopen(os.open(bundle_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(bundle)
        os.chown(bundle_path, Path("/var/lib/manifold/owner.key").stat().st_uid, -1)
        action("engine.plugins.install", {
            "source": str(bundle_path), "sha256": hashlib.sha256(bundle).hexdigest(), "hardened": True,
        })
        installation = {
            "machineId": machine["id"], "pluginId": plugin_id,
            "installationRevision": "r1", "artifactSha256": artifact_hash,
        }
        action("engine.jobs.install", {**installation, "machine": declaration})
        for operation in declaration["operations"]:
            for capability in ["jobs:read", "machines:run"]:
                action("engine.jobs.consent", {
                    **installation, "cap": capability, "enabled": True,
                    "node": "manifold://machine/" + machine["id"] + "/operation/" + operation,
                })
    elif mode == "execute":
        job = action("engine.jobs.execute", {
            "jobId": job_id, "machineId": machine["id"], "pluginId": plugin_id,
            "operationId": operation_id, "input": {}, "outputs": [], "limits": limits,
        })
        assert job["state"] not in ["refused", "interrupted", "cancelled"], job
    elif mode == "started":
        job = action("engine.jobs.status", {"node": node})
        assert job["state"] == "started", job
    elif mode == "result":
        job = action("engine.jobs.status", {"node": node})
        assert job["state"] == "exited", job
        assert job["result"]["exitCode"] == 23, job
        stdout = next(output for output in job["result"]["outputs"] if output["name"] == "stdout")
        output = action("engine.jobs.output", {
            "node": {**node, "kind": "output", "outputId": stdout["outputId"]},
            "offset": 0, "maxBytes": 1024,
        })
        assert output["type"] == "output" and output["eof"], output
        assert base64.b64decode(output["data"]) == b"native-module:bounded\n"
    elif mode == "shutdown":
        drained = action("core.machines.drain", {"machineId": machine["id"], "draining": True})
        assert drained["draining"] and drained["terminalIds"] == [], drained
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(10)
            connection.connect("/var/lib/manifold/terminal-host/host.sock")
            connection.sendall(b'{"type":"shutdown_request"}\n')
            with connection.makefile("rb") as response:
                acknowledgement = json.loads(response.readline(4096))
            assert acknowledgement["type"] == "shutting_down", acknowledgement
    elif mode == "reopen":
        reopened = action("core.machines.drain", {"machineId": machine["id"], "draining": False})
        assert not reopened["draining"], reopened
    else:
        assert mode == "inspect"
        print(machine["id"])
  '';
  inspectCommand = "${pkgs.python3}/bin/python3 ${inspect}";
in
{
  name = "manifold-native-profile";
  hostPkgs = pkgs;
  # The VM also runs on builders without nested virtualization, using QEMU's CPU emulation.
  requiredFeatures.kvm = false;
  nodes = let common = { lib, ... }: {
    imports = [ self.nixosModules.native ];
    services.manifold = {
      enable = true;
      hub.bind = "0.0.0.0";
      hub.publicUrl = "http://machine:7777";
      execution.enable = true;
      execution.artifactOrigins = [ "https://artifacts.example.test" ];
      execution.runtimeTools.busybox = [{
        source = "${pkgs.pkgsStatic.busybox}/bin/busybox";
        target = "/bin/busybox";
        kind = "file";
      }];
    };
    systemd.services.manifold-server.environment.MANIFOLD_PLUGIN_DEV_PATHS = "1";
    specialisation.changed-native.configuration.services.manifold.execution.artifactOrigins =
      lib.mkForce [ "https://changed.example.test" ];
    virtualisation.cores = 4;
    virtualisation.memorySize = 4096;
    system.stateVersion = "26.05";
  };
  in {
    machine = common;
    credential = { pkgs, ... }: {
      imports = [ common ];
      services.manifold.execution = {
        tokenCredentialFile = "/etc/manifold-fixture/private/enrollment-token";
        protectedDirectories = [ "/etc/manifold-fixture" ];
      };
      users.groups.credential-writers = {};
      systemd.services.manifold-owner.serviceConfig.SupplementaryGroups = [ "credential-writers" ];
      systemd.tmpfiles.rules = [
        "d /etc/manifold-fixture 0755 root root -"
        "d /etc/manifold-fixture/private 0700 root root -"
      ];
      # Only this disposable VM copies its newly generated bootstrap token into
      # separate fixture custody. The profile never acquires or copies a source.
      systemd.services.manifold-fixture-credential = {
        after = [ "manifold-owner.service" ];
        wants = [ "manifold-owner.service" ];
        script = ''
          set -eu
          test ! -e /etc/manifold-fixture/private/enrollment-token
          ${pkgs.coreutils}/bin/install -o root -g root -m 0600 \
            /var/lib/manifold/agent.token /etc/manifold-fixture/private/enrollment-token
        '';
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = "root";
          Group = "root";
        };
      };
      systemd.services.manifold-token-credential-source = {
        after = [ "manifold-fixture-credential.service" ];
        requires = [ "manifold-fixture-credential.service" ];
      };
    };
  };
  testScript = ''
    start_all()
    machine.wait_for_unit("manifold-server.service", timeout=180)
    machine.wait_for_unit("manifold-owner.service", timeout=180)
    machine.wait_for_unit("manifold-transport.service", timeout=180)
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    identity = machine.succeed("${inspectCommand}").strip()
    for path in ["owner.key", "agent.token", "job-owner/config.json"]:
        assert machine.succeed(f"stat -c '%a %U' /var/lib/manifold/{path}").strip() == "600 manifold"
    owner = machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
    assert int(owner) > 1
    machine.succeed("${inspectCommand} install")
    machine.succeed("${inspectCommand} execute")
    machine.wait_until_succeeds("${inspectCommand} result", timeout=180)
    machine.succeed("systemctl restart manifold-server.service manifold-transport.service")
    machine.wait_for_unit("manifold-server.service", timeout=180)
    machine.wait_for_unit("manifold-transport.service", timeout=180)
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    assert machine.succeed("${inspectCommand}").strip() == identity
    assert machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == owner
    machine.succeed("${inspectCommand} result")
    original = machine.succeed("readlink -f /run/current-system").strip()
    retained = machine.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json")
    machine.fail("/run/current-system/specialisation/changed-native/bin/switch-to-configuration test")
    assert machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == owner
    assert machine.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json") == retained
    machine.succeed(f"{original}/bin/switch-to-configuration test")
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    machine.succeed("${inspectCommand} result")
    machine.succeed("${inspectCommand} shutdown")
    machine.wait_until_succeeds("test \"$(systemctl show -p ActiveState --value manifold-owner.service)\" = inactive", timeout=30)
    machine.succeed("systemctl start manifold-owner.service")
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    replacement = machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
    assert int(replacement) > 1 and replacement != owner
    assert machine.succeed("${inspectCommand}").strip() == identity
    machine.succeed("${inspectCommand} result")
    machine.succeed("${inspectCommand} reopen")
    machine.succeed("${inspectCommand} execute module-native-recovered")
    machine.wait_until_succeeds("${inspectCommand} result module-native-recovered", timeout=180)

    # A separate node retains the default local-bootstrap proof above while
    # exercising the exact same packaged transport with a declared credential.
    credential.wait_for_unit("manifold-transport.service", timeout=180)
    credential.wait_until_succeeds("${inspectCommand}", timeout=180)
    credential_identity = credential.succeed("${inspectCommand}").strip()
    credential_owner = credential.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
    assert int(credential_owner) > 1
    source = "/etc/manifold-fixture/private/enrollment-token"
    source_identity = credential.succeed(f"stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {source}").strip()
    assert credential.succeed(f"stat -c '%a %U' {source}").strip() == "600 root"
    assert credential.succeed("stat -c '%a %U' /etc/manifold-fixture/private").strip() == "700 root"
    credential.succeed(f"runuser -u manifold -- test ! -r {source}")
    credential.succeed(f"cmp -s {source} /var/lib/manifold/agent.token")

    def check_private_credential():
        pid = credential.succeed("systemctl show -p MainPID --value manifold-transport.service").strip()
        assert int(pid) > 1
        private = "/run/credentials/manifold-transport.service/enrollment-token"
        credential.succeed(f"nsenter -t {pid} -m -- runuser -u manifold -- test -r {private}")
        credential.succeed(f"nsenter -t {pid} -m -- runuser -u manifold -- test ! -w {private}")
        credential.succeed(f"nsenter -t {pid} -m -- runuser -u manifold -- test ! -w /run/credentials/manifold-transport.service")
        credential.succeed(f"nsenter -t {pid} -m -- cmp -s {source} {private}")
        options = credential.succeed(f"nsenter -t {pid} -m -- findmnt -n -o OPTIONS --target {private}").strip().split(",")
        assert "ro" in options, options
        return pid

    transport = check_private_credential()
    credential.succeed("${inspectCommand} install")
    credential.succeed("${inspectCommand} execute")
    credential.wait_until_succeeds("${inspectCommand} result", timeout=180)
    credential.succeed("${inspectCommand} execute-hold module-credential-live")
    credential.wait_until_succeeds("${inspectCommand} started-hold module-credential-live", timeout=30)
    credential.succeed("systemctl restart manifold-transport.service")
    credential.wait_for_unit("manifold-transport.service", timeout=180)
    credential.wait_until_succeeds("${inspectCommand}", timeout=180)
    assert check_private_credential() != transport
    assert credential.succeed("${inspectCommand}").strip() == credential_identity
    assert credential.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == credential_owner
    assert credential.succeed(f"stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {source}").strip() == source_identity
    credential.succeed(f"cmp -s {source} /var/lib/manifold/agent.token")
    credential.succeed(f"runuser -u manifold -- test ! -r {source}")
    credential.succeed("${inspectCommand} result")
    credential.wait_until_succeeds("${inspectCommand} result-hold module-credential-live", timeout=180)
    credential.succeed("${inspectCommand} execute module-credential-restarted")
    credential.wait_until_succeeds("${inspectCommand} result module-credential-restarted", timeout=180)

    # Extra unit groups are not NSS membership. Custody must still refuse a
    # parent writable to the retained owner before PID 1 loads any bytes.
    credential.succeed("systemctl stop manifold-transport.service")
    credential.succeed("chgrp credential-writers /etc/manifold-fixture/private && chmod 0775 /etc/manifold-fixture/private")
    writer_gid = credential.succeed("getent group credential-writers").split(":")[2]
    owner_groups = credential.succeed(f"cat /proc/{credential_owner}/status")
    assert writer_gid in next(line.split()[1:] for line in owner_groups.splitlines() if line.startswith("Groups:"))
    credential.fail("systemctl start manifold-transport.service")
    credential.succeed("systemctl is-failed --quiet manifold-token-credential-source.service")
    assert credential.succeed("systemctl show -p MainPID --value manifold-transport.service").strip() == "0"
    assert credential.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == credential_owner
    credential.succeed(f"cmp -s {source} /var/lib/manifold/agent.token")
    credential.succeed("chmod 0700 /etc/manifold-fixture/private && chgrp root /etc/manifold-fixture/private")

    # Read-only delivery cannot make an exposed original token confidential.
    credential.succeed(f"chmod 0644 {source}")
    credential.fail("systemctl start manifold-transport.service")
    credential.succeed("systemctl is-failed --quiet manifold-token-credential-source.service")
    assert credential.succeed("systemctl show -p MainPID --value manifold-transport.service").strip() == "0"
    credential.succeed(f"chmod 0400 {source}")
    credential.succeed("systemctl reset-failed manifold-token-credential-source.service manifold-transport.service")
    credential.succeed("systemctl start manifold-transport.service")
    credential.wait_until_succeeds("${inspectCommand}", timeout=180)
    check_private_credential()
    assert credential.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == credential_owner
    credential.succeed(f"cmp -s {source} /var/lib/manifold/agent.token")
    credential.succeed("${inspectCommand} result module-credential-restarted")
  '';
}
