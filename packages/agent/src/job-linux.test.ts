import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { connectWorkloadLoopback } from "./job-listener-proof.ts";
import { createJobServiceProxy, type JobServiceProxy } from "./job-service-proxy.ts";
import {
  HeldDirectory,
  privateSocketPair,
  privateByteFile,
  isSealedByteFile,
} from "./job-files.ts";
import { JobOutputStore } from "./job-outputs.ts";
import {
  preflightLinuxJob,
  startLinuxJob,
  type LinuxJobHandle,
  type LinuxJobSpec,
} from "./job-linux.ts";
import { PtyTerminal } from "./terminal.ts";

function fixture(): { spec: LinuxJobSpec; close(): void } {
  const path = mkdtempSync(join(tmpdir(), "job-linux-"));
  writeFileSync(join(path, "executable"), "not executed", { mode: 0o500 });
  const directory = HeldDirectory.openAbsolute(path, { private: true });
  const fd = directory.openFile("executable");
  return {
    spec: {
      bubblewrapFd: fd,
      artifactFd: fd,
      delegatedCgroup: directory,
      argv: [],
      runtime: [],
      locations: [],
      outputs: [],
      network: "none",
      bidirectional: false,
      limits: { memoryBytes: 64 * 1024 * 1024, processes: 8, timeoutMs: 2000, outputBytes: 4096 },
    },
    close() {
      closeSync(fd);
      directory.close();
      rmSync(path, { recursive: true });
    },
  };
}

// Borrowed-stdio regressions can close unrelated runtime FDs. Only a disposable
// process may exercise that contract; the suite runner passes no extra descriptors.
function isolatedRuntime(source: string): void {
  const result = spawnSync(process.execPath, ["--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
}

test.skipIf(process.platform !== "linux")(
  "unsupported Bun refuses governed execution before reading job authority",
  () => {
    isolatedRuntime(`
      import assert from "node:assert/strict";
      import { LinuxJobRefusal, preflightLinuxJob, startLinuxJob } from ${JSON.stringify(
        new URL("./job-linux.ts", import.meta.url).href,
      )};
      Bun.semver.satisfies = () => false;
      const spec = new Proxy({}, {
        get() { throw new Error("job authority touched before runtime refusal"); },
      });
      const refused = error => error instanceof LinuxJobRefusal &&
        error.code === "bun-job-fd-ownership-unsupported";
      assert.throws(() => preflightLinuxJob(spec), refused);
      await assert.rejects(startLinuxJob(spec), refused);
    `);
  },
);

test.skipIf(process.platform !== "linux").each(["sync", "async"])(
  "borrowed numeric extra FD survives successful %s spawn and collection in an isolated process",
  (mode) => {
    isolatedRuntime(`
      import assert from "node:assert/strict";
      import { spawn, spawnSync } from "node:child_process";
      import { closeSync, fstatSync, openSync, readSync } from "node:fs";
      import { once } from "node:events";
      import { setImmediate } from "node:timers/promises";
      const fd = openSync("/dev/null", "r");
      const identity = ({ dev, ino, rdev, mode }) => ({ dev, ino, rdev, mode });
      const expected = identity(fstatSync(fd));
      const assertBorrowed = () => {
        assert.deepEqual(identity(fstatSync(fd)), expected);
        assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, null), 0);
      };
      const args = ["--eval", \`
        import assert from "node:assert/strict";
        import { fstatSync, readSync } from "node:fs";
        assert.equal(fstatSync(3).isCharacterDevice(), true);
        assert.equal(readSync(3, Buffer.alloc(1), 0, 1, null), 0);
      \`];
      const options = {
        stdio: ["ignore", "ignore", "inherit", fd],
        timeout: 3000,
        killSignal: "SIGKILL",
      };
      // Drop the child wrapper before GC, while retaining ownership of fd.
      await (async () => {
        if (${JSON.stringify(mode)} === "sync") {
          const child = spawnSync(process.execPath, args, options);
          assert.equal(child.error, undefined);
          assert.equal(child.signal, null);
          assert.equal(child.status, 0);
        } else {
          const child = spawn(process.execPath, args, options);
          const [code, signal] = await once(child, "close");
          assert.equal(signal, null);
          assert.equal(code, 0);
        }
      })();
      assertBorrowed();
      for (let turn = 0; turn < 4; turn++) {
        Bun.gc(true);
        await setImmediate();
        assertBorrowed();
      }
      closeSync(fd);
    `);
  },
);

test("invalid bounds and mount shadowing refuse before touching executable descriptors", () => {
  const f = fixture();
  try {
    const invalidFd = { ...f.spec, artifactFd: -1, bubblewrapFd: -1 };
    expect(() =>
      preflightLinuxJob({ ...invalidFd, limits: { ...f.spec.limits, memoryBytes: Infinity } }),
    ).toThrow("invalid-limits");
    expect(() =>
      preflightLinuxJob({
        ...invalidFd,
        locations: [{ fd: -1, target: "/job/artifact", writable: true }],
      }),
    ).toThrow("reserved-mount-target");
    expect(() =>
      preflightLinuxJob({
        ...invalidFd,
        locations: [
          { fd: -1, target: "/data", writable: false },
          { fd: -1, target: "/data/private", writable: true },
        ],
      }),
    ).toThrow("overlapping-mounts");
  } finally {
    f.close();
  }
});

test("runtime executable selection cannot execute a directory closure or an undeclared alias", () => {
  const f = fixture();
  try {
    expect(() => preflightLinuxJob({ ...f.spec, executableRuntimeTool: "engine" })).toThrow(
      "runtime-executable-unavailable",
    );
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        executableRuntimeTool: "engine",
        runtime: [
          { fd: f.spec.delegatedCgroup.fd, target: "/runtime/bin/engine", writable: false },
        ],
      }),
    ).toThrow("untrusted-executable");
  } finally {
    f.close();
  }
});

