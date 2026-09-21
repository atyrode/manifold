import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  formatManifoldUri,
  JobEventSchema,
  JobDescriptionSchema,
  JobResultSchema,
  ListJobRunsResultSchema,
  PublicJobSchema,
  MachineHalfSchema,
  PluginBundleSchema,
  type Cap,
  type ManifoldRef,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  isMachineOnline,
  ownerAction,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  attachedCapture,
  e2eFailure,
  nextMessage,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PLUGIN = "fixture.jobs";
const OPERATION = `${PLUGIN}.run`;
const PRODUCE = `${PLUGIN}.produce`;
const TERMINAL = `${PLUGIN}.terminal`;
const LIMITED_TERMINAL = `${PLUGIN}.limited`;
const LOCATION = `${PLUGIN}.witness`;

const required = [
  "MANIFOLD_TEST_BWRAP",
  "MANIFOLD_TEST_STATIC_BUSYBOX",
  "MANIFOLD_TEST_CGROUP",
  "MANIFOLD_TEST_OUTPUT_ROOT",
] as const;
const realBackend =
  process.platform === "linux" && required.every((name) => Boolean(process.env[name]));

// The ordinary cross-platform gate skips unavailable Linux fixtures. Mandatory verify:jobs
// provisions a private delegated unit and hard-fails missing prerequisites before running this.
// Run alone within that unit: no service/owner objects, forged messages, journal seeds or network overrides.
test.skipIf(!realBackend)(
  "[real-linux] real machine jobs enforce consent, execute once across transport replacement, and fence queued revocation; terminal sealed inputs survive restart and cleanup",
  async () => {
    const bubblewrap = realpathSync(process.env.MANIFOLD_TEST_BWRAP!);
    const busybox = realpathSync(process.env.MANIFOLD_TEST_STATIC_BUSYBOX!);
    const delegatedCgroup = realpathSync(process.env.MANIFOLD_TEST_CGROUP!);
    const root = mkdtempSync(join(tmpdir(), "manifold-jobs-e2e-"));
    const control = join(root, "control");
    const state = join(control, "state");
    const workspace = join(process.env.MANIFOLD_TEST_OUTPUT_ROOT!, basename(root));
    const witness = join(workspace, "witness");
    const runtime = join(root, "runtime");
    for (const path of [control, state, join(state, "artifacts"), workspace, witness, runtime])
      mkdirSync(path, { mode: 0o700 });
    const socket = join(control, "owner.sock");
    const config = join(control, "owner.json");
    const startsPath = join(witness, "starts");
    const starts = () =>
      existsSync(startsPath) ? readFileSync(startsPath, "utf8").trimEnd().split("\n") : [];
    let server: TestServer | undefined;
    let agent: TestAgent | undefined;
    let owner: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    let client: SessionClient | undefined;
    let home: SessionClient | undefined;
    const captures: TerminalCapture[] = [];
    try {
      server = await startServer({
        dataDir: join(control, "hub"),
        env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" },
      });
      const hub = server;
      const container = await createContainer(hub, "Job acceptance");
      const sdk = await connect(hub, { containerId: container.id, token: hub.ownerKey });
      client = sdk;
      const enrollment = await enrollMachine(hub, "jobs-acceptance");
      const machineId = enrollment.machineId;
      const limits = {
        timeoutMs: 30_000,
        memoryBytes: 128 * 1024 * 1024,
        processes: 32,
        outputBytes: 1024,
      };
      const materialLimits = { ...limits, outputBytes: 65536 };
      // The witness is a separately consented writable location, not a runtime test seam.
      // The transport-replacement workload appends on every executable start; the parent owns its gate.
      const executable = Buffer.from(
        [
          "#!/bin/busybox sh",
          'if test "$1" = terminal; then exec /bin/busybox sh; fi',
          'if test "$1" = produce-material; then',
          "  /bin/busybox mkdir -p /home/job/witness/material/nested /home/job/witness/decoy",
          "  printf 'selected material\\nsecond line\\n' > /home/job/witness/material/top.txt",
          "  printf 'nested selection\\n' > /home/job/witness/material/nested/inner.txt",
          "  printf 'not selected\\n' > /home/job/witness/decoy/top.txt",
          "  exit 0",
          "fi",
          'printf "%s\\n" "$1" >> /home/job/witness/starts',
          "while test ! -f /home/job/witness/release; do /bin/busybox sleep 0.02; done",
          'printf \'{"kind":"fixture.result/1","value":42}\\n\'',
          "printf diagnostic >&2",
          "exit 7",
          "",
        ].join("\n"),
      );
      const sha256 = createHash("sha256").update(executable).digest("hex");
      const machine = MachineHalfSchema.parse({
        artifacts: {
          [`linux-${process.arch}`]: {
            bundleFile: "worker",
            sha256,
            format: "raw",
            entry: ["fixture"],
            entrySha256: sha256,
            maxBytes: executable.length,
            maxExpandedBytes: executable.length,
            maxMembers: 1,
          },
        },
        locations: {
          [LOCATION]: {
            anchor: "data",
            components: ["witness"],
            revision: "r1",
            kind: "directory",
            guestPath: "/home/job/witness",
          },
        },
        operations: {
          [OPERATION]: {
            argv: [{ input: "label" }],
            input: { label: { type: "string", required: true, maxLength: 64 } },
            runtimeTools: ["busybox"],
            locations: [{ locationId: LOCATION, access: "write" }],
            outputs: [],
            network: "none",
            limits,
            stdin: false,
          },
          [PRODUCE]: {
            argv: [{ literal: "produce-material" }],
            input: {},
            runtimeTools: ["busybox"],
            locations: [{ locationId: LOCATION, access: "write" }],
            outputs: ["material", "decoy"],
            exports: ["material"],
            network: "none",
            limits: materialLimits,
            stdin: false,
          },
          [TERMINAL]: {
            argv: [{ literal: "terminal" }],
            input: {},
            runtimeTools: ["busybox"],
            locations: [],
            inputs: ["selected"],
            outputs: [],
            network: "none",
            limits: materialLimits,
            stdin: true,
          },
          [LIMITED_TERMINAL]: {
            argv: [{ literal: "terminal" }],
            input: {},
            runtimeTools: ["busybox"],
            locations: [],
            inputs: ["selected", "excess"],
            outputs: [],
            network: "none",
            limits: { ...limits, outputBytes: 4096 },
            stdin: true,
          },
        },
      });
      // Install a real pinned plugin manifest before its machine half: the hub requires equality
      // with a loaded declaration. This web-only module is never loaded by a browser.
      const bundle = Buffer.from(
        JSON.stringify(
          PluginBundleSchema.parse({
            format: 1,
            hardenedContract: 2,
            manifest: {
              id: PLUGIN,
              version: "1.0.0",
              title: "Job acceptance",
              description: "Private offline fixture",
              capabilities: [],
              contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
              entry: { web: "web.js" },
              machine,
            },
            files: {
              worker: executable.toString("base64"),
              "web.js": Buffer.from(
                `export default { id: ${JSON.stringify(PLUGIN)}, panels: {} };`,
              ).toString("base64"),
            },
          }),
        ),
      );
      const bundlePath = join(control, "fixture.json");
      writeFileSync(bundlePath, bundle, { mode: 0o600 });
      await ownerAction(hub, "engine.plugins.install", {
        source: bundlePath,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        hardened: true,
      });
      const installation = {
        machineId,
        pluginId: PLUGIN,
        installationRevision: "r1",
        artifactSha256: sha256,
      };
      await ownerAction(hub, "engine.jobs.install", { ...installation, machine });
      const operation: ManifoldRef = { kind: "operation", machineId, operationId: OPERATION };
      const location: ManifoldRef = { kind: "location", machineId, locationId: LOCATION };
      const consent = async (cap: Cap, enabled: boolean, node: ManifoldRef = operation) => {
        await ownerAction(hub, "engine.jobs.consent", {
          ...installation,
          cap,
          enabled,
          node: formatManifoldUri(node),
        });
      };
      const execute = async (jobId: string) => {
        const outcome = await sdk.action("engine.jobs.execute", {
          jobId,
          machineId,
          pluginId: PLUGIN,
          operationId: OPERATION,
          input: { label: jobId },
          outputs: [],
          limits,
        });
        if (!outcome.ok) throw new Error(`job action refused: ${outcome.denial.message}`);
        return PublicJobSchema.parse(outcome.result);
      };
      const node = (jobId: string, operationId = OPERATION) => ({
        kind: "job" as const,
        machineId,
        operationId,
        jobId,
      });
      const status = async (jobId: string, operationId = OPERATION) =>
        PublicJobSchema.parse(
          await ownerAction(hub, "engine.jobs.status", { node: node(jobId, operationId) }),
        );
      await consent("jobs:read", true);
      await consent("locations:write", true, location);
      expect((await execute("denied")).state).toBe("refused");
      expect(starts()).toEqual([]);

      // Queue while the enrolled machine is offline, revoke, THEN start the real owner/channel.
      // No races or sleeps decide whether revocation wins the pre-start boundary.
      await consent("machines:run", true);
      expect((await execute("revoked-before-start")).state).toBe("queued");
      await consent("machines:run", false);
      expect((await status("revoked-before-start")).state).toBe("queued");
      expect(starts()).toEqual([]);

      // Bootstrap the remote owner's verifier through ordinary authenticated inspection.
      const { admissionPublicKey } = JobDescriptionSchema.parse(
        await ownerAction(hub, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
      );
      writeFileSync(
        config,
        JSON.stringify({
          machineId,
          admissionPublicKey,
          stateDirectory: state,
          delegatedCgroup,
          bubblewrap,
          protectedDirectories: [control],
          anchors: { data: workspace, runtime },
          runtimeTools: { busybox: [{ source: busybox, target: "/bin/busybox", kind: "file" }] },
          artifactOrigins: ["https://example.invalid"],
        }),
        { mode: 0o600 },
      );
      owner = Bun.spawn([process.execPath, "packages/agent/src/main.ts", "--terminal-host"], {
        cwd: REPO,
        env: {
          ...process.env,
          MANIFOLD_JOB_OWNER_SOCKET: socket,
          MANIFOLD_JOB_OWNER_CONFIG: config,
          MANIFOLD_TERMINAL_HOST_SOCKET: `${socket}.terminal`,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const child = owner;
      await waitFor(
        () => {
          if (child.exitCode !== null)
            throw new Error(`real job owner exited before readiness: ${child.exitCode}`);
          return existsSync(socket) && existsSync(`${socket}.terminal`);
        },
        20_000,
        20,
      );
      agent = await startAgent({
        serverUrl: hub.url,
        machineToken: enrollment.machineToken,
        name: "jobs-acceptance",
        env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
        existingHost: { process: owner, socketPath: `${socket}.terminal` },
      });
      expect(agent.machineId).toBe(machineId);
      await waitFor(
        async () => (await status("revoked-before-start")).state === "refused",
        20_000,
        20,
      );
      expect(starts()).toEqual([]);
      // Re-enable cannot resurrect either permanently refused identity.
      await consent("machines:run", true);
      await execute("once");
      await waitFor(() => starts().includes("once"), 20_000, 20);
      expect(starts()).toEqual(["once"]);
      expect((await status("denied")).state).toBe("refused");
      expect((await status("revoked-before-start")).state).toBe("refused");

      // Deliver the same action identity again while the executable waits, then replace only
      // transport with SIGKILL. The job owner and workload must survive without a second start.
      await execute("once");
      await agent.restartTransport("SIGKILL");
      await waitFor(() => isMachineOnline(hub, machineId), 10_000, 20);
      await execute("once");
      expect(starts()).toEqual(["once"]);
      writeFileSync(join(witness, "release"), "release", { mode: 0o600 });
      const completed = await waitFor(
        async () => {
          const job = await status("once");
          if (job.state === "exited") return job;
          if (["refused", "interrupted", "cancelled"].includes(job.state))
            throw new Error(`real job failed: ${JSON.stringify(job.result)}`);
          return false;
        },
        20_000,
        20,
      );
      const result = JobResultSchema.parse(completed.result);
      expect(result.exitCode).toBe(7);
      expect(result.usage!.outputBytes).toBeLessThanOrEqual(limits.outputBytes);
      const readOutput = async (
        name: string,
        source = result,
        operationId = OPERATION,
        maxBytes = 8,
      ) => {
        const output = source.outputs.find((value) => value.name === name);
        if (!output) throw new Error(`missing sealed ${name}`);
        const chunks: Buffer[] = [];
        let offset = 0;
        for (let index = 0; index < 128; index++) {
          const event = JobEventSchema.parse(
            await ownerAction(hub, "engine.jobs.output", {
              node: {
                ...node(source.jobId, operationId),
                kind: "output",
                outputId: output.outputId,
              },
              offset,
              maxBytes,
            }),
          );
          if (event.type !== "output") throw new Error(`unexpected output response: ${event.type}`);
          expect(event.jobId).toBe(source.jobId);
          expect(event.outputId).toBe(output.outputId);
          const bytes = Buffer.from(event.data, "base64");
          expect(bytes.length).toBeLessThanOrEqual(maxBytes);
          chunks.push(bytes);
          offset += bytes.length;
          expect(offset).toBeLessThanOrEqual(source.limits.outputBytes);
          if (event.eof) {
            const all = Buffer.concat(chunks);
            expect(all.length).toBe(output.bytes);
            expect(createHash("sha256").update(all).digest("hex")).toBe(output.sha256);
            return all;
          }
          if (!bytes.length) throw new Error("output read made no progress");
        }
        throw new Error("bounded output read did not reach EOF");
      };
      const payload = z
        .strictObject({ kind: z.literal("fixture.result/1"), value: z.number().int() })
        .parse(JSON.parse((await readOutput("stdout")).toString("utf8")));
      expect(payload.value).toBe(42);
      expect((await readOutput("stderr")).toString("utf8")).toBe("diagnostic");
      expect((await execute("once")).result).toEqual(result);
      await agent.restartTransport("SIGKILL");
      expect((await status("once")).result).toEqual(result);
      expect(starts()).toEqual(["once"]);

      // Produce two real archives, then consume only the selected sealed output in an ordinary
      // terminal. Neither a forwarded descriptor nor mutable source-location bytes can pass.
      for (const operationId of [PRODUCE, TERMINAL, LIMITED_TERMINAL]) {
        const operationNode: ManifoldRef = { kind: "operation", machineId, operationId };
        await consent("machines:run", true, operationNode);
        await consent("jobs:read", true, operationNode);
        await consent("jobs:cancel", true, operationNode);
      }
      for (const operationId of [TERMINAL, LIMITED_TERMINAL])
        await consent("jobs:input", true, { kind: "operation", machineId, operationId });
      await ownerAction(hub, "engine.jobs.execute", {
        jobId: "produce-material",
        machineId,
        pluginId: PLUGIN,
        operationId: PRODUCE,
        input: {},
        outputs: ["material", "decoy"].map((name) => ({
          name,
          locationId: LOCATION,
          components: [name],
        })),
        limits: materialLimits,
      });
      const produced = await waitFor(
        async () => {
          const job = await status("produce-material", PRODUCE);
          if (job.result) return job;
          return false;
        },
        20_000,
        20,
      );
      expect({ state: produced.state, result: produced.result }).toMatchObject({
        state: "exited",
        result: { exitCode: 0 },
      });
      const material = produced.result!.outputs.find((output) => output.name === "material")!;
      expect(material.files).toBe(2);
      expect(produced.result?.outputs.find((output) => output.name === "decoy")?.files).toBe(1);
      const reviewedInput = {
        name: "selected",
        from: { jobId: produced.jobId, output: "material" },
      };
      expect(
        await ownerAction(hub, "engine.jobs.inspectInputs", {
          machineId,
          pluginId: `${PLUGIN}.consumer`,
          inputs: [reviewedInput],
        }),
      ).toEqual({
        inputs: [
          {
            ...reviewedInput,
            sha256: material.sha256,
            bytes: material.bytes,
            files: material.files,
          },
        ],
      });
      await expect(
        ownerAction(hub, "engine.jobs.inspectInputs", {
          machineId,
          pluginId: `${PLUGIN}.consumer`,
          inputs: [{ name: "selected", from: { jobId: produced.jobId, output: "decoy" } }],
        }),
      ).rejects.toThrow("input_not_exported:selected");
      writeFileSync(join(witness, "material/top.txt"), "changed after sealing\n");
      const extractions = () => readdirSync(join(runtime, "job-inputs")).sort();
      expect(extractions()).toEqual([]);
      const description = JobDescriptionSchema.parse(
        await ownerAction(hub, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
      );
      const terminal = await sdk.openTerminal({
        elementId: "sealed-material-terminal",
        machineId,
        cols: 120,
        rows: 30,
        runtime: {
          ...installation,
          operationId: TERMINAL,
          resourceBindingDigest: description.operations![TERMINAL]!.resourceBindingDigest,
          input: {},
          inputs: [{ name: "selected", from: { jobId: produced.jobId, output: "material" } }],
        },
      });
      const terminalHome = await connect(hub, {
        containerId: terminal.containerId,
        token: hub.ownerKey,
        reconnect: false,
      });
      home = terminalHome;
      const terminalJobs = async () =>
        ListJobRunsResultSchema.parse(
          await ownerAction(hub, "engine.jobs.listRuns", {
            machineId,
            pluginId: PLUGIN,
            operationId: TERMINAL,
            limit: 10,
          }),
        ).runs.flatMap(({ job }) => (job?.terminal?.terminalId === terminal.id ? [job] : []));
      const inspectMaterial = async (phase: string) => {
        const capture = await attachedCapture(terminalHome, terminal.id);
        captures.push(capture);
        // The input contains format strings, not the expected response: PTY echo cannot satisfy
        // these assertions. Exercise overwrite, creation and unlink, then re-read the bytes.
        terminalHome.sendTerminalInput(
          terminal.id,
          [
            "if (printf changed > /inputs/selected/top.txt); then overwrite=writable; else overwrite=readonly; fi",
            "if (printf added > /inputs/selected/new.txt); then create=writable; else create=readonly; fi",
            "if /bin/busybox rm -f /inputs/selected/nested/inner.txt; then unlink=writable; else unlink=readonly; fi",
            `printf '${phase}_ACCESS:%s:%s:%s\\n' "$overwrite" "$create" "$unlink"`,
            `printf '${phase}_TOP:%s\\n' "$(/bin/busybox base64 /inputs/selected/top.txt)"`,
            `printf '${phase}_NESTED:%s\\n' "$(/bin/busybox base64 /inputs/selected/nested/inner.txt)"`,
            "",
          ].join("\n"),
        );
        await waitForTerminalText(capture, `${phase}_ACCESS:readonly:readonly:readonly`);
        await waitForTerminalText(
          capture,
          `${phase}_TOP:${Buffer.from("selected material\nsecond line\n").toString("base64")}`,
        );
        await waitForTerminalText(
          capture,
          `${phase}_NESTED:${Buffer.from("nested selection\n").toString("base64")}`,
        );
        capture.stop();
        terminalHome.detachTerminal(terminal.id);
      };
      await inspectMaterial("FIRST");
      const firstJobs = await terminalJobs();
      expect(firstJobs).toHaveLength(1);
      expect(firstJobs[0]!.state).toBe("started");
      const firstExtraction = extractions();
      expect(firstExtraction).toHaveLength(1);

      // One archive fits the omitted inputBytes default, but two exceed it. Reuse the
      // admitted public binding so its read-side metadata must identify usable material.
      expect(material.bytes).toBeLessThanOrEqual(4096);
      expect(material.bytes * 2).toBeGreaterThan(4096);
      const admittedInputs = firstJobs[0]!.inputs;
      if (admittedInputs === undefined)
        throw new Error("admitted terminal omitted its input bindings");
      await expect(
        sdk.openTerminal({
          elementId: "refused-material-terminal",
          machineId,
          cols: 120,
          rows: 30,
          runtime: {
            ...installation,
            operationId: LIMITED_TERMINAL,
            resourceBindingDigest: description.operations![LIMITED_TERMINAL]!.resourceBindingDigest,
            input: {},
            inputs: [...admittedInputs, { ...admittedInputs[0]!, name: "excess" }],
          },
        }),
      ).rejects.toThrow("terminal creation failed");
      const refused = await waitFor(
        async () => {
          const runs = ListJobRunsResultSchema.parse(
            await ownerAction(hub, "engine.jobs.listRuns", {
              machineId,
              pluginId: PLUGIN,
              operationId: LIMITED_TERMINAL,
              limit: 10,
            }),
          ).runs;
          const job = runs[0]?.job;
          return job?.result ? job : false;
        },
        20_000,
        20,
      );
      expect(refused).toMatchObject({
        state: "refused",
        result: { reason: "input_too_large", startedAt: null },
      });
      expect(extractions()).toEqual(firstExtraction);
      await inspectMaterial("AFTER_REFUSAL");

      const restarted = nextMessage(
        terminalHome,
        "terminal_event",
        20_000,
        (event) => event.terminalId === terminal.id && event.kind === "restarted",
      );
      const restart = await terminalHome.action("core.terminals.restart", {
        terminalId: terminal.id,
      });
      expect(restart.ok).toBe(true);
      await restarted;
      await inspectMaterial("RESTARTED");
      const restartedJobs = await waitFor(
        async () => {
          const jobs = await terminalJobs();
          return jobs.length === 2 &&
            jobs.some((job) => job.jobId === firstJobs[0]!.jobId && job.result !== null) &&
            jobs.some((job) => job.jobId !== firstJobs[0]!.jobId && job.state === "started")
            ? jobs
            : false;
        },
        20_000,
        20,
      );
      const replacement = restartedJobs.find((job) => job.jobId !== firstJobs[0]!.jobId)!;
      expect(replacement.state).toBe("started");
      expect(restartedJobs.find((job) => job.jobId === firstJobs[0]!.jobId)?.result).not.toBeNull();
      await waitFor(() => extractions().length === 1, 10_000, 20);
      expect(extractions()).not.toEqual(firstExtraction);
      expect(terminalHome.terminals.get(terminal.id)?.containerId).toBe(terminal.containerId);

      terminalHome.killTerminal(terminal.id);
      await waitFor(() => !terminalHome.terminals.has(terminal.id), 20_000, 20);
      const cancelled = await waitFor(
        async () => {
          const job = await status(replacement.jobId, TERMINAL);
          return job.result ? job : false;
        },
        20_000,
        20,
      );
      expect(cancelled.state).toBe("cancelled");
      await waitFor(() => extractions().length === 0, 10_000, 20);
      // Cancellation releases derived mounts, not the immutable material's source lifetime.
      await readOutput("material", produced.result!, PRODUCE, 64);
    } catch (error) {
      for (const capture of captures)
        console.error(
          "native material PTY:",
          (capture.snapshotText + capture.outputText).slice(-8192),
        );
      throw e2eFailure(error, [server, agent]);
    } finally {
      for (const capture of captures) capture.stop();
      home?.close();
      client?.close();
      try {
        await stopProcesses([agent]);
      } finally {
        try {
          if (owner && owner.exitCode === null) {
            owner.kill("SIGTERM");
            // A real supervised process needs a bounded grace period; fake time cannot reap it.
            const exited = await Promise.race([
              owner.exited.then(() => true),
              Bun.sleep(5000).then(() => false),
            ]);
            if (!exited) {
              owner.kill("SIGKILL");
              await owner.exited;
            }
          }
        } finally {
          try {
            await stopProcesses([server]);
          } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(workspace, { recursive: true, force: true });
          }
        }
      }
    }
  },
  120_000,
);
