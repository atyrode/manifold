{ self, pkgs, role }:
assert builtins.elem role [ "shellonly" "coexist" "machine" "credential" "anchors" ];
let
  # Generate fixtures through the real packer: hand-built unstamped bundles must stay held.
  packFixture = pkgs.runCommand "manifold-native-profile-packer" {
    nativeBuildInputs = [ self.packages.${pkgs.stdenv.hostPlatform.system}.bun-runtime ];
  } ''
    cp -R ${self}/. source
    chmod -R u+w source
    cd source
    cp -R ${self.packages.${pkgs.stdenv.hostPlatform.system}.bun-deps}/. .
    mkdir -p "$out/bin"
    bun build --compile packages/plugin-kit/src/pack.ts --outfile "$out/bin/manifold-pack"
    cp ${shellClientSource} shell-client.ts
    bun build --compile shell-client.ts --outfile "$out/bin/manifold-shell-client"
  '';
  platform = "linux-${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}";
  closureMessage = pkgs.writeText "native-runtime-message" "native-module:closures\n";
  closureReader = pkgs.writeShellScriptBin "closure-reader" ''
    exec ${pkgs.gitMinimal}/bin/git hash-object --stdin < ${closureMessage}
  '';
  shellHome = "/home/account shell";
  shellState = "/srv/account shell/owner/state";
  shellToken = "/srv/account shell/credentials/private/token";
  shellSocket = "${shellState}/terminal-host/host.sock";
  shellOperatorAnchor = "/srv/shell-fixture/operator-anchor";
  shellProfile = pkgs.writeShellScriptBin "user-profile-only" ''
    printf 'user-profile:%s\n' "$USER"
  '';
  # Runtime-tool custody opens the declared file without following links. Preserve that
  # boundary even though the Nix package's public python3 entry is a versioned symlink.
  nativePython = pkgs.runCommand "manifold-shell-native-python" { } ''
    mkdir -p "$out/bin"
    cp --dereference ${pkgs.python3}/bin/python3 "$out/bin/python3"
  '';
  wrapperSource = pkgs.writeText "shell-authority-probe.c" ''
    #include <stdio.h>
    #include <unistd.h>
    int main(void) {
      FILE *file = fopen("/srv/shell-fixture/wrapper-private", "r");
      if (file == NULL || getuid() != 1400 || geteuid() != 0) return 71;
      char value[64];
      if (fgets(value, sizeof(value), file) == NULL) return 72;
      fclose(file);
      printf("wrapper:%s", value);
      return 0;
    }
  '';
  wrapperProbe = pkgs.runCommand "shell-authority-probe" {
    nativeBuildInputs = [ pkgs.stdenv.cc ];
  } ''
    mkdir -p "$out/bin"
    cc -O2 -Wall -Werror ${wrapperSource} -o "$out/bin/shell-authority-probe"
  '';
  # Compile against the same public SDK as the packaged hub. No private owner protocol,
  # fake PTY or source-text assertions substitute for the account's actual shell output.
  shellClientSource = pkgs.writeText "manifold-shell-client.ts" ''
    import { SessionClient } from "@manifold/sdk";
    import {
      ActionOutcomeSchema, ContainerResponseSchema, MachinesResponseSchema, TerminalsResponseSchema,
    } from "@manifold/protocol";
    import { z } from "zod";

    const hub = process.env.SHELL_FIXTURE_HUB ?? "http://127.0.0.1:7777";
    const key = (await Bun.file(process.env.SHELL_FIXTURE_KEY_FILE!).text()).trim();
    const mode = process.argv[2];
    const statePath = "/run/shell-fixture/session.json";
    const StateSchema = z.strictObject({
      machineId: z.string().min(1),
      terminalId: z.string().min(1),
      homeId: z.string().min(1),
      terminalHostId: z.string().min(1),
      shellPid: z.string().regex(/^\d+$/).optional(),
    });
    function require(condition: unknown, message: string): asserts condition {
      if (!condition) throw new Error(message);
    }
    async function action(name: string, args: unknown): Promise<unknown> {
      const response = await fetch(hub + "/api/actions/" + name, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const outcome = ActionOutcomeSchema.parse(await response.json());
      if (!outcome.ok) throw new Error(name + " refused: " + JSON.stringify(outcome.denial));
      return outcome.result;
    }
    async function waitFor(predicate: () => boolean | Promise<boolean>, message: string) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(50);
      }
      throw new Error(message);
    }
    async function connect(containerId: string) {
      const url = new URL("/ws/session", hub);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const client = new SessionClient({ url: url.toString(), containerId, token: key, reconnect: false });
      await client.connect();
      return client;
    }
    const machines = MachinesResponseSchema.parse(await action("core.machines.list", {})).machines;
    const machine = machines.find((entry) => entry.name === "account-shell");
    require(machine?.online && machine.terminalExecution === "unconfined", "ordinary account not admitted");
    if (mode === "ready") {
      console.log(JSON.stringify({ machineId: machine.id }));
    } else if (mode === "governed-ready") {
      const governed = machines.find((entry) => entry.terminalExecution === "governed");
      require(governed?.online, "native owner not admitted alongside ordinary account");
      console.log(JSON.stringify({ machineId: governed.id }));
    } else if (mode === "governed-refusal") {
      const governed = machines.find((entry) => entry.terminalExecution === "governed");
      require(governed?.online, "native owner not admitted alongside ordinary account");
      const container = ContainerResponseSchema.parse(await action("core.index.createContainer", {
        name: "governed runtime refusal", discipline: "composition",
      })).container;
      const client = await connect(container.id);
      try {
        let refused = false;
        try {
          await client.openTerminal({
            elementId: crypto.randomUUID(), machineId: governed.id, placement: "tile", cols: 80, rows: 24,
          });
        } catch (error) {
          refused = error instanceof Error && error.message.includes("requires a declared terminal runtime");
        }
        require(refused, "governed endpoint accepted ordinary runtime-free birth or refused for another reason");
        const terminals = TerminalsResponseSchema.parse(await action("core.terminals.listAll", {})).terminals;
        require(!terminals.some((entry) => entry.machineId === governed.id), "refused birth allocated a native terminal");
      } finally {
        client.close();
      }
    } else {
      let state: z.infer<typeof StateSchema>;
      if (mode === "create") {
        const container = ContainerResponseSchema.parse(await action("core.index.createContainer", {
          name: "ordinary account continuity", discipline: "composition",
        })).container;
        const opener = await connect(container.id);
        try {
          const terminal = await opener.openTerminal({
            elementId: crypto.randomUUID(), machineId: machine.id, placement: "tile", cols: 120, rows: 30,
          });
          const owner = await opener.drainMachine(machine.id, false);
          require(owner.ok, "ordinary owner status refused");
          require(owner.result.terminalIds.includes(terminal.id), "owner failed to retain new PTY");
          state = { machineId: machine.id, terminalId: terminal.id, homeId: terminal.containerId,
            terminalHostId: owner.result.terminalHostId };
        } finally {
          opener.close();
        }
      } else {
        state = StateSchema.parse(await Bun.file(statePath).json());
        require(state.machineId === machine.id, "transport rebound to another endpoint");
      }
      const client = await connect(state.homeId);
      try {
        const terminal = client.terminals.get(state.terminalId);
        require(terminal?.status === "running", "retained terminal is no longer running");
        // This client's one raw transcript sink owns exactly one view of the terminal; frames
        // of any other terminal or view are neither consumed nor acknowledged, and each
        // acknowledgement follows the sink's completed consumption of that frame.
        const viewportId = "shell-fixture-client";
        const view: { deliveryId?: string; geometry?: unknown } = {};
        let snapshot = false;
        let text = "";
        client.on("terminal_snapshot", (message) => {
          if (message.terminalId !== state.terminalId || message.viewportId !== viewportId) return;
          view.deliveryId = message.deliveryId;
          view.geometry = message.geometry;
          text = Buffer.from(message.data, "base64").toString();
          snapshot = true;
          client.ackTerminal(state.terminalId, viewportId, message.deliveryId, message.deliverySeq);
        });
        client.on("terminal_output", (message) => {
          if (message.terminalId !== state.terminalId || message.viewportId !== viewportId ||
            message.deliveryId !== view.deliveryId) return;
          text += Buffer.from(message.data, "base64").toString();
          client.ackTerminal(state.terminalId, viewportId, message.deliveryId, message.deliverySeq);
        });
        client.on("terminal_geometry", (message) => {
          if (message.terminalId !== state.terminalId || message.viewportId !== viewportId ||
            message.deliveryId !== view.deliveryId) return;
          view.geometry = message.geometry;
          client.ackTerminal(state.terminalId, viewportId, message.deliveryId, message.deliverySeq);
        });
        client.attachTerminal(state.terminalId, viewportId);
        await waitFor(() => snapshot, "retained PTY snapshot missing");
        client.takeTerminal(state.terminalId);
        await waitFor(() => client.terminals.get(state.terminalId)?.controllerId === client.self?.id,
          "terminal control not granted");
        await waitFor(() => text.includes("SHELL_FIXTURE_READY> "),
          "account shell did not finish its normal startup");
        if (mode === "exit") {
          client.sendTerminalInput(state.terminalId, "exit\n");
          await waitFor(() => !client.terminals.has(state.terminalId) ||
            client.terminals.get(state.terminalId)?.status === "exited", "PTY failed to exit");
        } else {
          const nonce = crypto.randomUUID();
          // The complete marker is not present in the echoed input: only executed output
          // can satisfy this match, including after owner/transport reconnection.
          const marker = "ACCOUNT_" + nonce + ":";
          client.sendTerminalInput(state.terminalId,
            "printf 'ACCOUNT_%s:%s:%s:%s:%s:%s:%s:%s:%s:%s\\n' " +
            "'" + nonce + "' \"$" + "$\" \"$(id -un)\" \"$HOME\" \"$SHELL\" \"$PWD\" " +
            "\"$(id -gn)\" \"$(cat /srv/shell-fixture/group/readable)\" " +
            "\"$(home-profile-only)\" \"$(user-profile-only)\"; " +
            "authority=\"$(shell-authority-probe)\"; authority_status=$?; " +
            "printf 'AUTHORITY_%s:%s\\n' '" + nonce + "' \"$authority\"; " +
            "printf 'AUTHORITY_STATUS_%s:%s\\n' '" + nonce + "' \"$authority_status\"; " +
            "printf '%s\\n' home-write > \"$HOME/shell-created\"\n");
          try {
            await waitFor(() => text.includes(marker) &&
              text.includes("AUTHORITY_" + nonce + ":wrapper:wrapper-authority"),
              "account authority or wrapper/profile command output missing");
          } catch (error) {
            // Report fixture observations, never raw PTY bytes or credential material.
            const statusMarker = "AUTHORITY_STATUS_" + nonce + ":";
            const statusOffset = text.indexOf(statusMarker);
            const status = statusOffset < 0 ? null :
              Number.parseInt(text.slice(statusOffset + statusMarker.length), 10);
            throw new Error(JSON.stringify({
              accountOutput: text.includes(marker),
              authorityOutput: text.includes("AUTHORITY_" + nonce + ":"),
              authorityStatus: Number.isFinite(status) ? status : null,
              commandsUnavailable: [...text.matchAll(/command not found: ([a-z][a-z0-9-]*)/g)]
                .map((match) => match[1]).slice(0, 4),
              wrongProfileWrapper: text.includes("wrong-profile-wrapper"),
              homeProfileUnavailable: text.includes("command not found: home-profile-only"),
              userProfileUnavailable: text.includes("command not found: user-profile-only"),
            }), { cause: error });
          }
          const line = text.slice(text.indexOf(marker) + marker.length).split(/\r?\n/)[0]!;
          const fields = line.split(":");
          require(/^\d+$/.test(fields[0]!), "shell did not report its own PID");
          require(fields.slice(1).join(":") ===
            "account-shell:${shellHome}:/run/current-system/sw/bin/zsh:${shellHome}:shell-primary:group-access:home-profile:account-shell:user-profile:account-shell",
            "account home, login shell, primary/supplementary groups or profile authority changed");
          if (state.shellPid !== undefined) require(state.shellPid === fields[0], "PTY process replaced across reconnect");
          state.shellPid = fields[0];
          const owner = await client.drainMachine(machine.id, false);
          require(owner.ok && owner.result.terminalHostId === state.terminalHostId &&
            owner.result.terminalIds.includes(state.terminalId), "owner identity changed across reconnect");
          await Bun.write(statePath, JSON.stringify(state));
          console.log(JSON.stringify({ machineId: state.machineId, terminalId: state.terminalId,
            terminalHostId: state.terminalHostId, shellPid: state.shellPid }));
        }
      } finally {
        client.close();
      }
    }
  '';
  inspect = pkgs.writeText "manifold-native-profile-inspect.py" ''
    import base64
    import hashlib
    import io
    import json
    import os
    import sys
    import subprocess
    import tarfile
    from pathlib import Path
    from tempfile import TemporaryDirectory
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
    tools = mode.endswith("-tools")
    mode = mode.removesuffix("-tools")
    named_output = mode.endswith("-outputs")
    mode = mode.removesuffix("-outputs")
    plugin_id = "fixture.native-profile-tools" if tools else "fixture.native-profile"
    operation_id = plugin_id + (".output" if named_output else ".hold" if mode.endswith("-hold") else ".run")
    mode = mode.removesuffix("-hold")
    job_id = sys.argv[2] if len(sys.argv) > 2 else "module-native-first"
    node = {"kind": "job", "machineId": machine["id"], "operationId": operation_id, "jobId": job_id}
    limits = {"timeoutMs": 120000, "memoryBytes": 134217728, "processes": 32, "outputBytes": 1024}
    output_location = plugin_id + ".outputs"
    output_limits = {**limits, "outputBytes": 2 * 1024 * 1024}

    def publish(plugin, declaration, executable, bundle_path):
        manifest = {
            "id": plugin, "version": "1.0.0", "title": "Native profile acceptance",
            "description": "Disposable module execution proof", "capabilities": [], "entry": {},
            "contributes": {"panels": [], "sections": [], "elements": [], "tools": [], "events": []},
            "machine": declaration,
        }
        with TemporaryDirectory(prefix="native-profile-pack-") as directory:
            source = Path(directory)
            (source / "manifest.json").write_text(json.dumps(manifest))
            (source / "worker").write_bytes(executable)
            packed = source / "bundle.json"
            subprocess.run(
                ["${packFixture}/bin/manifold-pack", directory, "--out", str(packed), "--self-contained"],
                check=True, stdout=subprocess.PIPE,
            )
            bundle = packed.read_bytes()
        with os.fdopen(os.open(bundle_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(bundle)
        os.chown(bundle_path, Path("/var/lib/manifold/owner.key").stat().st_uid, -1)
        action("engine.plugins.install", {
            "source": str(bundle_path), "sha256": hashlib.sha256(bundle).hexdigest(), "hardened": True,
        })

    # Operator anchors: one operation reads a root-made read-only view whole, another names an
    # anchor whose source is absent. The worker proves every write fails and links stay links.
    anchor_plugin = "fixture.native-anchors"
    anchor_read = anchor_plugin + ".read"
    anchor_absent = anchor_plugin + ".absent"
    anchor_sessions = anchor_plugin + ".sessions"
    anchor_missing = anchor_plugin + ".missing"
    anchor_node = {"kind": "job", "machineId": machine["id"], "operationId": anchor_read, "jobId": job_id}

    if mode == "anchors-install":
        executable = (
            b"#!/bin/busybox sh\n"
            b"cd /home/job/sessions || exit 80\n"
            b"refused() { out=$(\"$@\" 2>&1) && exit 81; case \"$out\" in *\"Read-only file system\"*) ;; *) printf '%s\\n' \"$out\" >&2; exit 82 ;; esac; }\n"
            b"refused /bin/busybox touch created\n"
            b"refused /bin/busybox mkdir created-directory\n"
            b"refused /bin/busybox chmod 0644 private.jsonl\n"
            b"refused /bin/busybox touch private.jsonl\n"
            b"refused /bin/busybox sh -c 'printf appended >> private.jsonl'\n"
            b"test \"$(/bin/busybox readlink link)\" = private.jsonl || exit 83\n"
            b"if /bin/busybox cat link > /dev/null 2>&1; then exit 84; fi\n"
            b"/bin/busybox sha256sum \"$1\" | /bin/busybox cut -d ' ' -f 1\n"
            b"exit 23\n"
        )
        artifact_hash = hashlib.sha256(executable).hexdigest()
        operation = {
            "argv": [], "input": {}, "runtimeTools": ["busybox"], "outputs": [],
            "network": "none", "limits": limits, "stdin": False,
        }
        declaration = {
            "artifacts": {"${platform}": {
                "bundleFile": "worker", "sha256": artifact_hash, "format": "raw",
                "entry": ["fixture"], "entrySha256": artifact_hash,
                "maxBytes": len(executable), "maxExpandedBytes": len(executable), "maxMembers": 1,
            }},
            "locations": {
                anchor_sessions: {
                    "anchor": "operator.fixture", "components": [], "revision": "r1",
                    "kind": "directory", "guestPath": "/home/job/sessions",
                },
                anchor_missing: {
                    "anchor": "operator.absent", "components": [], "revision": "r1",
                    "kind": "directory", "guestPath": "/home/job/absent",
                },
            },
            "operations": {
                anchor_read: {
                    **operation, "argv": [{"input": "file"}],
                    "input": {"file": {"type": "string", "required": True, "maxLength": 64}},
                    "locations": [{"locationId": anchor_sessions, "access": "read"}],
                },
                anchor_absent: {**operation, "locations": [{"locationId": anchor_missing, "access": "read"}]},
            },
        }
        publish(anchor_plugin, declaration, executable, Path("/var/lib/manifold/native-anchors-fixture.json"))
        # Only held views are advertised, with their host source, to root describe.
        resources = owner["resources"]
        assert resources["anchorDefinitions"] == {
            "operator.fixture": {"source": "/home/alice/sessions", "readOnly": True},
        }, resources
        assert [name for name in resources["anchors"] if name.startswith("operator.")] == ["operator.fixture"], resources
        review = action("engine.jobs.reviewDeployment", {
            "deploymentId": "native-anchors-review", "pluginId": anchor_plugin,
            "targets": [{"machineId": machine["id"], "platform": "${platform}"}],
            "operationIds": [anchor_read],
        })["targets"][0]
        assert review["approvable"] and review["reason"] is None, review
        row = next(row for row in review["resources"] if row["name"] == "operator.fixture")
        assert row == {
            "group": "anchors", "name": "operator.fixture",
            "sha256": resources["anchors"]["operator.fixture"], "source": "/home/alice/sessions",
        }, row
        installation = {
            "machineId": machine["id"], "pluginId": anchor_plugin,
            "installationRevision": "r1", "artifactSha256": artifact_hash,
        }
        action("engine.jobs.install", {**installation, "machine": declaration, "resourceBindings": {
            "tools": {"busybox": resources["tools"]["busybox"]}, "services": {},
            "anchors": {"operator.fixture": resources["anchors"]["operator.fixture"]},
        }})
        for operation_name in declaration["operations"]:
            for capability in ["jobs:read", "machines:run"]:
                action("engine.jobs.consent", {
                    **installation, "cap": capability, "enabled": True,
                    "node": "manifold://machine/" + machine["id"] + "/operation/" + operation_name,
                })
        for location in declaration["locations"]:
            action("engine.jobs.consent", {
                **installation, "cap": "locations:read", "enabled": True,
                "node": "manifold://machine/" + machine["id"] + "/location/" + location,
            })
    elif mode == "anchors-ready":
        operations = action("engine.jobs.describe", {"machineId": machine["id"], "pluginId": anchor_plugin})["operations"]
        assert operations[anchor_read]["ready"], operations[anchor_read]
        assert not operations[anchor_absent]["ready"], operations[anchor_absent]
        assert operations[anchor_absent]["reason"] == "anchors_unavailable", operations[anchor_absent]
    elif mode == "anchors-execute":
        job = action("engine.jobs.execute", {
            "jobId": job_id, "machineId": machine["id"], "pluginId": anchor_plugin,
            "operationId": anchor_read, "input": {"file": sys.argv[3]}, "outputs": [], "limits": limits,
        })
        assert job["state"] not in ["refused", "interrupted", "cancelled"], job
    elif mode == "anchors-result":
        job = action("engine.jobs.status", {"node": anchor_node})
        assert job["state"] == "exited", (job["state"], (job.get("result") or {}).get("reason"))
        assert job["result"]["exitCode"] == 23, job["result"]["exitCode"]
        stdout = next(output for output in job["result"]["outputs"] if output["name"] == "stdout")
        output = action("engine.jobs.output", {
            "node": {**anchor_node, "kind": "output", "outputId": stdout["outputId"]},
            "offset": 0, "maxBytes": 1024,
        })
        assert output["type"] == "output" and output["eof"], output
        digest = base64.b64decode(output["data"]).decode().strip()
        assert digest == hashlib.sha256(sys.argv[3].encode()).hexdigest(), (digest, sys.argv[3])
    elif mode == "install":
        executable = b"#!/bin/busybox sh\nif test -e /var/lib/manifold/owner.key || test -e /etc/manifold-fixture/private/enrollment-token || test -e /run/credentials/manifold-transport.service/enrollment-token; then exit 90; fi\nif test \"$1\" = output; then printf 'native-runtime:%s\\n' \"$2\" > \"/home/job/runtime-output/$2/value\" || exit 94; fi\nif test \"$1\" = hold; then /bin/busybox sleep 60; fi\nprintf 'native-module:bounded\\n'\nexit 23\n"
        if tools:
            executable = (
                b"#!/bin/sh\nset -eu\nset -o pipefail\n"
                b"if test -e /var/lib/manifold/owner.key || test -e /etc/manifold-fixture/private/enrollment-token || test -e /run/credentials/manifold-transport.service/enrollment-token; then exit 90; fi\n"
                b"if test -e ${pkgs.hello} || test -e ${pkgs.hello}/bin/hello; then exit 91; fi\n"
                b"test -x ${pkgs.bash}/bin/bash\n"
                b"test -x ${pkgs.gitMinimal}/bin/git\n"
                b"if /bin/sh -c 'printf denied > ${pkgs.gitMinimal}/manifold-write-probe' 2>/dev/null; then exit 92; fi\n"
                b"test ! -e ${pkgs.gitMinimal}/manifold-write-probe\n"
                b"digest=$(/usr/bin/closure-reader)\n"
                b"test \"$digest\" = \"$(printf '%s\\n' native-module:closures | /usr/bin/git hash-object --stdin)\"\n"
                b"printf '%s\\n' \"$digest\"\n"
                b"exit 23\n"
            )
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
                "input": {}, "runtimeTools": ["shell", "git"] if tools else ["busybox"], "locations": [],
                "outputs": [], "network": "none", "limits": limits, "stdin": False,
            } for operation in ([operation_id] if tools else [operation_id, plugin_id + ".hold"])},
        }
        if not tools:
            declaration["locations"][output_location] = {
                "anchor": "runtime", "components": ["native-profile", "outputs"], "revision": "r1",
                "guestPath": "/home/job/runtime-output",
            }
            declaration["operations"][plugin_id + ".output"] = {
                "argv": [{"literal": "output"}, {"input": "label"}],
                "input": {"label": {"type": "string", "required": True, "maxLength": 64}},
                "runtimeTools": ["busybox"],
                "locations": [{"locationId": output_location, "access": "write"}],
                "outputs": ["receipt"], "network": "none", "limits": output_limits, "stdin": False,
            }
        publish(plugin_id, declaration, executable, Path(
            "/var/lib/manifold/native-profile-tools-fixture.json" if tools else "/var/lib/manifold/native-profile-fixture.json"
        ))
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
        if not tools:
            action("engine.jobs.consent", {
                **installation, "cap": "locations:write", "enabled": True,
                "node": "manifold://machine/" + machine["id"] + "/location/" + output_location,
            })
    elif mode == "execute":
        job = action("engine.jobs.execute", {
            "jobId": job_id, "machineId": machine["id"], "pluginId": plugin_id,
            "operationId": operation_id, "input": {"label": job_id} if named_output else {},
            "outputs": [{"name": "receipt", "locationId": output_location, "components": [job_id]}] if named_output else [],
            "limits": output_limits if named_output else limits,
        })
        assert job["state"] not in ["refused", "interrupted", "cancelled"], job
    elif mode == "started":
        job = action("engine.jobs.status", {"node": node})
        assert job["state"] == "started", job
    elif mode == "result":
        job = action("engine.jobs.status", {"node": node})
        assert job["state"] == "exited", (job["state"], (job.get("result") or {}).get("reason"))
        assert job["result"]["exitCode"] == 23, job["result"]["exitCode"]
        stdout = next(output for output in job["result"]["outputs"] if output["name"] == "stdout")
        output = action("engine.jobs.output", {
            "node": {**node, "kind": "output", "outputId": stdout["outputId"]},
            "offset": 0, "maxBytes": 1024,
        })
        assert output["type"] == "output" and output["eof"], output
        expected = b"265121870c1fc35841a1affca90eb074a5f1ee53\n" if tools else b"native-module:bounded\n"
        assert base64.b64decode(output["data"]) == expected, output
        if named_output:
            receipt = next(item for item in job["result"]["outputs"] if item["name"] == "receipt")
            sealed = action("engine.jobs.output", {
                "node": {**node, "kind": "output", "outputId": receipt["outputId"]},
                "offset": 0, "maxBytes": 4096,
            })
            assert sealed["type"] == "output" and sealed["eof"], sealed
            with tarfile.open(fileobj=io.BytesIO(base64.b64decode(sealed["data"])), mode="r:") as archive:
                assert archive.getnames() == ["value"], archive.getnames()
                assert archive.extractfile("value").read() == ("native-runtime:" + job_id + "\n").encode()
            print(json.dumps({"jobId": job_id, "state": job["state"],
                              "origin": job["authority"]["origin"], "outputSha256": receipt["sha256"]}))
    elif mode == "drained":
        assert machine["draining"], "maintenance refusal must leave admission closed"
    else:
        assert mode == "inspect"
        print(machine["id"])
  '';
  inspectCommand = "${pkgs.python3}/bin/python3 ${inspect}";
  maintenanceCommand = "${self.packages.${pkgs.stdenv.hostPlatform.system}.manifold-agent}/bin/manifold-agent --maintenance";
  shellFixture = pkgs.writeText "manifold-shell-fixture.py" ''
    import base64
    import errno
    import hashlib
    import json
    import os
    import pwd
    import socket
    import subprocess
    import sys
    import time
    from pathlib import Path
    from tempfile import TemporaryDirectory
    from urllib.request import Request, urlopen

    hub = os.environ.get("SHELL_FIXTURE_HUB", "http://127.0.0.1:7777")
    key_file = Path(os.environ["SHELL_FIXTURE_KEY_FILE"])

    def action(name, args):
        request = Request(
            hub + "/api/actions/" + name, data=json.dumps(args).encode(),
            headers={"Authorization": "Bearer " + key_file.read_text().strip(), "Content-Type": "application/json"},
        )
        with urlopen(request, timeout=120) as response:
            outcome = json.load(response)
        assert outcome["ok"], outcome.get("denial")
        return outcome["result"]

    if sys.argv[1] == "enroll":
        deadline = time.monotonic() + 180
        while True:
            try:
                enrolled = action("core.machines.enroll", {"name": "account-shell"})
                break
            except (OSError, ValueError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)
        # This is the one-time traced action handoff on a disposable fixture. Never emit
        # the bearer, copy an incumbent token or retry enrollment by rotating credentials.
        token = enrolled.get("machineToken")
        assert isinstance(token, str) and token, "fresh fixture enrollment did not return a one-time credential"
        account = pwd.getpwnam("account-shell")
        parent = Path("${shellToken}").parent
        # The disposable root enrollment service has a private umask. Its public
        # credentials ancestor must remain traversable; only the account-owned leaf
        # carries token custody.
        parent.parent.mkdir(parents=True, exist_ok=True)
        os.chown(parent.parent, 0, 0)
        parent.parent.chmod(0o755)
        parent.mkdir(parents=True, exist_ok=True)
        os.chown(parent, account.pw_uid, account.pw_gid)
        parent.chmod(0o700)
        with os.fdopen(os.open("${shellToken}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            output.write(token + "\n")
        os.chown("${shellToken}", account.pw_uid, account.pw_gid)
    elif sys.argv[1] in ("owner-environment", "transport-environment"):
        # Inspect keys without ever displaying environment values or private credential
        # bytes, even when a broken implementation accidentally adds secret configuration.
        raw = Path("/proc/" + sys.argv[2] + "/environ").read_bytes()
        environment = dict(entry.split(b"=", 1) for entry in raw.split(b"\0") if b"=" in entry)
        keys = {key.decode() for key in environment if key.startswith(b"MANIFOLD_")}
        allowed = {"MANIFOLD_BUILD", "MANIFOLD_VERSION", "MANIFOLD_TERMINAL_HOST_SOCKET"}
        if sys.argv[1] == "transport-environment":
            allowed |= {"MANIFOLD_SERVER_URL", "MANIFOLD_MACHINE_NAME", "MANIFOLD_MACHINE_TOKEN_FILE"}
            assert environment.get(b"MANIFOLD_SERVER_URL") == hub.encode(), "transport lost its explicit origin"
            assert environment.get(b"MANIFOLD_MACHINE_NAME") == b"account-shell", "transport lost its explicit enrollment"
            assert environment.get(b"MANIFOLD_MACHINE_TOKEN_FILE") == b"${shellToken}", "transport lost file-based custody"
        assert keys <= allowed, sorted(keys - allowed)
        assert environment.get(b"MANIFOLD_TERMINAL_HOST_SOCKET") == b"${shellSocket}", "wrong account socket"
    elif sys.argv[1] == "host-custody":
        # NSS separation also denies access outside bubblewrap, not only by absent mounts.
        for operation in ("token", "socket"):
            try:
                if operation == "token":
                    with open("${shellToken}", "rb") as token:
                        token.read(1)
                else:
                    with socket.socket(socket.AF_UNIX) as connection:
                        connection.connect("${shellSocket}")
            except OSError as error:
                assert error.errno == errno.EACCES, (operation, error.errno)
            else:
                raise AssertionError(operation + " custody allowed the protected account")
    else:
        machines = action("core.machines.list", {})["machines"]
        native = [machine for machine in machines if machine.get("terminalExecution") == "governed"]
        assert len(native) == 1 and native[0]["online"], "coexistence must retain one native owner"
        machine_id = native[0]["id"]
        plugin_id = "fixture.shell-custody"
        operation_id = plugin_id + ".probe"
        job_id = "shell-custody-probe"
        node = {"kind": "job", "machineId": machine_id, "operationId": operation_id, "jobId": job_id}
        limits = {"timeoutMs": 120000, "memoryBytes": 134217728, "processes": 32, "outputBytes": 4096}
        if sys.argv[1] == "custody-start":
            # Both syscalls run in a real admitted governed workload, under its unchanged
            # owner/template. The account token and socket are not declared workload inputs.
            executable = (
                "#!/usr/bin/python3\n"
                "import errno, socket\n"
                "def denied(operation):\n"
                "    try:\n"
                "        if operation == 'token':\n"
                "            with open('${shellToken}', 'rb') as value: value.read(1)\n"
                "        else:\n"
                "            with socket.socket(socket.AF_UNIX) as connection: connection.connect('${shellSocket}')\n"
                "    except OSError as error:\n"
                "        assert error.errno in (errno.EACCES, errno.ENOENT), (operation, error.errno)\n"
                "        print(operation + ':denied', flush=True)\n"
                "    else: raise AssertionError(operation + ':allowed')\n"
                "denied('token')\n"
                "denied('socket')\n"
            ).encode()
            digest = hashlib.sha256(executable).hexdigest()
            declaration = {
                "artifacts": {"${platform}": {
                    "bundleFile": "worker", "sha256": digest, "format": "raw",
                    "entry": ["fixture"], "entrySha256": digest,
                    "maxBytes": len(executable), "maxExpandedBytes": len(executable), "maxMembers": 1,
                }},
                "locations": {},
                "operations": {operation_id: {
                    "argv": [], "input": {}, "runtimeTools": ["python"], "locations": [],
                    "outputs": [], "network": "none", "limits": limits, "stdin": False,
                }},
            }
            manifest = {
                "id": plugin_id, "version": "1.0.0", "title": "Account custody acceptance",
                "description": "Disposable governed shell-custody proof", "capabilities": [], "entry": {},
                "contributes": {"panels": [], "sections": [], "elements": [], "tools": [], "events": []},
                "machine": declaration,
            }
            with TemporaryDirectory(prefix="shell-custody-pack-") as directory:
                source = Path(directory)
                (source / "manifest.json").write_text(json.dumps(manifest))
                (source / "worker").write_bytes(executable)
                packed = source / "bundle.json"
                subprocess.run(["${packFixture}/bin/manifold-pack", directory, "--out", str(packed),
                                "--self-contained"], check=True, stdout=subprocess.PIPE)
                bundle = packed.read_bytes()
            bundle_path = Path("/var/lib/manifold/shell-custody-fixture.json")
            with os.fdopen(os.open(bundle_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                output.write(bundle)
            os.chown(bundle_path, key_file.stat().st_uid, -1)
            action("engine.plugins.install", {
                "source": str(bundle_path), "sha256": hashlib.sha256(bundle).hexdigest(), "hardened": True,
            })
            installation = {"machineId": machine_id, "pluginId": plugin_id,
                            "installationRevision": "r1", "artifactSha256": digest}
            action("engine.jobs.install", {**installation, "machine": declaration})
            for cap in ("jobs:read", "machines:run"):
                action("engine.jobs.consent", {
                    **installation, "cap": cap, "enabled": True,
                    "node": "manifold://machine/" + machine_id + "/operation/" + operation_id,
                })
            job = action("engine.jobs.execute", {
                "jobId": job_id, "machineId": machine_id, "pluginId": plugin_id,
                "operationId": operation_id, "input": {}, "outputs": [], "limits": limits,
            })
            assert job["state"] not in ("refused", "interrupted", "cancelled"), job["state"]
        else:
            assert sys.argv[1] == "custody-result"
            job = action("engine.jobs.status", {"node": node})
            assert job["state"] == "exited", (job["state"], (job.get("result") or {}).get("reason"))
            assert job["result"]["exitCode"] == 0, job["result"]["exitCode"]
            stdout = next(output for output in job["result"]["outputs"] if output["name"] == "stdout")
            result = action("engine.jobs.output", {
                "node": {**node, "kind": "output", "outputId": stdout["outputId"]}, "offset": 0, "maxBytes": 4096,
            })
            assert result["type"] == "output" and result["eof"], result["type"]
            assert base64.b64decode(result["data"]) == b"token:denied\nsocket:denied\n", "governed custody probe failed"
  '';
  shellFixtureCommand = "${pkgs.python3}/bin/python3 ${shellFixture}";
  shellClientCommand = "${packFixture}/bin/manifold-shell-client";
  # A bad operator anchor declaration must fail evaluation, so it can never be activated. The
  # test script names this derivation, so building the check evaluates every case below.
  anchorEvaluations = let
    inherit (pkgs) lib;
    evaluate = execution: (import (pkgs.path + "/nixos/lib/eval-config.nix") {
      inherit (pkgs.stdenv.hostPlatform) system;
      inherit pkgs;
      modules = [
        self.nixosModules.native
        {
          boot.loader.grub.enable = false;
          fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; };
          system.stateVersion = "26.05";
          services.manifold = {
            enable = true;
            execution = { enable = true; artifactOrigins = [ "https://artifacts.example.test" ]; } // execution;
          };
        }
      ];
    }).config;
    # Only failed assertions' messages are evaluated; other modules build theirs lazily.
    failed = execution: map (assertion: assertion.message)
      (lib.filter (assertion: !assertion.assertion && lib.hasInfix "operator anchor" assertion.message)
        (evaluate execution).assertions);
    refuses = message: execution: lib.assertMsg (failed execution == [ message ])
      "expected only '${message}' for ${builtins.toJSON execution}, got ${builtins.toJSON (failed execution)}";
    readOnly = "Manifold operator anchors are read-only; every execution.operatorAnchors.<name>.readOnly must be true.";
    names = "Declare at most 32 Manifold operator anchors, each named by 1-63 lowercase letters, digits or inner hyphens.";
    normalized = "Manifold operator anchor paths must be unique static normalized absolute paths other than /.";
    reserved = "A Manifold operator anchor cannot present Manifold's own storage, the anchor views, systemd credentials, kernel interfaces or the Nix store.";
    guarded = "A Manifold operator anchor may present a subtree beneath a protected directory, never one that is or contains a protected directory, the enrollment token or a service credential source.";
    token = "/etc/manifold-fixture/private/enrollment-token";
    beneathHome = { protectedDirectories = [ "/home" ]; operatorAnchors.fixture.path = "/home/alice/sessions"; };
  in
    assert lib.assertMsg (failed beneathHome == [ ]) "a subtree beneath protected /home must evaluate";
    assert lib.assertMsg (builtins.elem "manifold-operator-anchors.service"
      (evaluate beneathHome).systemd.services.manifold-owner.wants) "the owner must want its view helper";
    assert lib.assertMsg (!((evaluate { }).systemd.services ? manifold-operator-anchors))
      "a node without operator anchors must not gain a view helper";
    assert refuses readOnly { operatorAnchors.fixture = { path = "/home/alice/sessions"; readOnly = false; }; };
    assert refuses guarded { tokenCredentialFile = token; operatorAnchors.fixture.path = "/etc/manifold-fixture"; };
    assert refuses guarded { protectedDirectories = [ "/home" ]; operatorAnchors.fixture.path = "/home"; };
    assert refuses guarded { protectedDirectories = [ "/home/alice/sessions/private" ]; operatorAnchors.fixture.path = "/home/alice/sessions"; };
    assert refuses reserved { operatorAnchors.fixture.path = "/var/lib/manifold/job-owner"; };
    assert refuses reserved { operatorAnchors.fixture.path = "/nix/store"; };
    assert refuses normalized { operatorAnchors.fixture.path = "/"; };
    assert refuses normalized { operatorAnchors.fixture.path = "/home/alice/../bob"; };
    assert refuses normalized { operatorAnchors = { one.path = "/srv/sessions"; two.path = "/srv/sessions"; }; };
    assert refuses names { operatorAnchors."Sessions".path = "/srv/sessions"; };
    pkgs.writeText "manifold-operator-anchor-evaluations" "refused as declared\n";
  shellEvaluations = let
    inherit (pkgs) lib;
    evaluate = module: (import (pkgs.path + "/nixos/lib/eval-config.nix") {
      inherit (pkgs.stdenv.hostPlatform) system;
      inherit pkgs;
      modules = [
        self.nixosModules.native
        {
          boot.loader.grub.enable = false;
          fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; };
          system.stateVersion = "26.05";
          programs.zsh.enable = true;
          users.groups.shell-primary = {};
          users.groups.shell-access = {};
          users.users.account-shell = {
            isNormalUser = true;
            group = "shell-primary";
            extraGroups = [ "shell-access" ];
            home = shellHome;
            shell = pkgs.zsh;
          };
        }
        module
      ];
    }).config;
    shellOnly = {
      services.manifold = {
        enable = true;
        hub.enable = false;
        execution.enable = false;
        shell = {
          enable = true;
          machineName = "account-shell";
          user = "account-shell";
          serverUrl = "https://hub.example.test";
          tokenFile = shellToken;
          stateDirectory = shellState;
        };
      };
    };
    coexistence = lib.recursiveUpdate shellOnly {
      services.manifold.hub.enable = true;
      services.manifold.execution = {
        enable = true;
        artifactOrigins = [ "https://artifacts.example.test" ];
      };
    };
    configured = evaluate shellOnly;
    defaults = evaluate { services.manifold.enable = true; };
    # Force the actual NixOS toplevel, including generated units, tmpfiles and dependency
    # options. Merely selecting config.assertions misses shell-only evaluation regressions.
    fullyEvaluates = module: builtins.deepSeq (evaluate module).system.build.toplevel.drvPath true;
    refuses = patch:
      let module = lib.recursiveUpdate shellOnly patch;
      in lib.assertMsg (!(builtins.tryEval (fullyEvaluates module)).success)
        "invalid account-shell configuration fully evaluated: ${builtins.toJSON patch}";
    shellPatch = shell: { services.manifold.shell = shell; };
    protected = [
      "/var/lib/manifold" "/var/lib/manifold-workload" "/var/lib/manifold-output"
      "/run/credentials" "/proc" "/sys" "/dev" "/nix/store"
    ];
    malformed = [ "" "/" "relative/path" "/srv//shell" "/srv/./shell" "/srv/../shell"
      "/srv/shell/" "/srv/%n" "/srv/name:field" "/srv/name\\field" "/srv/name\nfield" ];
    anchorPatch = path: lib.recursiveUpdate coexistence {
      services.manifold.execution.operatorAnchors.fixture.path = path;
    };
  in
    assert fullyEvaluates { services.manifold.enable = true; };
    assert lib.assertMsg (defaults.services.manifold.shell == {
      enable = false; machineName = ""; user = ""; serverUrl = ""; tokenFile = null; stateDirectory = "";
    }) "ordinary shell role must remain opt-in with empty configuration";
    assert !(defaults.systemd.services ? manifold-shell-directories);
    assert !(defaults.systemd.services ? manifold-shell-owner);
    assert !(defaults.systemd.services ? manifold-shell-transport);
    assert fullyEvaluates shellOnly;
    assert fullyEvaluates coexistence;
    assert fullyEvaluates (lib.recursiveUpdate coexistence { services.manifold.execution.enable = false; });
    # NSS permits differently named UID aliases when explicitly configured. Their
    # effective service identity is refused at runtime below, including after NSS changes.
    assert fullyEvaluates (lib.recursiveUpdate coexistence {
      users.enforceIdUniqueness = false;
      users.users.account-shell.uid = 1400;
      users.users.manifold.uid = lib.mkForce 1400;
    });
    assert fullyEvaluates (lib.recursiveUpdate shellOnly {
      users.users.account-shell.shell = lib.mkForce "${pkgs.zsh}/bin/zsh";
    });
    assert fullyEvaluates (lib.recursiveUpdate shellOnly {
      services.manifold.shell.user = "root";
    });
    assert !(configured.users.users ? manifold);
    assert !(configured.users.groups ? manifold);
    assert lib.all (name: !(builtins.hasAttr name configured.systemd.services)) [
      "manifold-server" "manifold-owner" "manifold-transport" "manifold-operator-anchors"
      "manifold-token-credential-source"
    ];
    assert lib.all (rule: !lib.any (path: lib.hasInfix path rule)
      [ "/var/lib/manifold" "/var/lib/manifold-workload" "/var/lib/manifold-output" ])
      configured.systemd.tmpfiles.rules;
    assert lib.all (rule: !lib.hasInfix shellState rule) configured.systemd.tmpfiles.rules;
    assert configured.systemd.services.manifold-shell-directories.serviceConfig.User == "root";
    assert configured.systemd.services.manifold-shell-directories.serviceConfig.Group == "root";
    assert configured.systemd.services.manifold-shell-owner.restartIfChanged == false;
    assert configured.systemd.services.manifold-shell-owner.stopIfChanged == false;
    assert lib.all (name: configured.systemd.services.${name}.serviceConfig.User == "account-shell"
      && configured.systemd.services.${name}.serviceConfig.Group == "shell-primary")
      [ "manifold-shell-owner" "manifold-shell-transport" ];
    assert refuses (shellPatch { user = ""; });
    assert refuses (shellPatch { user = "missing-account"; });
    assert refuses { users.users.account-shell.enable = false; };
    assert refuses (shellPatch { user = "manifold"; });
    assert refuses (shellPatch { machineName = ""; });
    assert refuses (shellPatch { serverUrl = ""; });
    assert refuses (shellPatch { tokenFile = null; });
    assert refuses (shellPatch { tokenFile = pkgs.writeText "invalid-shell-store-token" "public-fixture"; });
    assert refuses { services.manifold.shell.enable = false; };
    assert refuses (lib.recursiveUpdate coexistence (shellPatch { user = "manifold"; }));
    assert refuses (lib.recursiveUpdate coexistence (shellPatch { serverUrl = ""; }));
    assert refuses (lib.recursiveUpdate coexistence { services.manifold.shell.machineName = "local"; });
    assert lib.all (path: refuses (shellPatch { stateDirectory = path; })
      && refuses (shellPatch { tokenFile = path; })) malformed;
    assert lib.all (path: refuses (shellPatch { stateDirectory = path + "/private shell"; })
      && refuses (shellPatch { tokenFile = path + "/private shell/token"; })) protected;
    # Both ancestor directions, including state/socket custody and token custody. Space
    # bearing valid sibling paths above must evaluate and also boot in the VM below.
    assert refuses (shellPatch { stateDirectory = "/var/lib"; });
    assert refuses (shellPatch { tokenFile = "/var/lib"; });
    assert refuses (anchorPatch "/srv/account shell");
    assert refuses (anchorPatch (shellState + "/view"));
    assert refuses (anchorPatch (shellState + "/terminal-host"));
    assert refuses (anchorPatch (shellToken + "/view"));
    assert refuses (lib.recursiveUpdate coexistence (shellPatch { stateDirectory = "/run/manifold-anchors"; }));
    assert refuses (lib.recursiveUpdate coexistence (shellPatch { tokenFile = "/run/manifold-anchors/fixture/token"; }));
    assert refuses (lib.recursiveUpdate coexistence (shellPatch { stateDirectory = "/run"; }));
    assert refuses (lib.recursiveUpdate coexistence {
      services.manifold.execution.tokenCredentialFile = "/srv/native credentials/token";
      services.manifold.shell.stateDirectory = "/srv/native credentials/shell";
    });
    assert refuses (lib.recursiveUpdate coexistence {
      services.manifold.execution.serviceCredentials.fixture = {
        source = "/srv/service credentials/token"; origins = [ "https://service.example.test" ];
      };
      services.manifold.shell.tokenFile = "/srv/service credentials/shell/token";
    });
    pkgs.writeText "manifold-account-shell-evaluations" "full toplevel evaluated; invalid custody refused\n";
in
{
  name = "manifold-native-profile-${role}";
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
    virtualisation.useNixStoreImage = true;
    # System switches re-register store paths; the immutable image needs a VM-local overlay.
    virtualisation.writableStore = true;
    virtualisation.additionalPaths = [ inspect pkgs.python3 ];
    system.stateVersion = "26.05";
  };
  shellAccount = { ... }: {
    services.manifold = {
      enable = true;
      shell = {
        enable = true;
        machineName = "account-shell";
        user = "account-shell";
        serverUrl = "http://127.0.0.1:7777";
        tokenFile = shellToken;
        stateDirectory = shellState;
      };
    };
    programs.zsh.enable = true;
    programs.zsh.promptInit = "PROMPT='SHELL_FIXTURE_READY> '";
    users.groups.shell-primary.gid = 1400;
    users.groups.shell-access = {};
    users.users.account-shell = {
      isNormalUser = true;
      uid = 1400;
      group = "shell-primary";
      extraGroups = [ "shell-access" ];
      home = shellHome;
      homeMode = "700";
      shell = pkgs.zsh;
      packages = [ shellProfile ];
    };
    security.wrappers.shell-authority-probe = {
      source = "${wrapperProbe}/bin/shell-authority-probe";
      owner = "root";
      group = "root";
      setuid = true;
    };
    systemd.services.shell-fixture-files = {
      wantedBy = [ "multi-user.target" ];
      before = [ "manifold-shell-directories.service" "manifold-shell-owner.service" ];
      requiredBy = [ "manifold-shell-directories.service" "manifold-shell-owner.service" ];
      after = [ "systemd-tmpfiles-setup.service" ];
      script = ''
        set -eu
        install -d -o root -g root -m 0755 /srv/shell-fixture
        # A root-owned but lexical-safe parent makes the later alias probe exercise the
        # privileged provisioner, not an ordinary account's own mkdir.
        install -d -o root -g root -m 0755 '/srv/account shell/owner'
        install -d -o account-shell -g shell-primary -m 0700 '${shellOperatorAnchor}'
        install -d -o root -g shell-access -m 0750 /srv/shell-fixture/group
        printf group-access > /srv/shell-fixture/group/readable
        chown root:shell-access /srv/shell-fixture/group/readable
        chmod 0640 /srv/shell-fixture/group/readable
        printf 'wrapper-authority\n' > /srv/shell-fixture/wrapper-private
        chmod 0600 /srv/shell-fixture/wrapper-private
        # This is an existing configured account, not zsh's first-user setup dialogue.
        printf 'export SHELL_FIXTURE_LOGIN=ready\n' > '${shellHome}/.zshrc'
        chown account-shell:shell-primary '${shellHome}/.zshrc'
        chmod 0600 '${shellHome}/.zshrc'
        install -d -o account-shell -g shell-primary -m 0700 '${shellHome}/.nix-profile' '${shellHome}/.nix-profile/bin'
        printf '#!${pkgs.runtimeShell}\nprintf "home-profile:account-shell\\n"\n' > '${shellHome}/.nix-profile/bin/home-profile-only'
        printf '#!${pkgs.runtimeShell}\nprintf "wrong-profile-wrapper\\n"\n' > '${shellHome}/.nix-profile/bin/shell-authority-probe'
        chown account-shell:shell-primary '${shellHome}/.nix-profile/bin/'*
        chmod 0700 '${shellHome}/.nix-profile/bin/'*
        install -d -o root -g root -m 0700 /run/shell-fixture
      '';
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
    };
    systemd.services.shell-fixture-enrollment = {
      wantedBy = [ "multi-user.target" ];
      before = [ "manifold-shell-transport.service" ];
      requiredBy = [ "manifold-shell-transport.service" ];
      after = [ "shell-fixture-files.service" ];
      environment.SHELL_FIXTURE_HUB = "http://127.0.0.1:7777";
      script = "${shellFixtureCommand} enroll";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        UMask = "0077";
      };
    };
    virtualisation.additionalPaths = [ shellFixture packFixture pkgs.python3 ];
    system.stateVersion = "26.05";
  };
  in pkgs.lib.getAttrs [ role ] {
    machine = common;
    credential = { pkgs, ... }: {
      imports = [ common ];
      services.manifold.execution = {
        tokenCredentialFile = "/etc/manifold-fixture/private/enrollment-token";
        protectedDirectories = [ "/etc/manifold-fixture" ];
        runtimeTools.shell = [
          { source = "${pkgs.bash}/bin/bash"; target = "/bin/sh"; kind = "file"; }
        ];
        runtimeTools.git = [
          { source = "${pkgs.gitMinimal}/bin/git"; target = "/usr/bin/git"; kind = "file"; }
          { source = "${closureReader}/bin/closure-reader"; target = "/usr/bin/closure-reader"; kind = "file"; }
        ];
        runtimeToolClosures.shell = [ pkgs.bash ];
        runtimeToolClosures.git = [ pkgs.gitMinimal closureReader ];
      };
      environment.systemPackages = [ pkgs.hello ];
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
    # An operator's 0700 home beneath protected /home: one anchor over a synthetic session
    # tree, one over an absent source and one through a symbolic link component.
    anchors = { pkgs, ... }: {
      imports = [ common ];
      services.manifold.execution = {
        protectedDirectories = [ "/home" ];
        operatorAnchors = {
          fixture.path = "/home/alice/sessions";
          absent.path = "/home/alice/absent";
          linked.path = "/home/alice/linked/sessions";
        };
      };
      users.users.alice = { isNormalUser = true; homeMode = "700"; };
      environment.systemPackages = [ pkgs.acl ];
      # The synthetic tree exists before root presents its view at boot.
      systemd.services.manifold-fixture-sessions = {
        wantedBy = [ "multi-user.target" ];
        requiredBy = [ "manifold-operator-anchors.service" ];
        before = [ "manifold-operator-anchors.service" ];
        script = ''
          set -eu
          cd /home/alice
          test "$(stat -c '%U %a' .)" = "alice 700"
          install -d -o alice -g users -m 0700 sessions sessions/private-directory real real/sessions
          printf public-session > sessions/public.jsonl
          printf private-session > sessions/private.jsonl
          printf inner-session > sessions/private-directory/inner.jsonl
          chown alice:users sessions/public.jsonl sessions/private.jsonl sessions/private-directory/inner.jsonl
          chmod 0644 sessions/public.jsonl
          chmod 0600 sessions/private.jsonl sessions/private-directory/inner.jsonl
          ln -s private.jsonl sessions/link
          ln -s /home/alice/real linked
          chown -h alice:users sessions/link linked
        '';
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
      };
    };
    shellonly = { ... }: {
      imports = [ self.nixosModules.native shellAccount ];
      services.manifold.hub.enable = false;
      services.manifold.execution.enable = false;
      users.groups.shell-fixture-hub = {};
      users.users.shell-fixture-hub = {
        isSystemUser = true;
        group = "shell-fixture-hub";
        home = "/srv/shell-fixture-hub";
        createHome = true;
        homeMode = "700";
      };
      # A separate disposable fixture hub proves the selected module roles are truly
      # shell-only. This is not services.manifold.hub and provisions no native account,
      # owner, template, workload mount or execution bootstrap.
      systemd.services.shell-fixture-hub = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          MANIFOLD_DATA_DIR = "/srv/shell-fixture-hub";
          MANIFOLD_BIND = "127.0.0.1";
          MANIFOLD_PORT = "7777";
          MANIFOLD_PUBLIC_URL = "http://127.0.0.1:7777";
          MANIFOLD_SPAWN_AGENT = "0";
        };
        serviceConfig = {
          User = "shell-fixture-hub";
          Group = "shell-fixture-hub";
          ExecStart = "${self.packages.${pkgs.stdenv.hostPlatform.system}.manifold-server}/bin/manifold-server";
          UMask = "0077";
          Restart = "on-failure";
        };
      };
      systemd.services.shell-fixture-enrollment = {
        after = [ "shell-fixture-hub.service" ];
        environment.SHELL_FIXTURE_KEY_FILE = "/srv/shell-fixture-hub/owner.key";
      };
      virtualisation.cores = 2;
      virtualisation.memorySize = 2048;
      virtualisation.useNixStoreImage = true;
      # Registering the guest's store paths and account profile needs a VM-local overlay,
      # just as in the governed guests; the backing store image remains immutable.
      virtualisation.writableStore = true;
    };
    coexist = { ... }: {
      imports = [ common shellAccount ];
      services.manifold.execution = {
        operatorAnchors.shell-fixture.path = shellOperatorAnchor;
        runtimeTools.python = [{
          source = "${nativePython}/bin/python3";
          target = "/usr/bin/python3";
          kind = "file";
        }];
        runtimeToolClosures.python = [ pkgs.python3 ];
      };
      systemd.services.shell-fixture-files = {
        before = [ "manifold-operator-anchors.service" ];
        requiredBy = [ "manifold-operator-anchors.service" ];
      };
      systemd.services.shell-fixture-enrollment = {
        after = [ "manifold-server.service" "manifold-transport.service" ];
        environment.SHELL_FIXTURE_KEY_FILE = "/var/lib/manifold/owner.key";
      };
    };
  };
  testScript = ''
    import json
    import shlex

    def maintenance(node, command, expected_code=0, **flags):
        words = [command]
        for flag, value in flags.items():
            words.extend(["--" + flag.replace("_", "-"), value])
        code, output = node.execute("${maintenanceCommand} " + shlex.join(words) + " 2>&1")
        assert code == expected_code, output
        assert len(output.strip().splitlines()) == 1, output
        result = json.loads(output)
        assert result["ok"] == (expected_code == 0) and result["command"] == command, result
        return result

    # Operator anchor evaluation refusals: ${anchorEvaluations}
    # Complete account-shell toplevel evaluation and custody refusals: ${shellEvaluations}
  '' + pkgs.lib.optionalString (builtins.elem role [ "shellonly" "coexist" ]) ''
    # Each independently bounded derivation retains its complete scenario and shutdown.

    # The ordinary role is exercised independently and beside the unchanged governed
    # role. All secret values remain in private guest files and HTTP bearer headers.
    profile_role = "${role}"
    for node, hub_unit, key_file in [
        (
            ${role},
            "${if role == "shellonly" then "shell-fixture-hub.service" else "manifold-server.service"}",
            "${if role == "shellonly" then "/srv/shell-fixture-hub/owner.key" else "/var/lib/manifold/owner.key"}",
        ),
    ]:
        node.start()
        node.connect()
        node.wait_for_unit(hub_unit, timeout=180)
        node.wait_for_unit("manifold-shell-directories.service", timeout=180)
        assert node.succeed("systemctl show -p ActiveState --value manifold-shell-directories.service").strip() == "active"
        node.wait_for_unit("manifold-shell-owner.service", timeout=180)
        node.wait_for_unit("manifold-shell-transport.service", timeout=180)
        fixture_env = "env SHELL_FIXTURE_KEY_FILE=" + shlex.quote(key_file) + " "
        client_command = fixture_env + "${shellClientCommand}"
        fixture_command = fixture_env + "${shellFixtureCommand} "
        node.wait_until_succeeds(client_command + " ready", timeout=180)
        shell_owner = node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip()
        assert int(shell_owner) > 1
        node.succeed(fixture_command + "owner-environment " + shell_owner)
        transport_pid = node.succeed("systemctl show -p MainPID --value manifold-shell-transport.service").strip()
        node.succeed(fixture_command + "transport-environment " + transport_pid)
        owner_restarts = node.succeed("systemctl show -p NRestarts --value manifold-shell-owner.service").strip()
        assert node.succeed("systemctl show -p RefuseManualStop --value manifold-shell-owner.service").strip() == "yes"
        assert node.succeed("systemctl show -p OOMPolicy --value manifold-shell-owner.service").strip() == "continue"
        for field in ["PartOf", "BindsTo", "Requires"]:
            dependencies = node.succeed(f"systemctl show -p {field} --value manifold-shell-owner.service").split()
            assert not any(name in dependencies for name in [
                "manifold-shell-transport.service", hub_unit, "manifold-owner.service",
            ]), (field, dependencies)
        assert "manifold-shell-directories.service" in node.succeed(
            "systemctl show -p Requires --value manifold-shell-owner.service"
        ).split()
        token = shlex.quote("${shellToken}")
        token_parent = shlex.quote("${builtins.dirOf shellToken}")
        state = shlex.quote("${shellState}")
        socket_path = shlex.quote("${shellSocket}")
        for path in [state, shlex.quote("${shellState}/terminal-host"), token_parent]:
            assert node.succeed(f"stat -c '%a %U %G' {path}").strip() == "700 account-shell shell-primary"
        for path in [token, socket_path]:
            assert node.succeed(f"stat -c '%a %U %G' {path}").strip() == "600 account-shell shell-primary"
        node.succeed(f"test ! -L {token} && test -f {token} && test -S {socket_path}")
        if profile_role == "shellonly":
            node.fail("getent passwd manifold")
            node.fail("getent group manifold")
            for unit in ["manifold-server", "manifold-owner", "manifold-transport", "manifold-operator-anchors"]:
                node.fail("systemctl cat " + unit + ".service")
            node.succeed("test ! -e /var/lib/manifold && test ! -e /var/lib/manifold-workload && test ! -e /var/lib/manifold-output")
        else:
            node.wait_for_unit("manifold-owner.service", timeout=180)
            node.wait_for_unit("manifold-transport.service", timeout=180)
            native_owner = node.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
            native_configuration = node.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json")
            # The other account retains no token traversal or Unix connect permission,
            # even outside the workload namespace. Do not lend it extra NSS membership.
            node.succeed("runuser -u manifold -- " + fixture_command + "host-custody")
            # A Type=simple unit is active before its retained owner and transport admit.
            # Wait on read-only inventory, then perform the refusal assertion exactly once.
            node.wait_until_succeeds(client_command + " governed-ready", timeout=180)
            node.succeed(client_command + " governed-refusal")
            node.succeed(fixture_command + "custody-start")
            node.wait_until_succeeds(fixture_command + "custody-result", timeout=180)

        # Actual SDK attach/input/output observes login shell, account identity, HOME,
        # primary and supplementary groups, writable home and profile/wrapper authority.
        initial = json.loads(node.succeed(client_command + " create"))
        node.wait_until_succeeds("test \"$(cat " + shlex.quote("${shellHome}/shell-created") + ")\" = home-write", timeout=30)
        assert node.succeed("stat -c '%a %U %G' " + shlex.quote("${shellHome}/shell-created")).strip() == "600 account-shell shell-primary"
        node.fail("systemctl stop manifold-shell-owner.service")
        assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == shell_owner
        for service in ["manifold-shell-transport.service", hub_unit]:
            node.succeed("systemctl restart " + service)
            node.wait_for_unit(service, timeout=180)
            node.wait_until_succeeds(client_command + " ready", timeout=180)
            after = json.loads(node.succeed(client_command + " io"))
            assert after == initial, "endpoint, owner, terminal or shell process changed across reconnect"
            assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == shell_owner

        # Every start rechecks exact custody without repairing the declaring tool's
        # token or its parent. The occupied owner remains alive and never restarts.
        for alter, restore in [
            (f"chmod 0644 {token}", f"chmod 0600 {token}"),
            (f"chmod 0400 {token}", f"chmod 0600 {token}"),
            (f"chown root:shell-primary {token}", f"chown account-shell:shell-primary {token}"),
            (f"chmod 0750 {token_parent}", f"chmod 0700 {token_parent}"),
            (f"chown root:shell-primary {token_parent}", f"chown account-shell:shell-primary {token_parent}"),
            (f"mv {token} {token}.held && ln -s token.held {token}", f"rm {token} && mv {token}.held {token}"),
            (f"mv {token} {token}.held && mkdir {token}", f"rmdir {token} && mv {token}.held {token}"),
            (f"mv {token} {token}.held", f"mv {token}.held {token}"),
        ]:
            node.succeed("systemctl stop manifold-shell-transport.service")
            node.succeed(alter)
            metadata_command = f"stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {token_parent}"
            if "mv " not in alter or "ln -s " in alter or "mkdir " in alter:
                metadata_command += f" && stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {token}"
            invalid_metadata = node.succeed(metadata_command)
            node.fail("systemctl start manifold-shell-transport.service")
            assert node.succeed("systemctl show -p MainPID --value manifold-shell-transport.service").strip() == "0"
            node.succeed("systemctl stop manifold-shell-transport.service")
            assert node.succeed(metadata_command) == invalid_metadata, "transport repaired invalid credential custody"
            assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == shell_owner
            assert node.succeed("systemctl show -p NRestarts --value manifold-shell-owner.service").strip() == owner_restarts
            node.succeed(restore)
            node.succeed("systemctl reset-failed manifold-shell-transport.service")
            node.succeed("systemctl start manifold-shell-transport.service")
            node.wait_until_succeeds(client_command + " ready", timeout=180)
            assert json.loads(node.succeed(client_command + " io")) == initial

        # A real private basename and parent do not make an aliased ancestor safe.
        # Beside native execution the target is already a held, idmapped operator view.
        credential_root = shlex.quote("/srv/account shell/credentials")
        exposed_credentials = shlex.quote("${shellOperatorAnchor}/credentials")
        node.succeed("systemctl stop manifold-shell-transport.service")
        node.succeed(f"mv {credential_root} {exposed_credentials} && ln -s {exposed_credentials} {credential_root}")
        node.succeed(f"test -L {credential_root} && test ! -L {token_parent} && test ! -L {token} && test -f {token}")
        assert node.succeed(f"stat -c '%a %U %G' {token_parent}").strip() == "700 account-shell shell-primary"
        assert node.succeed(f"stat -c '%a %U %G' {token}").strip() == "600 account-shell shell-primary"
        if profile_role == "coexist":
            node.succeed("runuser -u manifold -- test -r /run/manifold-anchors/shell-fixture/credentials/private/token")
        metadata_command = f"stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {credential_root} {token_parent} {token}"
        aliased_metadata = node.succeed(metadata_command)
        node.fail("systemctl start manifold-shell-transport.service")
        assert node.succeed("systemctl show -p MainPID --value manifold-shell-transport.service").strip() == "0"
        node.succeed("systemctl stop manifold-shell-transport.service")
        assert node.succeed(metadata_command) == aliased_metadata, "transport repaired aliased credential custody"
        assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == shell_owner
        assert node.succeed("systemctl show -p NRestarts --value manifold-shell-owner.service").strip() == owner_restarts
        node.succeed(f"rm {credential_root} && mv {exposed_credentials} {credential_root}")
        node.succeed("systemctl reset-failed manifold-shell-transport.service")
        node.succeed("systemctl start manifold-shell-transport.service")
        node.wait_until_succeeds(client_command + " ready", timeout=180)
        assert json.loads(node.succeed(client_command + " io")) == initial

        admission = dict(hub="http://127.0.0.1:7777", machine_id=initial["machineId"], owner_key_file=key_file)
        shutdown = dict(socket="${shellSocket}", terminal_host_id=initial["terminalHostId"])
        drained = maintenance(node, "drain", **admission)
        assert drained["draining"] and drained["terminalHostId"] == initial["terminalHostId"], drained
        assert drained["terminalIds"] == [initial["terminalId"]], drained
        held = maintenance(node, "shutdown", expected_code=1, **shutdown)
        assert held["hold"] and held["reason"] == "terminals_retained", held
        assert held["terminalIds"] == [initial["terminalId"]], held
        assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == shell_owner
        # Exit via ordinary PTY input, not a supervisor signal or fallback kill.
        node.succeed(client_command + " exit")
        empty = maintenance(node, "drain", **admission)
        assert empty["terminalIds"] == [] and empty["terminalHostId"] == initial["terminalHostId"], empty
        stopped = maintenance(node, "shutdown", **shutdown)
        assert stopped["terminalHostId"] == initial["terminalHostId"], stopped
        node.wait_until_succeeds("test \"$(systemctl show -p ActiveState --value manifold-shell-owner.service)\" = inactive", timeout=30)
        node.succeed("sleep 5")
        assert node.succeed("systemctl show -p MainPID --value manifold-shell-owner.service").strip() == "0"
        assert node.succeed("systemctl show -p NRestarts --value manifold-shell-owner.service").strip() == owner_restarts

        # Stop the replaceable transport before testing either post-shutdown custody path.
        node.succeed("systemctl stop manifold-shell-transport.service")
        if profile_role == "coexist":
            # Do not rewrite account-shell's UID to the live native UID: shadow refuses to
            # restore that record while the protected owner correctly remains running. Route a
            # disposable NSS alias through the actual inactive units instead, so their
            # effective-UID preflight is what rejects the overlap.
            alias_user = "account-shell-alias"
            node.succeed(
                "useradd --no-create-home --non-unique --uid \"$(id -u manifold)\" "
                "--gid shell-primary " + alias_user
            )
            alias_dropins = []
            for unit in ["manifold-shell-owner.service", "manifold-shell-transport.service"]:
                directory = "/run/systemd/system/" + unit + ".d"
                path = directory + "/identity-alias.conf"
                node.succeed("mkdir -p " + shlex.quote(directory))
                node.succeed(
                    "printf '[Service]\\nUser=" + alias_user + "\\nWorkingDirectory=/\\n' > "
                    + shlex.quote(path)
                )
                alias_dropins.append((directory, path))
            node.succeed("systemctl daemon-reload")
            for unit in ["manifold-shell-owner.service", "manifold-shell-transport.service"]:
                node.succeed("systemctl reset-failed " + unit)
                node.fail("systemctl start " + unit)
                service_log = node.succeed("journalctl -b -u " + unit + " --no-pager")
                assert "Manifold shell account shares the protected manifold UID; refusing startup" in service_log
                assert node.succeed("systemctl show -p MainPID --value " + unit).strip() == "0"
                if unit == "manifold-shell-transport.service":
                    node.succeed("systemctl stop " + unit)
            for directory, path in alias_dropins:
                node.succeed("rm " + shlex.quote(path))
                node.succeed("rmdir " + shlex.quote(directory))
            node.succeed("systemctl daemon-reload")
            assert node.succeed("id -u account-shell").strip() == "1400"
            assert node.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == native_owner

        # Only after exact-owner shutdown may this fixture alter its private state.
        # Keep the alias in place until guest teardown, so automatic retries cannot
        # accidentally start a new owner between the refusal and shutdown assertions.
        owner_root = shlex.quote("/srv/account shell/owner")
        exposed_owner = shlex.quote("${shellOperatorAnchor}/owner")
        socket_parent = shlex.quote("${shellState}/terminal-host")
        assert node.succeed(f"stat -c '%a %U %G' {owner_root}").strip() == "755 root root"
        node.succeed(f"mv {owner_root} {exposed_owner} && ln -s {exposed_owner} {owner_root}")
        node.succeed(f"test -L {owner_root} && test ! -L {state} && test ! -L {socket_parent} && test ! -e {socket_path}")
        for path in [state, socket_parent]:
            assert node.succeed(f"stat -c '%a %U %G' {path}").strip() == "700 account-shell shell-primary"
        if profile_role == "coexist":
            node.succeed("runuser -u manifold -- test -x /run/manifold-anchors/shell-fixture/owner/state/terminal-host")

        # A root-owned alias points at a foreign state whose private leaves need repair.
        # The old tmpfiles rules would follow this alias and chown/chmod those leaves.
        node.succeed(f"chown root:root {state} {socket_parent} && chmod 0755 {state} {socket_parent}")
        for path in [state, socket_parent]:
            assert node.succeed(f"stat -c '%a %U %G' {path}").strip() == "755 root root"
        metadata_command = f"stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' {owner_root} {state} {socket_parent}"
        aliased_metadata = node.succeed(metadata_command)
        node.succeed("systemctl reset-failed manifold-shell-directories.service")
        node.fail("systemctl restart manifold-shell-directories.service")
        directory_log = node.succeed("journalctl -b -u manifold-shell-directories.service --no-pager")
        assert "Manifold shell directory provisioning refused: unsafe state ancestor owner" in directory_log
        assert node.succeed(metadata_command) == aliased_metadata, "root provisioner repaired aliased state"

        for unit in ["manifold-shell-owner.service", "manifold-shell-transport.service"]:
            node.succeed("systemctl reset-failed " + unit)
            node.fail("systemctl start " + unit)
            assert node.succeed("systemctl show -p MainPID --value " + unit).strip() == "0"
            if unit == "manifold-shell-transport.service":
                node.succeed("systemctl stop " + unit)
        node.succeed(f"test ! -e {socket_path}")
        assert node.succeed(metadata_command) == aliased_metadata, "startup repaired aliased owner state"

        if profile_role == "coexist":
            assert node.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == native_owner
            assert node.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json") == native_configuration
            node.succeed(fixture_command + "custody-result")
        node.shutdown()
  '' + pkgs.lib.optionalString (role == "machine") ''
    machine.start()
    machine.connect()
    machine.wait_for_unit("manifold-server.service", timeout=180)
    machine.wait_for_unit("manifold-owner.service", timeout=180)
    machine.wait_for_unit("manifold-transport.service", timeout=180)
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    identity = machine.succeed("${inspectCommand}").strip()
    for path in ["owner.key", "agent.token", "job-owner/config.json"]:
        assert machine.succeed(f"stat -c '%a %U' /var/lib/manifold/{path}").strip() == "600 manifold"
    # A node that declares no operator anchor retains exactly its earlier owner configuration.
    for path in ["owner-template.json", "job-owner/config.json"]:
        assert "operatorAnchors" not in json.loads(machine.succeed(f"cat /var/lib/manifold/{path}")), path
    machine.succeed("test ! -e /run/manifold-anchors")
    machine.fail("systemctl cat manifold-operator-anchors.service")
    owner = machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
    assert int(owner) > 1
    machine.succeed("${inspectCommand} install")
    machine.succeed("${inspectCommand} execute")
    machine.wait_until_succeeds("${inspectCommand} result", timeout=180)
    # The module mounts bounded scratch, but must not pre-create plugin components.
    machine.succeed("test ! -e /var/lib/manifold-output/native-profile")
    for job_id in ["module-runtime-first", "module-runtime-second"]:
        machine.succeed("${inspectCommand} execute-outputs " + job_id)
        receipt = machine.wait_until_succeeds("${inspectCommand} result-outputs " + job_id, timeout=180)
        print(receipt)
    assert machine.succeed("stat -c '%a %U' /var/lib/manifold-output/native-profile /var/lib/manifold-output/native-profile/outputs").strip().splitlines() == ["700 manifold", "700 manifold"]
    machine.succeed("systemctl restart manifold-server.service manifold-transport.service")
    machine.wait_for_unit("manifold-server.service", timeout=180)
    machine.wait_for_unit("manifold-transport.service", timeout=180)
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    assert machine.succeed("${inspectCommand}").strip() == identity
    assert machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == owner
    machine.succeed("${inspectCommand} result")
    original = machine.succeed("readlink -f /run/current-system").strip()
    retained = machine.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json")
    machine.succeed("systemctl is-active register-nix-paths.service")
    machine.fail("/run/current-system/specialisation/changed-native/bin/switch-to-configuration test", timeout=180)
    assert machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == owner
    assert machine.succeed("sha256sum /var/lib/manifold/owner-template.json /var/lib/manifold/job-owner/config.json") == retained
    machine.succeed(f"{original}/bin/switch-to-configuration test", timeout=180)
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    machine.succeed("${inspectCommand} result")
    machine.succeed("${maintenanceCommand} --help")
    admission = dict(hub="http://127.0.0.1:7777", machine_id=identity, owner_key_file="/var/lib/manifold/owner.key")
    machine.succeed("${inspectCommand} execute-hold module-maintenance-live")
    machine.wait_until_succeeds("${inspectCommand} started-hold module-maintenance-live", timeout=30)
    drained = maintenance(machine, "drain", **admission)
    assert drained["machineId"] == identity and drained["draining"], drained
    # No terminals is deliberately NOT idle proof: this owner still has a real running job.
    assert drained["terminalIds"] == [], drained
    expected_host = drained["terminalHostId"]
    shutdown = dict(socket="/var/lib/manifold/terminal-host/host.sock", terminal_host_id=expected_host)
    held = maintenance(machine, "shutdown", expected_code=1, **shutdown)
    assert held["hold"] and held["reason"] == "jobs_retained", held
    assert machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip() == owner
    machine.succeed("${inspectCommand} started-hold module-maintenance-live")
    machine.succeed("${inspectCommand} drained")
    # An explicit reopen is distinct from a HOLD; neither command stops the supervisor.
    reopened = maintenance(machine, "reopen", **admission)
    assert not reopened["draining"] and reopened["terminalHostId"] == expected_host, reopened
    machine.succeed("${inspectCommand} execute module-maintenance-reopened")
    machine.wait_until_succeeds("${inspectCommand} result module-maintenance-reopened", timeout=180)
    drained = maintenance(machine, "drain", **admission)
    assert drained["draining"] and drained["terminalHostId"] == expected_host, drained
    machine.wait_until_succeeds("${inspectCommand} result-hold module-maintenance-live", timeout=180)
    acknowledged = maintenance(machine, "shutdown", **shutdown)
    assert acknowledged["terminalHostId"] == expected_host, acknowledged
    machine.wait_until_succeeds("test \"$(systemctl show -p ActiveState --value manifold-owner.service)\" = inactive", timeout=30)
    machine.succeed("systemctl start manifold-owner.service")
    machine.wait_until_succeeds("${inspectCommand}", timeout=180)
    replacement = machine.succeed("systemctl show -p MainPID --value manifold-owner.service").strip()
    assert int(replacement) > 1 and replacement != owner
    assert machine.succeed("${inspectCommand}").strip() == identity
    machine.succeed("${inspectCommand} result")
    machine.succeed("${inspectCommand} result-hold module-maintenance-live")
    reopened = maintenance(machine, "reopen", **admission)
    assert not reopened["draining"] and reopened["terminalHostId"] != expected_host, reopened
    machine.succeed("${inspectCommand} execute module-native-recovered")
    machine.wait_until_succeeds("${inspectCommand} result module-native-recovered", timeout=180)

    machine.shutdown()
  '' + pkgs.lib.optionalString (role == "credential") ''
    credential.start()
    credential.connect()

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
    # Selected closures supply the real shell/Git ABI, never unrelated host store paths.
    assert credential.succeed("${pkgs.hello}/bin/hello").strip() == "Hello, world!"
    credential.succeed("${inspectCommand} install-tools")
    credential.succeed("${inspectCommand} execute-tools module-credential-tools")
    credential.wait_until_succeeds("${inspectCommand} result-tools module-credential-tools", timeout=180)
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

    credential.shutdown()
  '' + pkgs.lib.optionalString (role == "anchors") ''
    anchors.start()
    anchors.connect()

    # Operator anchors: root-made read-only idmapped views of a 0700 home beneath protected /home.
    anchors.wait_for_unit("manifold-owner.service", timeout=180)
    anchors.wait_for_unit("manifold-transport.service", timeout=180)
    anchors.wait_until_succeeds("${inspectCommand}", timeout=180)
    # The service account still cannot reach the source, nor traverse the home above it.
    denied = anchors.fail("runuser -u manifold -- stat /home/alice/sessions 2>&1")
    assert "Permission denied" in denied, denied
    options = anchors.succeed("findmnt -n -o VFS-OPTIONS --mountpoint /run/manifold-anchors/fixture").strip().split(",")
    for option in ["ro", "nosuid", "nodev", "noexec", "nosymfollow", "idmapped"]:
        assert option in options, options
    # Through the view the operator's private files read as manifold's, and stay unwritable.
    anchors.succeed("runuser -u manifold -- test -r /run/manifold-anchors/fixture/private.jsonl")
    anchors.succeed("runuser -u manifold -- test -r /run/manifold-anchors/fixture/private-directory/inner.jsonl")
    anchors.succeed("runuser -u manifold -- test ! -w /run/manifold-anchors/fixture/private.jsonl")
    # An absent source, and one reached through a link, get no view; the owner only omits them.
    anchors.succeed("test ! -e /run/manifold-anchors/absent && test ! -e /run/manifold-anchors/linked")
    helper = anchors.succeed("journalctl -b -u manifold-operator-anchors.service --no-pager")
    assert "Manifold operator anchor linked has no view: symbolic link at /home/alice/linked" in helper, helper
    assert "Manifold operator anchor absent has no view: source /home/alice/absent is absent or not a directory" in helper, helper
    assert "Manifold operator anchor fixture presents /home/alice/sessions read-only at /run/manifold-anchors/fixture" in helper, helper
    anchors.succeed("systemctl is-failed --quiet manifold-operator-anchors.service")
    owner_log = anchors.succeed("journalctl -b -u manifold-owner.service --no-pager")
    for name in ["operator.absent", "operator.linked"]:
        assert any(
            '"evt":"operator_anchor_unavailable"' in line and name in line and "operator_anchor_absent" in line
            for line in owner_log.splitlines()
        ), owner_log
    template = json.loads(anchors.succeed("cat /var/lib/manifold/owner-template.json"))
    assert template["operatorAnchors"] == {
        "operator." + name: {"path": "/run/manifold-anchors/" + name, "source": source, "readOnly": True}
        for name, source in [
            ("fixture", "/home/alice/sessions"),
            ("absent", "/home/alice/absent"),
            ("linked", "/home/alice/linked/sessions"),
        ]
    }, template
    # Metadata, ACLs and access times of every source path, read without reading any content.
    snapshot = "find /home/alice/sessions -exec stat -c '%n %a %u %g %s %i %X %Y %Z' {} + | sort && getfacl -R -p /home/alice/sessions"
    anchors.succeed(snapshot)
    before = anchors.succeed(snapshot)
    anchors.succeed("${inspectCommand} anchors-install")
    anchors.succeed("${inspectCommand} anchors-ready")
    for job_id, path, content in [
        ("anchors-private", "private.jsonl", "private-session"),
        ("anchors-public", "public.jsonl", "public-session"),
        ("anchors-inner", "private-directory/inner.jsonl", "inner-session"),
    ]:
        anchors.succeed(f"${inspectCommand} anchors-execute {job_id} {path}")
        anchors.wait_until_succeeds(f"${inspectCommand} anchors-result {job_id} {content}", timeout=180)
    # Reading and every refused write left the source exactly as it was.
    assert anchors.succeed(snapshot) == before
    # A private file created after boot is read by the next job with nothing re-applied.
    anchors.succeed("runuser -u alice -- sh -c 'umask 077 && printf later-session > /home/alice/sessions/later.jsonl'")
    assert anchors.succeed("stat -c '%a %U' /home/alice/sessions/later.jsonl").strip() == "600 alice"
    anchors.succeed("${inspectCommand} anchors-execute anchors-later later.jsonl")
    anchors.wait_until_succeeds("${inspectCommand} anchors-result anchors-later later-session", timeout=180)

    anchors.shutdown()
  '';
}