test("input files must be immutable anonymous descriptors, not readonly views of mutable host files", () => {
  const f = fixture();
  const fd = privateByteFile(Buffer.from("exact config\n"));
  try {
    expect(isSealedByteFile(fd)).toBe(true);
    expect(() => {
      const writable = openSync(`/proc/self/fd/${fd}`, constants.O_RDWR);
      try {
        writeFileSync(writable, "substitution");
      } finally {
        closeSync(writable);
      }
    }).toThrow();
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        inputFiles: [{ fd: f.spec.artifactFd, target: "/inputs/config", writable: false }],
      }),
    ).toThrow("unsafe-input-file");
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        inputFiles: [{ fd, target: "/inputs/config", writable: false }],
        locations: [{ fd: f.spec.artifactFd, target: "/inputs/other", writable: false }],
      }),
    ).toThrow("reserved-input-target");
  } finally {
    closeSync(fd);
    f.close();
  }
});

test("sealed home inputs refuse unsafe components and every host-backed ancestor", () => {
  const f = fixture();
  const fd = privateByteFile(Buffer.from("private"));
  try {
    for (const target of [
      "/home/job",
      "/home/job/../escape",
      "/home/job/.config//key",
      "/home/job/bad\\key",
      `/home/job/${"a".repeat(129)}`,
      `/home/job/${Array(17).fill("a").join("/")}`,
    ]) {
      expect(() =>
        preflightLinuxJob({ ...f.spec, inputFiles: [{ fd, target, writable: false }] }),
      ).toThrow();
    }
    for (const kind of ["locations", "runtime", "outputs"] as const) {
      for (const target of ["/home", "/home/job", "/home/job/.config", "/home/job/.config/omp"]) {
        expect(() =>
          preflightLinuxJob({
            ...f.spec,
            [kind]: [{ fd: f.spec.delegatedCgroup.fd, target, writable: kind !== "runtime" }],
            inputFiles: [{ fd, target: "/home/job/.config/omp/auth.json", writable: false }],
          }),
        ).toThrow("overlapping-mounts");
      }
    }
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        inputFiles: [{ fd, target: "/home/job/.config/omp/auth.json", writable: true }],
      }),
    ).toThrow("unsafe-input-file");
  } finally {
    closeSync(fd);
    f.close();
  }
});

test("ordinary directories cannot stand in for enforced cgroups", async () => {
  const f = fixture();
  try {
    await expect(startLinuxJob(f.spec)).rejects.toThrow("cgroup-v2-required");
  } finally {
    f.close();
  }
});

test("ordinary output directories refuse before process creation instead of pretending to be quotas", async () => {
  const f = fixture();
  try {
    await expect(
      startLinuxJob({
        ...f.spec,
        outputs: [{ fd: f.spec.delegatedCgroup.fd, target: "/outputs/result", writable: true }],
      }),
    ).rejects.toThrow("bounded-output-storage-required");
  } finally {
    f.close();
  }
});

test("a held regular file cannot be inherited as the parent authority socket", () => {
  const f = fixture();
  try {
    expect(() => preflightLinuxJob({ ...f.spec, contextFd: f.spec.artifactFd })).toThrow(
      "context-must-be-socket",
    );
  } finally {
    f.close();
  }
});

test("directory mount inspection retains symlinks without following their host targets", () => {
  const f = fixture();
  try {
    symlinkSync("/dev/null", `${f.spec.delegatedCgroup.procPath}/link`);
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        locations: [{ fd: f.spec.delegatedCgroup.fd, target: "/data", writable: false }],
      }),
    ).toThrow("cgroup-v2-required");
  } finally {
    f.close();
  }
});

test("directory mount inspection refuses an over-deep held tree before supervisor spawn", async () => {
  const f = fixture();
  try {
    mkdirSync(`${f.spec.delegatedCgroup.procPath}/${Array(65).fill("child").join("/")}`, {
      recursive: true,
    });
    await expect(
      startLinuxJob({
        ...f.spec,
        locations: [{ fd: f.spec.delegatedCgroup.fd, target: "/data", writable: false }],
      }),
    ).rejects.toThrow("mount-tree-depth-limit");
  } finally {
    f.close();
  }
});

// Dedicated read-only fixture containing an otherwise empty directory with one
// descendant bind/tmpfs mount; its setup belongs to the external Linux harness.
const mountTreePath = process.env.MANIFOLD_TEST_MOUNT_TREE;
test.skipIf(!mountTreePath)("recursive bind preflight refuses a descendant mount", () => {
  const f = fixture();
  const tree = HeldDirectory.openAbsolute(mountTreePath!);
  try {
    expect(() =>
      preflightLinuxJob({
        ...f.spec,
        runtime: [{ fd: tree.fd, target: "/runtime", writable: false }],
      }),
    ).toThrow("mount-tree-crossing");
  } finally {
    tree.close();
    f.close();
  }
});

// Explicit, disposable integration prerequisites: static BusyBox (one pinned runtime bind),
// bubblewrap supporting --bind-fd, and an empty writable v2 delegation with +cpu +memory +pids.
// No fallback, host shell, credentials, daemon, package installation or network is used.
const bwrapPath = process.env.MANIFOLD_TEST_BWRAP;
const busyboxPath = process.env.MANIFOLD_TEST_STATIC_BUSYBOX;
const cgroupPath = process.env.MANIFOLD_TEST_CGROUP;
const realLinux = process.platform === "linux" && !!bwrapPath && !!busyboxPath && !!cgroupPath;
// External disposable namespace fixture: tmpfs size=65536,nr_inodes=4096,mode=0700.
// Run this suite inside the namespace that mounted it; never mount on a live location.
const outputRoot = process.env.MANIFOLD_TEST_OUTPUT_ROOT;
// Compile test/fixtures/job-syscall-probe.c statically for this machine; not a runtime tool.
const syscallProbe = process.env.MANIFOLD_TEST_SYSCALL_PROBE;
// Compile test/fixtures/job-listener-probe.c statically in the disposable harness.
const listenerProbe = process.env.MANIFOLD_TEST_LISTENER_PROBE;

