#!/usr/bin/env python3
"""Single-use #469 transaction; remove after public live proof.

Current interpreted-source bytes do NOT attest previously loaded code. Only the
explicitly authorized weaker boundary permits retiring this exact legacy image.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time

LEGACY_REVISION = "6c153d69685dab1653ec29c622f1e6a6f61d1ce2"
CONTAINER = "e56a20921a42dddeb0ceaff70181f113fdd36aff2de9568c6ac5f30d86625c05"
IMAGE = "sha256:e603d33b3545a29cf3cf1ad5b6463f0c576006096479cde8f0d1eae40bcf7aa9"
BASE = "sha256:872ada6c21e7f75bccf255c59c3c06ef4cd92b97fcd5a637da399868c0963a03"
TINI = "/nix/store/n93rbxpv1s33jfligb31fqs6xh96yml2-tini-0.19.0/bin/tini"
ENTRYPOINT = "/nix/store/245h7ryzijz84dyq2clqpfyk2wf1rln0-development-entrypoint/bin/development-entrypoint"
BASH = "/nix/store/9ipfvwnqp1q8ijnmi5sxvlx9r8w34lw3-bash-5.3p15/bin/bash"
SLEEP = "/nix/store/3qgy8q2j64v2m9jy3a5jmssacbblhd4r-coreutils-9.11/bin/sleep"
NIX_DAEMON = "/nix/store/7vb637v8mqbycvmpwfl5q93ikr2xjpay-nix-2.34.8/bin/nix-daemon"
ROLES = ("init", "supervisor", "daemon", "server", "owner", "transport")
HEALTH_SOURCE = "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);"
# Independently recovered from the digest-pinned development base, not the live
# process. These exact artifacts include multicall/wrapper real-executable paths.
APPROVED_RUNTIME = {
    "tini": {"path": TINI, "realPath": TINI, "sha256": "a3f4fa3f40c36d4b8a9f009f600e68140ecf2b5a4a69c79190db7db439dd3629"},
    "bash": {"path": BASH, "realPath": BASH, "sha256": "0a9eca3749b671a0424bfa85be097ab52d56943e096d9b0c24f39e681718986b"},
    "nixDaemon": {"path": NIX_DAEMON, "realPath": "/nix/store/x90ajwa2ydmwsa0qjccpj1nsl6049wmm-nix-2.34.8/bin/nix", "sha256": "f7eaf4e186b1a1baa9ac5f5c21dfc3226436e703e7e92b830ca62758ded9e84b"},
    "bun": {"path": "/nix/store/x80848lhf2vhhlqffp87hl4bmvr3c64r-bun-1.4.2/bin/bun", "realPath": "/nix/store/x80848lhf2vhhlqffp87hl4bmvr3c64r-bun-1.4.2/bin/bun", "sha256": "141a3dfdf64c99c6b3bcb4f09d055c2269feaa7a45b4c59c4b8f70a05203ed60"},
    "sleep": {"path": SLEEP, "realPath": "/nix/store/3qgy8q2j64v2m9jy3a5jmssacbblhd4r-coreutils-9.11/bin/coreutils", "sha256": "4889ee74963e175225b91d8e2160372d9932e1a4056b080eb8e3ae5474c1e87f"},
    "entrypoint": {"path": ENTRYPOINT, "realPath": ENTRYPOINT, "sha256": "7507f1863f8858f3f6ffde1069a1ec4e6ff5ae4f87531714aac43af25e80bf85"},
}


class Hold(Exception):
    pass


def require(condition):
    if not condition:
        raise Hold()


def command(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=90, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024)
    return result.stdout


class Generation:
    """An open pidfd, never a check-then-kill numeric PID."""
    def __init__(self, pid, start, signal_callback=None):
        require(sys.platform == "linux" and hasattr(os, "pidfd_open") and
                hasattr(signal, "pidfd_send_signal"))
        self.pid = pid
        self.start = str(start)
        self.signal_callback = signal_callback
        self.fd = os.pidfd_open(pid, 0)
        self.poll = select.poll()
        self.poll.register(self.fd, select.POLLIN)
        self.alive()

    def alive(self):
        require(not self.poll.poll(0))
        raw = Path(f"/proc/{self.pid}/stat").read_text()
        fields = raw[raw.rindex(")") + 2:].split()
        require(fields[19] == self.start and fields[0] not in ("Z", "X"))

    def wait(self):
        require(bool(self.poll.poll(30_000)))

    def terminate_transport_or_server(self):
        self.alive()
        if self.signal_callback is not None:
            self.signal_callback()
        else:
            # Direct subprocess fixture; production always uses the existing
            # application UID inside the container, with a second pinned pidfd.
            signal.pidfd_send_signal(self.fd, signal.SIGTERM)
        self.wait()


def retire(boundary):
    boundary.prove("owning")
    boundary.inhibit_restart()
    boundary.prove("owning")
    boundary.phase = "drain-requested"
    require(boundary.maintenance("drain") == {
        "ok": True, "command": "drain", "machineId": boundary.evidence["machineId"],
        "terminalHostId": boundary.evidence["terminalHostId"], "draining": True, "terminalIds": []})
    boundary.phase = "drained"
    boundary.prove("owning")
    boundary.phase = "owner-shutdown-requested"
    require(boundary.maintenance("shutdown") == {
        "ok": True, "command": "shutdown", "terminalHostId": boundary.evidence["terminalHostId"]})
    boundary.phase = "owner-acknowledged"
    boundary.owner.wait()  # owner is NEVER a signal target
    boundary.prove("owner-exited")
    boundary.phase = "owner-exited"
    boundary.transport.terminate_transport_or_server()
    boundary.prove("server-only")
    boundary.phase = "transport-exited"
    boundary.server.terminate_transport_or_server()
    boundary.phase = "server-exit-observed"
    boundary.remove_empty_container()
    boundary.phase = "legacy-container-removed"


class DockerBoundary:
    def __init__(self, evidence, topology, repo, bundle):
        self.phase = "preflight"
        self.evidence, self.topology, self.repo = evidence, topology, repo
        self.bundle = Path(bundle).read_bytes()  # reviewed public code only
        self.adapter = Path(bundle).with_name("process.js").read_bytes()
        self.restart_inhibited = False
        require(set(evidence) == {"containerId", "containerName", "imageId", "startedAt",
            "restartCount", "legacyRevision", "machineId", "terminalHostId", "socket", "runtime", *ROLES})
        require(evidence["containerId"] == CONTAINER and evidence["containerName"] == "manifold-dev-manifold-1" and
                evidence["imageId"] == IMAGE and evidence["legacyRevision"] == LEGACY_REVISION and
                evidence["socket"] == "/data/terminal-host/host.sock")
        for key in ("machineId", "terminalHostId"):
            require(isinstance(evidence[key], str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", evidence[key]))
        require(isinstance(evidence["startedAt"], str) and re.fullmatch(r"[0-9T:.Z-]{20,40}", evidence["startedAt"]) and
                type(evidence["restartCount"]) is int and evidence["restartCount"] >= 0)
        for role in ROLES:
            value = evidence[role]
            require(set(value) == {"pid", "startTime", "namespacePid"} and
                    all(type(value[k]) is int and value[k] > 0 for k in value))
        require(evidence["init"]["namespacePid"] == 1 and len({evidence[r]["pid"] for r in ROLES}) == 6 and
                len({evidence[r]["namespacePid"] for r in ROLES}) == 6)
        self.runtime = evidence["runtime"]
        require(self.runtime == APPROVED_RUNTIME)
        self.container = CONTAINER
        self.config_template = self.make_config_template()
        self.metadata(True)
        for role in ROLES:
            callback = (lambda role=role: self.adapter_call({"mode": "signal", "references": [self.reference(role)]})) if role in ("transport", "server") else None
            setattr(self, role, Generation(evidence[role]["pid"], evidence[role]["startTime"], callback))
        group = Path(f"/proc/{self.init.pid}/cgroup").read_text()
        prefix = r"(?:system.slice|user.slice/user-[0-9]+\.slice/user@[0-9]+\.service/(?:app.slice|user.slice))"
        match = re.fullmatch(r"0::(/(?:" + prefix + "/docker-" + CONTAINER + r"\.scope|docker/" + CONTAINER + r"))\n", group)
        require(match is not None and Path("/sys/fs/cgroup/cgroup.controllers").is_file())
        self.group_record = group
        self.group = Path("/sys/fs/cgroup" + match[1])
        self.source_proof()

    def make_config_template(self):
        require(self.topology["machine"] == "dev-hub" and self.topology["volume"] == "manifold-dev_manifold-data")
        networks = self.topology["networks"]
        require(1 <= len(networks) <= 16 and all(re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", n) for n in networks))
        template = """{{ $unsafe := false }}{{ $machine := false }}{{ $data := false }}
{{ range .Config.Env }}{{ $key := index (split . "=") 0 }}
{{ if eq $key "MANIFOLD_MACHINE_NAME" }}{{ if or $machine (ne . "MANIFOLD_MACHINE_NAME=dev-hub") }}{{ $unsafe = true }}{{ end }}{{ $machine = true }}
{{ else if eq $key "MANIFOLD_DATA_DIR" }}{{ if or $data (ne . "MANIFOLD_DATA_DIR=/data") }}{{ $unsafe = true }}{{ end }}{{ $data = true }}
{{ else if or (eq $key "MANIFOLD_SPAWN_AGENT") (eq $key "BUN_OPTIONS") (eq $key "BUN_PRELOAD") (eq $key "NODE_OPTIONS") (eq $key "LD_PRELOAD") (eq $key "LD_LIBRARY_PATH") (eq $key "LD_AUDIT") (eq $key "ENV") (eq $key "BASH_ENV") (eq $key "MANIFOLD_LOCAL_JOB_OWNER_TEMPLATE") (eq $key "MANIFOLD_LOCAL_AGENT_SUPERVISION") }}{{ $unsafe = true }}{{ end }}{{ end }}
{{ range .Mounts }}{{ if or (ne .Destination "/data") (ne .Type "volume") (ne .Name "manifold-dev_manifold-data") (not .RW) }}{{ $unsafe = true }}{{ end }}{{ end }}
{{ range .HostConfig.Mounts }}{{ if .VolumeOptions }}{{ if .VolumeOptions.Subpath }}{{ $unsafe = true }}{{ end }}{{ end }}{{ end }}
{{ if and $machine $data (not $unsafe) (eq (len .Mounts) 1) (eq .HostConfig.PidMode "") (eq .HostConfig.IpcMode "private") (eq .HostConfig.UTSMode "") (eq .HostConfig.CgroupnsMode "private") (not .HostConfig.Privileged) (not .HostConfig.AutoRemove) (not .HostConfig.Init) (eq (len .HostConfig.Devices) 0) (eq (len .HostConfig.CapAdd) 0) (eq .Config.User "0:0") (eq .Config.WorkingDir "/app") (eq (json .Config.Cmd) "[\\"/app/infra/entrypoint.sh\\"]") (eq (json .Config.Entrypoint) ENTRY) (eq (index .Config.Labels "com.docker.compose.project") "manifold-dev") (eq (index .Config.Labels "com.docker.compose.service") "manifold") (eq (index .Config.Labels "org.opencontainers.image.revision") REVISION) (eq (index .Config.Labels "org.opencontainers.image.base.digest") BASE) NETWORKS }}approved-legacy-config{{ end }}"""
        checks = f"(eq (len .NetworkSettings.Networks) {len(networks)}) "
        checks += " ".join("(index .NetworkSettings.Networks " + json.dumps(n) + ")" for n in networks)
        entry = json.dumps(json.dumps([TINI, "-g", "--", ENTRYPOINT], separators=(",", ":")))
        return template.replace("ENTRY", entry).replace("REVISION", json.dumps(LEGACY_REVISION)).replace("BASE", json.dumps(BASE)).replace("NETWORKS", checks)

    def inspect(self, template):
        return command(["docker", "inspect", "--format", template, self.container]).decode().strip()

    def metadata(self, running):
        e = self.evidence
        observed = json.loads(self.inspect("""{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"started":{{json .State.StartedAt}},"pid":{{.State.Pid}},"running":{{.State.Running}},"paused":{{.State.Paused}},"restarting":{{.State.Restarting}},"restarts":{{.RestartCount}},"restart":{{json .HostConfig.RestartPolicy.Name}}}"""))
        require(observed["id"] == CONTAINER and observed["name"] == "/" + e["containerName"] and
                observed["image"] == IMAGE and observed["started"] == e["startedAt"] and
                observed["restarts"] == e["restartCount"] and not observed["paused"] and
                not observed["restarting"] and observed["running"] == running and
                observed["pid"] == (e["init"]["pid"] if running else 0))
        if self.restart_inhibited:
            require(observed["restart"] == "no")
        require(self.inspect(self.config_template) == "approved-legacy-config")
        require(json.loads(self.inspect("{{json .Config.Healthcheck.Test}}")) ==
                ["CMD-SHELL", 'bun -e "' + HEALTH_SOURCE + '"'])

    def adapter_call(self, request):
        uid = "0:0" if request["mode"] == "inventory" else "1000:1000"
        encoded = json.dumps(request, separators=(",", ":"))
        chunks = [encoded[i:i + 32_000] for i in range(0, len(encoded), 32_000)]
        result = command(["docker", "exec", "-i", "--user", uid, "--workdir", "/", self.container,
                          self.runtime["bun"]["path"], "--no-env-file", "-", *chunks], self.adapter)
        require(result.strip() == b"legacy-process-generation-verified")

    def reference(self, role):
        value = self.evidence[role]
        artifact = self.runtime[{"init": "tini", "supervisor": "bash", "daemon": "nixDaemon"}.get(role, "bun")]
        parent_role = {"supervisor": "init", "daemon": "supervisor", "server": "supervisor", "owner": "server", "transport": "server"}.get(role)
        parent = self.evidence[parent_role]["namespacePid"] if parent_role else 0
        result = {"role": role, "pid": value["namespacePid"], "startTime": value["startTime"],
                  "parent": parent, "uid": 0 if role in ("init", "supervisor", "daemon") else 1000,
                  "executable": artifact["realPath"], "sha256": artifact["sha256"]}
        result["group"] = value["namespacePid"] if role in ("init", "owner", "transport") else self.evidence["supervisor"]["namespacePid"]
        result["session"] = value["namespacePid"] if role in ("owner", "transport") else 1
        if role == "init":
            result["argv"] = [TINI, "-g", "--", ENTRYPOINT, "/app/infra/entrypoint.sh"]
        elif role == "supervisor":
            result["argv"] = [BASH, ENTRYPOINT, "/app/infra/entrypoint.sh"]
        elif role == "daemon":
            result["argv"] = [NIX_DAEMON]
        return result

    def source_proof(self):
        files = command(["git", "-C", self.repo, "ls-tree", "-r", "--name-only", LEGACY_REVISION]).decode().splitlines()
        paths = [p for p in files if (p.startswith("packages/") and ("/src/" in p or p.endswith("/package.json")))
                 or p in ("package.json", "bun.lock", "bun.lockb", "bunfig.toml", "tsconfig.json", "infra/entrypoint.sh")]
        require("packages/agent/src/main.ts" in paths and "packages/agent/src/agent.ts" in paths and
                "packages/agent/src/terminal-host.ts" in paths and "infra/entrypoint.sh" in paths)
        sources = {}
        for name in paths:
            require(not any(part in ("..", ".") for part in Path(name).parts))
            approved = command(["git", "-C", self.repo, "show", LEGACY_REVISION + ":" + name])
            if name == "bunfig.toml":
                require(b"preload" not in approved)
            sources["/app/" + name] = hashlib.sha256(approved).hexdigest()
        self.sources = sources
        self.adapter_call({"mode": "source", "sources": sources, "runtime": self.runtime})

    def prove(self, phase):
        self.metadata(True)
        self.adapter_call({"mode": "source", "sources": self.sources, "runtime": self.runtime})
        expected = {"owning": ROLES, "owner-exited": ROLES[:-2] + ("transport",), "server-only": ROLES[:-2]}[phase]
        require(not any(p.is_dir() for p in self.group.iterdir()))
        # Host kernel generations and cgroup binding remain independent of Docker
        # exec's UID-specific metadata proof. No environment or private records read.
        for role in expected:
            generation = getattr(self, role)
            generation.alive()
            proc = Path(f"/proc/{generation.pid}")
            require((proc / "cgroup").read_text() == self.group_record)
            nspid = [line.split()[1:] for line in (proc / "status").read_text().splitlines() if line.startswith("NSpid:")]
            require(nspid == [[str(generation.pid), str(self.evidence[role]["namespacePid"])]])
        self.adapter_call({"mode": "probe", "references": [self.reference(r) for r in expected if r in ("server", "owner", "transport")]})
        self.adapter_call({"mode": "inventory", "references": [self.reference(r) for r in expected],
                           "runtime": self.runtime, "supervisorPid": self.evidence["supervisor"]["namespacePid"]})
        for role in set(ROLES) - set(expected):
            require(not Path(f"/proc/{self.evidence[role]['pid']}").exists())
        for role in expected:
            getattr(self, role).alive()
        require(not any(p.is_dir() for p in self.group.iterdir()))

    def inhibit_restart(self):
        command(["docker", "update", "--restart=no", self.container])
        self.restart_inhibited = True
        self.phase = "restart-inhibited"
        self.metadata(True)

    def maintenance(self, op):
        args = ["docker", "exec", "-i", "--user", "1000:1000", "--workdir", "/", self.container,
                self.runtime["bun"]["path"], "--no-env-file", "-", op]
        if op == "drain":
            args += ["--hub", "http://127.0.0.1:7777", "--machine-id", self.evidence["machineId"], "--owner-key-file", "/data/owner.key"]
        else:
            args += ["--socket", self.evidence["socket"], "--terminal-host-id", self.evidence["terminalHostId"],
                     "--expected-pid", str(self.evidence["owner"]["namespacePid"])]
        return json.loads(command(args, self.bundle))

    def remove_empty_container(self):
        # The exact reviewed supervisor never respawns. After app self-exit it
        # shuts down ONLY its original daemon/app children, then tini exits itself.
        # Inventory already excluded every Nix worker/client before app SIGTERM.
        self.init.wait()
        self.supervisor.wait()
        self.daemon.wait()
        for _ in range(100):
            if self.inspect("{{.State.Running}}") == "false":
                break
            time.sleep(0.1)
        self.metadata(False)
        remaining_pids = set(os.listdir("/proc"))
        require(all(str(self.evidence[r]["pid"]) not in remaining_pids for r in ROLES))
        # A missing group is absence only below its positively readable parent.
        # Permission errors or vanished ancestors hold rather than imply emptiness.
        group_present = self.group.name in os.listdir(self.group.parent)
        if group_present:
            require(not any(p.is_dir() for p in self.group.iterdir()) and
                    (self.group / "cgroup.procs").read_text().strip() == "" and
                    "populated 0" in (self.group / "cgroup.events").read_text().splitlines())
        command(["docker", "rm", self.container])  # never --force or --volumes


def main():
    boundary = None
    def interrupted(_signum, _frame):
        raise Hold()
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        require(len(sys.argv) == 5)
        evidence = json.loads(Path(sys.argv[1]).read_text())  # explicit PUBLIC approval record
        boundary = DockerBoundary(evidence, json.loads(sys.argv[2]), sys.argv[3], sys.argv[4])
        retire(boundary)
        print("legacy-container-removed")
        return 0
    except Exception:
        phase = boundary.phase if boundary else "preflight"
        print("legacy-cutover: HOLD phase=" + phase +
              "; no rollback or admission reopening; restart inhibition may remain", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