async function withLinux(
  script: string,
  run: (spec: LinuxJobSpec) => Promise<void>,
): Promise<void> {
  const bubblewrapFd = openSync(bwrapPath!, constants.O_RDONLY | constants.O_NOFOLLOW);
  const busyboxFd = openSync(busyboxPath!, constants.O_RDONLY | constants.O_NOFOLLOW);
  const staging = mkdtempSync(join(tmpdir(), "job-linux-real-"));
  writeFileSync(join(staging, "program"), `#!/bin/busybox sh\n${script}\n`, { mode: 0o500 });
  const artifactFd = openSync(join(staging, "program"), constants.O_RDONLY | constants.O_NOFOLLOW);
  const delegatedCgroup = HeldDirectory.openAbsolute(cgroupPath!);
  try {
    await run({
      bubblewrapFd,
      artifactFd,
      delegatedCgroup,
      argv: [],
      runtime: [{ fd: busyboxFd, target: "/bin/busybox", writable: false }],
      locations: [],
      outputs: [],
      network: "none",
      bidirectional: true,
      nestedCgroup: true,
      limits: { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024, processes: 16, outputBytes: 4096 },
    });
  } finally {
    closeSync(artifactFd);
    closeSync(busyboxFd);
    closeSync(bubblewrapFd);
    delegatedCgroup.close();
    rmSync(staging, { recursive: true });
  }
}

test.skipIf(!realLinux)(
  "real sandbox has no ambient home, runtime fd or enrollment environment and roundtrips private input",
  async () => {
    await withLinux(
      'test "$HOME" = /home/job && test "$XDG_DATA_HOME" = /home/job/.local/share && test "$XDG_RUNTIME_DIR" = /home/job/.run && test -z "$MANIFOLD_MACHINE_TOKEN" && test ! -e /etc/passwd && test ! -e /proc/self/fd/6 && test ! -e "$HOME/.ssh" && test ! -e "$HOME/private" || exit 70; for directory in "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"; do printf private > "$directory/private" || exit 71; test "$(/bin/busybox stat -f -c %T "$directory")" = tmpfs || exit 72; done; test "$(/bin/busybox stat -c %a "$XDG_RUNTIME_DIR")" = 700 || exit 73; if ( printf forbidden > /job/ambient ) 2>/dev/null; then exit 74; fi; printf scratch > /tmp/private && read line && printf "%s" "$line"',
      async (spec) => {
        const frames: { sequence: number; text: string }[] = [];
        const handle = await startLinuxJob({
          ...spec,
          onOutput: (frame) =>
            frames.push({ sequence: frame.sequence, text: Buffer.from(frame.bytes).toString() }),
        });
        await handle.input(Buffer.from("private-roundtrip\n"));
        handle.endInput();
        const result = await handle.result;
        handle.release();
        expect(result.exitCode).toBe(0);
        expect(result.empty).toBe(true);
        expect(frames.map((frame) => frame.text).join("")).toBe("private-roundtrip");
        expect(frames.map((frame) => frame.sequence)).toEqual(frames.map((_, index) => index + 1));
        const second = await startLinuxJob(spec);
        await second.input(Buffer.from("isolated-home\n"));
        second.endInput();
        const secondResult = await second.result;
        second.release();
        expect(secondResult.exitCode).toBe(0);
      },
    );
  },
);

test.skipIf(!realLinux)(
  "native PTY keeps input, resize and snapshots outside job output storage",
  async () => {
    await withLinux(
      'test -t 0 && test -t 1 && test -t 2 || exit 71; test "$TERM" = xterm-256color || exit 72; test -z "$MANIFOLD_JOB_OWNER_SOCKET$MANIFOLD_MACHINE_TOKEN" || exit 73; printf ready; read line; /bin/busybox stty size; printf "received:%s" "$line"; while :; do /bin/busybox sleep 1; done',
      async (spec) => {
        let text = "";
        let journalFrames = 0;
        const ready = Promise.withResolvers<void>();
        const received = Promise.withResolvers<void>();
        const terminal = new PtyTerminal({
          terminalId: "native-pty",
          cols: 80,
          rows: 24,
          onOutput(output) {
            text += Buffer.from(output.bytes).toString();
            if (text.includes("ready")) ready.resolve();
            if (text.includes("received:roundtrip")) received.resolve();
          },
          runtime: (pty) =>
            startLinuxJob({
              ...spec,
              terminal: pty,
              onOutput: () => {
                journalFrames++;
              },
            }),
        });
        const handle = await terminal.runtimeHandle!;
        try {
          await Promise.race([
            ready.promise,
            handle.result.then(() => {
              throw new Error("PTY exited before ready");
            }),
          ]);
          terminal.resize(100, 40);
          terminal.write("roundtrip\n");
          await Promise.race([
            received.promise,
            handle.result.then(() => {
              throw new Error("PTY exited before input");
            }),
          ]);
          expect(text).toContain("40 100");
          const snapshot = await terminal.snapshot();
          expect(Buffer.from(snapshot.data).toString()).toContain("received:roundtrip");
          expect(journalFrames).toBe(0);
          await terminal.kill();
          const result = await handle.result;
          expect(result.reason).toBe("cancelled");
          expect(result.empty).toBe(true);
          expect(result.usage.outputBytes).toBe(Buffer.byteLength(text));
          expect(terminal.alive).toBe(false);
        } finally {
          await handle.cancel();
          handle.release();
          terminal.dispose();
        }
      },
    );
  },
);

test.skipIf(!realLinux)(
  "native PTY meters cumulative bytes before delivery without persisting terminal output",
  async () => {
    await withLinux(
      'printf ready; read line; while :; do printf "0123456789abcdef"; done',
      async (spec) => {
        let delivered = 0;
        let journalFrames = 0;
        const ready = Promise.withResolvers<void>();
        const terminal = new PtyTerminal({
          terminalId: "native-pty-overflow",
          cols: 80,
          rows: 24,
          onOutput(output) {
            delivered += output.bytes.byteLength;
            ready.resolve();
          },
          runtime: (pty) =>
            startLinuxJob({
              ...spec,
              terminal: pty,
              limits: { ...spec.limits, outputBytes: 128 },
              onOutput: () => {
                journalFrames++;
              },
            }),
        });
        const handle = await terminal.runtimeHandle!;
        try {
          await Promise.race([
            ready.promise,
            handle.result.then(() => {
              throw new Error("PTY exited before overflow");
            }),
          ]);
          terminal.write("go\n");
          const result = await handle.result;
          await terminal.exited;
          expect(result.reason).toBe("output-limit");
          expect(result.empty).toBe(true);
          expect(result.usage.outputBytes).toBeGreaterThan(128);
          expect(delivered).toBeLessThanOrEqual(128);
          expect(terminal.ringBytes).toBe(delivered);
          expect(journalFrames).toBe(0);
        } finally {
          await handle.cancel();
          handle.release();
          terminal.dispose();
        }
      },
    );
  },
);

test.skipIf(!realLinux)(
  "native PTY delivery failure cancels its workload instead of escaping the owner",
  async () => {
    await withLinux(
      "printf ready; read line; printf rejected; while :; do /bin/busybox sleep 1; done",
      async (spec) => {
        const ready = Promise.withResolvers<void>();
        let rejectOutput = false;
        const terminal = new PtyTerminal({
          terminalId: "native-pty-consumer",
          cols: 80,
          rows: 24,
          onOutput() {
            if (rejectOutput) throw new Error("transport unavailable");
            ready.resolve();
          },
          runtime: (pty) => startLinuxJob({ ...spec, terminal: pty }),
        });
        const handle = await terminal.runtimeHandle!;
        try {
          await Promise.race([
            ready.promise,
            handle.result.then(() => {
              throw new Error("PTY exited before delivery");
            }),
          ]);
          rejectOutput = true;
          terminal.write("go\n");
          const result = await handle.result;
          await terminal.exited;
          expect(result.reason).toBe("output-consumer");
          expect(result.empty).toBe(true);
        } finally {
          await handle.cancel();
          handle.release();
          terminal.dispose();
        }
      },
    );
  },
);

test.skipIf(!realLinux)(
  "selected runtime executable reads exact readonly native config instead of running the primary worker",
  async () => {
    await withLinux("exit 91", async (spec) => {
      const fd = privateByteFile(Buffer.from("private-native-config\n"));
      const frames: string[] = [];
      try {
        const handle = await startLinuxJob({
          ...spec,
          runtime: [
            ...spec.runtime,
            { fd: spec.runtime[0]!.fd, target: "/runtime/bin/busybox", writable: false },
          ],
          executableRuntimeTool: "busybox",
          argv: [
            "sh",
            "-c",
            "if ( printf changed > /inputs/config ) 2>/dev/null; then exit 92; fi; /runtime/bin/busybox cat /inputs/config",
          ],
          inputFiles: [{ fd, target: "/inputs/config", writable: false }],
          onOutput: (frame) => {
            if (frame.channel === "stdout") frames.push(Buffer.from(frame.bytes).toString());
          },
        });
        handle.endInput();
        const result = await handle.result;
        handle.release();
        expect(result.exitCode).toBe(0);
        expect(result.empty).toBe(true);
        expect(frames.join("")).toBe("private-native-config\n");
      } finally {
        closeSync(fd);
      }
    });
  },
);

test.skipIf(!realLinux)(
  "sealed private-home config is readonly while adjacent home files remain writable",
  async () => {
    await withLinux(
      [
        'test "$HOME" = /home/job && test "$PWD" = "$HOME" && test "$(pwd)" = "$HOME" || exit 80',
        "test ! -e .config/omp/session && test ! -e private || exit 85",
        'test "$(/bin/busybox cat /home/job/.config/omp/auth.json)" = sealed || exit 81',
        "if ( printf substituted > /home/job/.config/omp/auth.json ) 2>/dev/null; then exit 82; fi",
        "if /bin/busybox chmod 600 .config/omp/auth.json 2>/dev/null; then exit 86; fi",
        "printf writable > .config/omp/session || exit 83",
        "printf home > private || exit 84",
        "/bin/busybox cat .config/omp/auth.json .config/omp/session private",
      ].join("\n"),
      async (spec) => {
        const fd = privateByteFile(Buffer.from("sealed"));
        const frames: string[] = [];
        try {
          // Reuse the same sealed descriptor: launch must neither consume its offset nor
          // carry adjacent private-home files into the next sandbox.
          for (let launch = 0; launch < 2; launch++) {
            frames.length = 0;
            const handle = await startLinuxJob({
              ...spec,
              inputFiles: [{ fd, target: "/home/job/.config/omp/auth.json", writable: false }],
              onOutput: (frame) => {
                if (frame.channel === "stdout") frames.push(Buffer.from(frame.bytes).toString());
              },
            });
            try {
              handle.endInput();
              const result = await handle.result;
              expect(result.exitCode).toBe(0);
              expect(result.empty).toBe(true);
              expect(frames.join("")).toBe("sealedwritablehome");
            } finally {
              await handle.cancel();
              handle.release();
            }
          }
        } finally {
          closeSync(fd);
        }
      },
    );
  },
);

interface ListeningJob {
  handle: LinuxJobHandle;
  port: number;
  closed: Promise<void>;
}

async function listeningJob(
  spec: LinuxJobSpec,
  mode: "loopback" | "wildcard" | "nested" | "http" | "deferred",
): Promise<ListeningJob> {
  const fd = openSync(listenerProbe!, constants.O_RDONLY | constants.O_NOFOLLOW);
  const ready = Promise.withResolvers<number>();
  const closed = Promise.withResolvers<void>();
  let output = "";
  let handle: LinuxJobHandle;
  try {
    handle = await startLinuxJob({
      ...spec,
      network: "host",
      runtime: [...spec.runtime, { fd, target: "/runtime/bin/listener-probe", writable: false }],
      executableRuntimeTool: "listener-probe",
      argv: [mode],
      onOutput: (frame) => {
        if (frame.channel !== "stdout") return;
        output += Buffer.from(frame.bytes).toString();
        const match = /^port:(\d+)\n/.exec(output);
        if (match) ready.resolve(Number(match[1]));
        if (output.includes("\nclosed\n")) closed.resolve();
      },
    });
  } finally {
    closeSync(fd);
  }
  try {
    const port = await Promise.race([
      ready.promise,
      handle.result.then((result) => {
        throw new Error(`listener exited before readiness: ${JSON.stringify(result)}`);
      }),
    ]);
    return { handle, port, closed: closed.promise };
  } catch (error) {
    await handle.cancel();
    handle.release();
    throw error;
  }
}

test.skipIf(!realLinux || !listenerProbe)(
  "service providers reject deferred accept without changing ordinary jobs or sending unproved bytes",
  async () => {
    for (const providesService of [false, true]) {
      await withLinux("exit 91", async (spec) => {
        const { handle, port } = await listeningJob({ ...spec, providesService }, "deferred");
        let socket: Awaited<ReturnType<typeof connectWorkloadLoopback>> | undefined;
        try {
          const connection = connectWorkloadLoopback(
            port,
            (connected) => handle.ownsLoopbackConnection(connected),
            AbortSignal.timeout(3000),
          );
          if (!providesService) {
            await expect(connection).rejects.toThrow("service_connection_unproven");
            return;
          }
          socket = await connection;
          const response = await new Promise<string>((resolve, reject) => {
            let bytes = "";
            const timeout = setTimeout(
              () => reject(new Error("owned HTTP response timed out")),
              2000,
            );
            socket!.on("data", (chunk: Buffer) => {
              bytes += chunk.toString();
            });
            socket!.once("error", (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            socket!.once("end", () => {
              clearTimeout(timeout);
              resolve(bytes);
            });
            socket!.write(
              "POST /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
                "Authorization: Bearer listener-fixture-bearer-000000000000\r\n" +
                'Transfer-Encoding: chunked\r\n\r\ne\r\n{"probe":true}\r\n0\r\n\r\n',
            );
          });
          expect(response).toMatch(/^HTTP\/1\.1 200 /);
          expect(JSON.parse(response.split("\r\n\r\n", 2)[1]!)).toEqual({ received: true });
        } finally {
          socket?.destroy();
          await handle.cancel();
          handle.release();
        }
      });
    }
  },
);

test.skipIf(!realLinux || !listenerProbe).each(["loopback", "nested"] as const)(
  "kernel proof admits a live %s listener, not a foreign port or a closed/exited/released socket",
  async (mode) => {
    const foreign = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.listen(0, "127.0.0.1", resolve);
      });
      const address = foreign.address();
      if (!address || typeof address === "string") throw new Error("missing foreign port");
      await withLinux("exit 91", async (spec) => {
        const { handle, port, closed } = await listeningJob(spec, mode);
        try {
          expect(handle.ownsLoopbackListener(address.port)).toBe(false);
          expect(handle.ownsLoopbackListener(port)).toBe(true);
          expect(handle.ownsLoopbackListener(NaN)).toBe(false);
          await handle.input(Buffer.from("c"));
          await Promise.race([
            closed,
            handle.result.then(() => {
              throw new Error("listener exited before close");
            }),
          ]);
          expect(handle.ownsLoopbackListener(port)).toBe(false);
          handle.endInput();
          expect((await handle.result).exitCode).toBe(0);
          expect(handle.ownsLoopbackListener(port)).toBe(false);
          handle.release();
          expect(handle.ownsLoopbackListener(port)).toBe(false);
        } finally {
          await handle.cancel();
          handle.release();
        }
      });
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  },
);

test.skipIf(!realLinux || !listenerProbe)(
  "scoped runtime HTTP uses the proved connection and refuses a live runtime's rebound port",
  async () => {
    await withLinux("exit 91", async (spec) => {
      const { handle, port, closed } = await listeningJob(spec, "http");
      let exited = false;
      void handle.result.then(() => {
        exited = true;
      });
      let connections = 0;
      let foreignBytes = 0;
      const foreignClosed = Promise.withResolvers<void>();
      const foreign = createServer((socket) => {
        connections++;
        socket.on("data", (bytes: Buffer) => {
          foreignBytes += bytes.length;
        });
        socket.on("error", () => socket.destroy());
        socket.once("close", foreignClosed.resolve);
      });
      let proxy: JobServiceProxy | undefined;
      let accepting: Promise<void> | undefined;
      let dropProvedConnection = false;
      const lifetime = new AbortController();
      try {
        expect(handle.ownsLoopbackListener(port)).toBe(true);
        proxy = await createJobServiceProxy({
          policies: [
            {
              serviceId: "listener",
              revision: "r1",
              maxConcurrent: 1,
              runtime: {
                pluginId: "fixture",
                operationId: "serve",
                installationRevision: "r1",
                artifactSha256: "a".repeat(64),
                resourceBindingDigest: "b".repeat(64),
                input: {},
              },
              operations: {
                probe: {
                  kind: "http-proxy",
                  method: "POST",
                  path: "/probe",
                  request: { kind: "json", disclosure: "full" },
                  response: {
                    kind: "stream",
                    disclosure: "full",
                    contentTypes: ["application/json"],
                    headers: [],
                  },
                  timeoutMs: 2000,
                  maxRequestBytes: 4096,
                  maxResponseBytes: 4096,
                },
              },
            },
          ],
          bindings: [{ serviceId: "listener", revision: "r1", operationIds: ["probe"] }],
          authorize: async () => true,
          resolveRuntime: async (_policy, signal) => {
            const socket = await connectWorkloadLoopback(
              port,
              (connected) => {
                const owned = handle.ownsLoopbackConnection(connected);
                if (!accepting) {
                  // The fixture intentionally delays accept until after the first proof
                  // observation. Connectivity alone cannot authorize application bytes.
                  expect(owned).toBe(false);
                  accepting = handle.input(Buffer.from("a"));
                }
                return owned;
              },
              signal,
            );
            if (dropProvedConnection) {
              dropProvedConnection = false;
              const disconnected = new Promise<void>((resolve) => socket.once("close", resolve));
              await handle.input(Buffer.from("c"));
              await closed;
              socket.destroy();
              await disconnected;
              await new Promise<void>((resolve, reject) => {
                foreign.once("error", reject);
                foreign.listen(port, "127.0.0.1", resolve);
              });
            }
            return {
              url: `http://127.0.0.1:${port}`,
              bearer: "listener-fixture-bearer-000000000000",
              signal: lifetime.signal,
              socket,
            };
          },
        });
        const send = () =>
          new Promise<{ status: number; body: string }>((resolve, reject) => {
            const outgoing = httpRequest(
              `${proxy!.url}/probe`,
              {
                method: "POST",
                agent: false,
                headers: {
                  authorization: `Bearer ${proxy!.bearer}`,
                  "content-type": "application/json",
                },
              },
              (incoming) => {
                let body = "";
                incoming.on("data", (bytes: Buffer) => {
                  body += bytes.toString();
                });
                incoming.once("error", reject);
                incoming.once("end", () => resolve({ status: incoming.statusCode!, body }));
              },
            );
            outgoing.once("error", reject);
            outgoing.end('{"probe":true}');
          });
        // The fixture only responds after receiving the exact synthetic bearer/body.
        expect(await send()).toEqual({ status: 200, body: '{"received":true}' });
        await accepting;
        dropProvedConnection = true;
        expect((await send()).status).toBe(503);
        expect(connections).toBe(0); // A lost proved socket must never trigger a new dial.
        expect(exited).toBe(false);
        expect((await send()).status).toBeGreaterThanOrEqual(400);
        await foreignClosed.promise;
        expect(connections).toBe(1); // Exactly one credential-free TCP proof attempt.
        expect(foreignBytes).toBe(0);
        expect(exited).toBe(false); // Cached readiness still refers to a live job.
        handle.endInput();
        expect((await handle.result).exitCode).toBe(0);
      } finally {
        lifetime.abort();
        await proxy?.close();
        await new Promise<void>((resolve) => foreign.close(() => resolve()));
        await handle.cancel();
        handle.release();
      }
    });
  },
);

test.skipIf(!realLinux || !listenerProbe)(
  "wildcard and separately admitted child listeners cannot prove parent ownership",
  async () => {
    await withLinux("exit 91", async (spec) => {
      const parent = await listeningJob(spec, "loopback");
      let child: ListeningJob | undefined;
      let wildcard: ListeningJob | undefined;
      try {
        child = await listeningJob(
          { ...spec, delegatedCgroup: parent.handle.childDelegation },
          "loopback",
        );
        expect(child.handle.ownsLoopbackListener(child.port)).toBe(true);
        expect(parent.handle.ownsLoopbackListener(child.port)).toBe(false);
        expect(child.handle.ownsLoopbackListener(parent.port)).toBe(false);
        wildcard = await listeningJob(spec, "wildcard");
        expect(wildcard.handle.ownsLoopbackListener(wildcard.port)).toBe(false);
        expect(parent.handle.ownsLoopbackListener(parent.port)).toBe(true);
      } finally {
        if (wildcard) {
          await wildcard.handle.cancel();
          wildcard.handle.release();
        }
        if (child) {
          await child.handle.cancel();
          child.handle.release();
        }
        await parent.handle.cancel();
        parent.handle.release();
      }
    });
  },
);
test.skipIf(!realLinux)(
  "whole-tree cancellation drains a descendant moved into a nested cgroup",
  async () => {
    const ready = Promise.withResolvers<void>();
    const frames: { channel: string; text: string }[] = [];
    await withLinux(
      [
        'root="$MANIFOLD_JOB_CGROUP_ROOT"',
        'test -z "$(/bin/busybox cat "$root/cgroup.procs")" || exit 18',
        'for entry in "$root"/*; do test ! -d "$entry" || exit 19; done',
        'for controller in cpu memory pids; do case " $(/bin/busybox cat "$root/cgroup.controllers") " in *" $controller "*) ;; *) exit 22 ;; esac; done',
        'for outside in "$root/../cgroup.procs" "$root/../main/cgroup.procs" "$root/../../cgroup.procs"; do test ! -e "$outside" || exit 23; if ( printf "%s" "$$" > "$outside" ) 2>/dev/null; then exit 24; fi; done',
        '/bin/busybox mkdir "$root/worker" || exit 20',
        "( while :; do :; done ) & child=$!",
        'echo "$child" > "$root/worker/cgroup.procs" || exit 21',
        "printf ready; wait",
      ].join("\n"),
      async (spec) => {
        const handle = await startLinuxJob({
          ...spec,
          onOutput: (frame) => {
            frames.push({ channel: frame.channel, text: Buffer.from(frame.bytes).toString() });
            if (Buffer.from(frame.bytes).toString().includes("ready")) ready.resolve();
          },
        });
        try {
          await Promise.race([
            ready.promise,
            handle.result.then((result) => {
              throw new Error(
                `workload exited before nested cgroup ready: ${JSON.stringify({ result, frames })}`,
              );
            }),
          ]);
          const result = await handle.cancel();
          expect(result.reason).toBe("cancelled");
          expect(result.empty).toBe(true);
          expect(await handle.cancel()).toBe(result);
        } finally {
          await handle.cancel();
          handle.release();
        }
      },
    );
  },
);

test.skipIf(!realLinux)(
  "stdout overflow is explicit and cannot publish a successful result",
  async () => {
    await withLinux('while :; do printf "0123456789abcdef"; done', async (spec) => {
      let delivered = 0;
      const handle = await startLinuxJob({
        ...spec,
        limits: { ...spec.limits, outputBytes: 128 },
        onOutput: (frame) => {
          delivered += frame.bytes.byteLength;
        },
      });
      const result = await handle.result;
      handle.release();
      expect(result.reason).toBe("output-limit");
      expect(result.empty).toBe(true);
      expect(delivered).toBeLessThanOrEqual(128);
      expect(result.usage.outputBytes).toBeGreaterThan(128);
    });
  },
);

test.skipIf(!realLinux)(
  "parent cancellation contains separately admitted child jobs under its aggregate group",
  async () => {
    await withLinux("printf ready; while :; do :; done", async (spec) => {
      const parentReady = Promise.withResolvers<void>();
      const childReady = Promise.withResolvers<void>();
      const parent = await startLinuxJob({ ...spec, onOutput: () => parentReady.resolve() });
      let child: LinuxJobHandle | undefined;
      try {
        await Promise.race([
          parentReady.promise,
          parent.result.then(() => {
            throw new Error("parent exited before ready");
          }),
        ]);
        child = await startLinuxJob({
          ...spec,
          delegatedCgroup: parent.childDelegation,
          onOutput: () => childReady.resolve(),
        });
        await Promise.race([
          childReady.promise,
          child.result.then(() => {
            throw new Error("child exited before ready");
          }),
        ]);
        const result = await parent.cancel();
        expect(result.empty).toBe(true);
        expect(result.usage.processesPeak).toBeGreaterThanOrEqual(4);
        expect((await child.result).empty).toBe(true);
      } finally {
        await parent.cancel();
        if (child) {
          await child.cancel();
          child.release();
        }
        parent.release();
      }
    });
  },
);

test.skipIf(!realLinux)(
  "retirement retains a live delegated workload after leader exit until explicit cancellation",
  async () => {
    await withLinux("printf ready; read finish; printf leaving", async (spec) => {
      const retirement = new AbortController();
      const parentReady = Promise.withResolvers<void>();
      const leaderLeaving = Promise.withResolvers<void>();
      const childReady = Promise.withResolvers<void>();
      let parentOutput = "";
      const parent = await startLinuxJob({
        ...spec,
        persistentService: true,
        retirementSignal: retirement.signal,
        limits: { ...spec.limits, timeoutMs: 0 },
        onOutput: (frame) => {
          parentOutput += Buffer.from(frame.bytes).toString();
          if (parentOutput.includes("ready")) parentReady.resolve();
          if (parentOutput.includes("leaving")) leaderLeaving.resolve();
        },
      });
      let child: LinuxJobHandle | undefined;
      try {
        await Promise.race([
          parentReady.promise,
          parent.result.then(() => {
            throw new Error("parent exited before ready");
          }),
        ]);
        child = await startLinuxJob({
          ...spec,
          persistentService: true,
          limits: { ...spec.limits, timeoutMs: 0 },
          delegatedCgroup: parent.childDelegation,
          onOutput: () => childReady.resolve(),
        });
        await Promise.race([
          childReady.promise,
          child.result.then(() => {
            throw new Error("child exited before ready");
          }),
        ]);
        retirement.abort();
        await parent.input(Buffer.from("finish\n"));
        await leaderLeaving.promise;
        // Longer than the forced-empty proof deadline: cooperative waiting has none.
        // Real kernel process exit/cgroup polling cannot be advanced with JS fake timers.
        await Promise.race([
          Bun.sleep(10_500),
          parent.result.then(() => {
            throw new Error("retirement abandoned live descendants");
          }),
          child.result.then(() => {
            throw new Error("retirement killed a delegated workload");
          }),
        ]);
        expect((await parent.cancel()).reason).toBe("cancelled");
        expect((await child.result).empty).toBe(true);
      } finally {
        await parent.cancel();
        if (child) {
          await child.cancel();
          child.release();
        }
        parent.release();
      }
    });
  },
  20_000,
);

test.skipIf(!realLinux || !outputRoot)(
  "named output storage returns ENOSPC during writes while the output-only child is still alive",
  async () => {
    const path = mkdtempSync(join(outputRoot!, "budget-"));
    const directory = HeldDirectory.openAbsolute(path);
    const ready = Promise.withResolvers<void>();
    try {
      await withLinux(
        '/bin/busybox dd if=/dev/zero of=/outputs/result/oversized bs=4096 count=64 2>/tmp/error; status=$?; test "$status" -ne 0 || exit 41; printf bounded; read line; test "$line" = release',
        async (spec) => {
          const handle = await startLinuxJob({
            ...spec,
            outputs: [{ fd: directory.fd, target: "/outputs/result", writable: true }],
            limits: { ...spec.limits, outputBytes: 128 * 1024 },
            onOutput: (frame) => {
              if (Buffer.from(frame.bytes).toString().includes("bounded")) ready.resolve();
            },
          });
          try {
            await Promise.race([
              ready.promise,
              handle.result.then(() => {
                throw new Error("child exited without observing the write-time storage bound");
              }),
            ]);
            const fd = directory.openFile("oversized");
            try {
              expect(fstatSync(fd).size).toBeGreaterThan(0);
              expect(fstatSync(fd).size).toBeLessThanOrEqual(65536);
            } finally {
              closeSync(fd);
            }
            await handle.input(Buffer.from("release\n"));
            handle.endInput();
            expect((await handle.result).exitCode).toBe(0);
          } finally {
            await handle.cancel();
            handle.release();
          }
        },
      );
    } finally {
      directory.close();
      rmSync(path, { recursive: true });
    }
  },
);

test.skipIf(!realLinux || !outputRoot)(
  "bounded child output remains writable by its live parent and seals only after handoff closes",
  async () => {
    const path = mkdtempSync(join(outputRoot!, "handoff-"));
    const directory = HeldDirectory.openAbsolute(path);
    const privatePath = mkdtempSync(join(tmpdir(), "handoff-store-"));
    const privateDirectory = HeldDirectory.openAbsolute(privatePath, { private: true });
    const store = JobOutputStore.open(privateDirectory);
    const releaseParent = store.retainWriter(directory.fd);
    try {
      await withLinux(
        'read line; test "$line" = child-exited || exit 42; test "$(/bin/busybox cat /shared/handoff/value)" = child || exit 43; printf -- "-parent" >> /shared/handoff/value; printf acknowledged; read line; test "$line" = release',
        async (parentSpec) => {
          const acknowledged = Promise.withResolvers<void>();
          const parent = await startLinuxJob({
            ...parentSpec,
            locations: [{ fd: directory.fd, target: "/shared", writable: true }],
            onOutput: (frame) => {
              if (Buffer.from(frame.bytes).toString().includes("acknowledged"))
                acknowledged.resolve();
            },
          });
          const lease = store.create(
            "child",
            { name: "result", locationId: "fixture.shared", components: ["handoff"] },
            directory,
            128 * 1024,
          );
          const releaseChild = store.retainWriter(lease.directory.fd);
          let sealed = false;
          try {
            await withLinux("printf child > /outputs/result/value", async (childSpec) => {
              const child = await startLinuxJob({
                ...childSpec,
                outputs: [{ fd: lease.directory.fd, target: "/outputs/result", writable: true }],
                delegatedCgroup: parent.childDelegation,
                limits: { ...childSpec.limits, outputBytes: 128 * 1024 },
              });
              try {
                expect((await child.result).exitCode).toBe(0);
              } finally {
                await child.cancel();
                child.release();
              }
            });
            releaseChild();
            expect(() => store.seal(lease, { workloadEmpty: true, writersReleased: true })).toThrow(
              "output_writers_active",
            );
            await parent.input(Buffer.from("child-exited\n"));
            await Promise.race([
              acknowledged.promise,
              parent.result.then(() => {
                throw new Error("parent exited before consuming its child output");
              }),
            ]);
            expect(() => store.seal(lease, { workloadEmpty: true, writersReleased: true })).toThrow(
              "output_writers_active",
            );
            await parent.input(Buffer.from("release\n"));
            parent.endInput();
            expect((await parent.result).exitCode).toBe(0);
            releaseParent();
            await store.waitForWriters([lease]);
            const output = store.seal(lease, { workloadEmpty: true, writersReleased: true });
            sealed = true;
            expect(store.read("child", output.outputId, 512, 12).data.toString()).toBe(
              "child-parent",
            );
          } finally {
            releaseChild();
            await parent.cancel();
            parent.release();
            releaseParent();
            if (!sealed) store.abort(lease);
          }
        },
      );
    } finally {
      releaseParent();
      store.close();
      privateDirectory.close();
      directory.close();
      rmSync(privatePath, { recursive: true });
      rmSync(path, { recursive: true });
    }
  },
);

test.skipIf(!realLinux || !syscallProbe)(
  "host-network DNS resolves both address families without descriptor-export syscalls",
  async () => {
    const dns = createSocket("udp4");
    const ready = Promise.withResolvers<void>();
    dns.on("error", ready.reject);
    dns.on("message", (query, peer) => {
      const name = Buffer.from("\x0anative-dns\x04test\x00");
      const questionEnd = 12 + name.length + 4;
      if (
        query.length < questionEnd ||
        query.readUInt16BE(4) !== 1 ||
        !query.subarray(12, 12 + name.length).equals(name) ||
        query.readUInt16BE(questionEnd - 2) !== 1
      )
        return;
      const type = query.readUInt16BE(questionEnd - 4);
      const address =
        type === 1
          ? Buffer.from([192, 0, 2, 10])
          : type === 28
            ? Buffer.from("20010db8000000000000000000000010", "hex")
            : null;
      if (!address) return;
      const response = Buffer.alloc(questionEnd + 12 + address.length);
      query.copy(response, 0, 0, questionEnd);
      response.writeUInt16BE(0x8180, 2);
      response.writeUInt16BE(1, 6);
      response.writeUInt16BE(0, 8);
      response.writeUInt16BE(0, 10);
      response.writeUInt16BE(0xc00c, questionEnd);
      response.writeUInt16BE(type, questionEnd + 2);
      response.writeUInt16BE(1, questionEnd + 4);
      response.writeUInt32BE(60, questionEnd + 6);
      response.writeUInt16BE(address.length, questionEnd + 10);
      address.copy(response, questionEnd + 12);
      dns.send(response, peer.port, peer.address);
    });
    dns.bind(0, "127.0.0.1", ready.resolve);
    await ready.promise;
    let fd = -1;
    try {
      fd = openSync(syscallProbe!, constants.O_RDONLY | constants.O_NOFOLLOW);
      await withLinux("", async (spec) => {
        let text = "";
        const handle = await startLinuxJob({
          ...spec,
          artifactFd: fd,
          argv: ["dns", String(dns.address().port)],
          network: "host",
          onOutput: (frame) => {
            text += Buffer.from(frame.bytes).toString();
          },
        });
        try {
          expect((await handle.result).exitCode).toBe(0);
          expect(text.trim().split("\n").sort()).toEqual(["192.0.2.10", "2001:db8::10"]);
        } finally {
          await handle.cancel();
          handle.release();
        }
      });
    } finally {
      if (fd >= 0) closeSync(fd);
      await new Promise<void>((resolve) => dns.close(resolve));
    }
  },
);

test.skipIf(!realLinux || !syscallProbe)(
  "seccomp refuses SCM_RIGHTS and io_uring exports while preserving byte socket context",
  async () => {
    const fd = openSync(syscallProbe!, constants.O_RDONLY | constants.O_NOFOLLOW);
    const context = privateSocketPair();
    let contextBytes = "";
    context.socket.on("error", () => {});
    context.socket.on("data", (bytes: Buffer) => {
      contextBytes += bytes.toString();
      if (contextBytes === "context-byte") context.socket.write("a");
    });
    try {
      await withLinux("", async (spec) => {
        let text = "";
        const handle = await startLinuxJob({
          ...spec,
          artifactFd: fd,
          contextFd: context.childFd,
          onOutput: (output) => {
            text += Buffer.from(output.bytes).toString();
          },
        });
        try {
          expect((await handle.result).exitCode).toBe(0);
          expect(text).toBe("fd-export-denied;byte-context-ok\n");
          expect(contextBytes).toBe("context-byte");
        } finally {
          await handle.cancel();
          handle.release();
        }
      });
    } finally {
      closeSync(fd);
      closeSync(context.childFd);
      context.socket.destroy();
    }
  },
);
