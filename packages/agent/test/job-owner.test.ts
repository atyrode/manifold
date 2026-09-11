import { describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  canonicalJobJson,
  JobEventSchema,
  type ServicePolicy,
  type JobCommand,
  type JobEvent,
  type JobRequest,
  type JobResult,
} from "@manifold/protocol";
import type { TerminalHostEvent } from "@manifold/protocol";
import { TerminalHost } from "../src/terminal-host.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { JobJournal, jobDigest } from "../src/job-journal.ts";
import { MachineJobOwner, type JobOwnerOptions } from "../src/job-owner.ts";
import { JobOutputStore } from "../src/job-outputs.ts";
import { artifactCacheKey } from "../src/job-artifacts.ts";
import { LinuxJobRefusal, startLinuxJob, type LinuxJobResult } from "../src/job-linux.ts";
import * as nativeRuntime from "../src/job-linux.ts";

function tarMember(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)]);
}

const linux = process.platform === "linux";
describe.skipIf(!linux)("durable job owner journal", () => {
  test("generation and signing identity survive restart; concurrent owner cannot take its lock", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-"));
    try {
      const first = new JobJournal(HeldDirectory.openAbsolute(root, { private: true }));
      const ownerId = first.ownerId;
      const publicKey = first.publicKey;
      const body = {
        nonce: "fresh",
        serverEpoch: "epoch",
        machineId: "machine",
        generation: first.generation,
      };
      expect(
        verify(
          null,
          Buffer.from(canonicalJobJson(body)),
          createPublicKey(publicKey),
          Buffer.from(first.proof(body), "base64"),
        ),
      ).toBe(true);
      expect(
        verify(
          null,
          Buffer.from(canonicalJobJson({ ...body, nonce: "other" })),
          createPublicKey(publicKey),
          Buffer.from(first.proof(body), "base64"),
        ),
      ).toBe(false);
      expect(() => new JobJournal(HeldDirectory.openAbsolute(root, { private: true }))).toThrow(
        "job_owner_already_locked",
      );
      first.append({
        kind: "reservation",
        jobId: "reserved",
        requestDigest: "a".repeat(64),
        permitId: "single-use",
      });
      first.close();
      const second = new JobJournal(HeldDirectory.openAbsolute(root, { private: true }));
      expect(second.ownerId).toBe(ownerId);
      expect(second.publicKey).toBe(publicKey);
      expect(second.generation).toBe(2);
      expect(second.records).toContainEqual({
        kind: "reservation",
        jobId: "reserved",
        requestDigest: "a".repeat(64),
        permitId: "single-use",
      });
      second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing or torn durable records refuse recovery instead of forgetting effects", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-"));
    try {
      const journal = new JobJournal(HeldDirectory.openAbsolute(root, { private: true }));
      journal.append({ kind: "reservation", jobId: "one" });
      journal.append({ kind: "reservation", jobId: "two" });
      journal.close();
      unlinkSync(join(root, "record-00000002"));
      expect(() => new JobJournal(HeldDirectory.openAbsolute(root, { private: true }))).toThrow(
        "journal_gap",
      );
      writeFileSync(join(root, "record-00000002"), '{"sequence":2', { mode: 0o600 });
      expect(() => new JobJournal(HeldDirectory.openAbsolute(root, { private: true }))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const bwrap = process.env.MANIFOLD_TEST_BWRAP;
const busybox = process.env.MANIFOLD_TEST_STATIC_BUSYBOX;
const cgroupRoot = process.env.MANIFOLD_TEST_CGROUP;
const compiledProbe = process.env.MANIFOLD_TEST_SYSCALL_PROBE;
const realBackend = linux && Boolean(bwrap && busybox && cgroupRoot);
test
  .skipIf(!linux || !cgroupRoot)
  .each(["expired", "status", "cancel", "retire", "recovered-status"] as const)(
  "never-admitted %s starts close durably without accepting forged absence or replay",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "owner-unadmitted-"));
    const held: HeldDirectory[] = [];
    const keys = generateKeyPairSync("ed25519");
    let owner: MachineJobOwner | undefined;
    let outputs: JobOutputStore | undefined;
    try {
      const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
      held.push(protectedRoot);
      const cache = protectedRoot.openChild("cache", { create: true });
      const managedState = protectedRoot.openChild("locations", { create: true });
      const outputDirectory = protectedRoot.openChild("outputs", { create: true });
      const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
      held.push(cache, managedState, outputDirectory, delegatedCgroup);
      outputs = JobOutputStore.open(outputDirectory);
      const options: Omit<JobOwnerOptions, "journal"> = {
        machineId: "machine",
        admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        cache,
        managedState,
        outputs,
        delegatedCgroup,
        bubblewrapFd: -1,
        anchors: {},
        runtimeTools: {},
        protectedDirectories: [protectedRoot],
        artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
      };
      const open = async () =>
        MachineJobOwner.open({
          ...options,
          journal: new JobJournal(protectedRoot.openChild("journal", { create: true })),
        });
      owner = await open();
      const events: JobEvent[] = [];
      const receive = (event: JobEvent) => {
        events.push(JobEventSchema.parse(event));
        return true;
      };
      owner.attach(receive);
      const immutable = {
        jobId: "never-admitted",
        machineId: "machine",
        pluginId: "fixture.jobs",
        operationId: "fixture.jobs.run",
        installationRevision: "r1",
        artifactSha256: "a".repeat(64),
        input: {},
        outputs: [],
        limits: { timeoutMs: 0, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
        credential: {
          principalId: "root",
          tokenId: null,
          grantId: null,
          containerScope: null,
          caps: ["machines:run"],
        },
        parent: null,
        traceId: "test",
        service: {
          serviceId: "fixture.jobs.service",
          revision: "r1",
          policySha256: "b".repeat(64),
        },
      };
      const request = { ...immutable, requestDigest: jobDigest(immutable) };
      const signed = {
        permitId: "unused-permit",
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        ownerId: owner.identity.ownerId,
        ownerGeneration: owner.identity.generation,
        decisionId: "decision",
        policyRevision: "revision",
        issuedAt: mode === "expired" ? 1 : Date.now(),
        expiresAt: mode === "expired" ? 2 : Date.now() + 30000,
      };
      const permit = {
        ...signed,
        signature: sign(null, Buffer.from(canonicalJobJson(signed)), keys.privateKey).toString(
          "base64",
        ),
      };
      const command =
        mode === "expired"
          ? { type: "start", request, permit }
          : {
              type: mode === "cancel" || mode === "retire" ? mode : "status",
              jobId: request.jobId,
              ...(mode === "cancel" || mode === "retire" ? { reason: "requested" } : {}),
              admission: { request, permit },
            };
      await owner.execute({
        type: mode === "retire" ? "retire" : "status",
        jobId: request.jobId,
        ...(mode === "retire" ? { reason: "requested" } : {}),
        admission: {
          request,
          permit: { ...permit, signature: Buffer.alloc(64).toString("base64") },
        },
      });
      const wrongOwner = { ...signed, ownerId: "another-owner" };
      await owner.execute({
        type: mode === "retire" ? "retire" : "status",
        jobId: request.jobId,
        ...(mode === "retire" ? { reason: "requested" } : {}),
        admission: {
          request,
          permit: {
            ...wrongOwner,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(wrongOwner)),
              keys.privateKey,
            ).toString("base64"),
          },
        },
      });
      await owner.execute({ type: "cancel", jobId: request.jobId, reason: "requested" });
      expect(events.some((event) => event.type === "workload_empty")).toBe(false);
      if (mode === "recovered-status") {
        await owner.shutdown();
        owner = await open();
        owner.attach(receive);
      }
      events.length = 0;
      await owner.execute(command);
      const proof = {
        type: "workload_empty" as const,
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        ownerId: signed.ownerId,
        ownerGeneration: signed.ownerGeneration,
      };
      expect(events).toContainEqual(proof);
      expect(events).toContainEqual({
        type: "result",
        result: expect.objectContaining({ state: "refused", reason: "start_not_admitted" }),
      });
      await owner.shutdown();
      owner = await open();
      owner.attach(receive);
      await owner.execute({ type: "drain", draining: false });
      events.length = 0;
      // A newly signed, currently valid permit cannot undo an already proved empty identity.
      const renewed = {
        ...signed,
        permitId: "renewed-permit",
        ownerGeneration: owner.identity.generation,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30000,
      };
      await owner.execute({
        type: "start",
        request,
        permit: {
          ...renewed,
          signature: sign(null, Buffer.from(canonicalJobJson(renewed)), keys.privateKey).toString(
            "base64",
          ),
        },
      });
      expect(events).toContainEqual(proof);
      expect(events).toContainEqual({
        type: "result",
        result: expect.objectContaining({ state: "refused", reason: "start_not_admitted" }),
      });
      expect(events.some((event) => event.type === "state")).toBe(false);
    } finally {
      await owner?.shutdown();
      outputs?.close();
      for (const directory of held.reverse()) directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe.skipIf(!realBackend || !compiledProbe)("real supervised job owner", () => {
  test.each(["primary", "managed", "companion"] as const)(
    "bundled %s execution survives missing optional tools and owner recovery without replay",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "machine-owner-"));
      const keys = generateKeyPairSync("ed25519");
      const admissionPublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      // A real statically compiled worker, padded beyond the former 1 MiB IPC/journal ceiling.
      const bytes = Buffer.concat([readFileSync(compiledProbe!), Buffer.alloc(1024 * 1024)]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const limits = {
        timeoutMs: 10_000,
        memoryBytes: 128 * 1024 * 1024,
        processes: 32,
        outputBytes: 65536,
      };
      const install: Extract<JobCommand, { type: "install" }> = {
        type: "install",
        pluginId: "fixture.jobs",
        installationRevision: "r1",
        artifactSha256: sha256,
        artifact: { bundleFile: "worker", data: bytes.toString("base64") },
        machine: {
          artifacts: {
            [`linux-${process.arch}`]: {
              bundleFile: "worker",
              sha256,
              format: "raw",
              entry: ["fixture"],
              entrySha256: sha256,
              maxBytes: bytes.length,
              maxExpandedBytes: bytes.length,
              maxMembers: 1,
            },
          },
          locations: {},
          operations: {
            "fixture.jobs.run": {
              argv: [{ literal: "worker" }],
              input: {},
              runtimeTools: [],
              locations: [],
              outputs: [],
              network: "none",
              limits,
              stdin: true,
            },
          },
        },
      };
      const primary = Object.values(install.machine.artifacts)[0]!;
      const helperBytes = Buffer.concat([bytes, Buffer.from("pinned-companion")]);
      const helperHash = createHash("sha256").update(helperBytes).digest("hex");
      const engineArchive = Buffer.concat([
        tarMember("managed-engine", bytes),
        tarMember("helper", helperBytes),
        Buffer.alloc(1024),
      ]);
      const engineBytes = gzipSync(engineArchive);
      const engine = {
        ...primary,
        bundleFile: "engine",
        entry: ["managed-engine"],
        format: "tar.gz" as const,
        sha256: createHash("sha256").update(engineBytes).digest("hex"),
        files: { helper: { entry: ["helper"], sha256: helperHash } },
        maxBytes: engineBytes.length,
        maxExpandedBytes: engineArchive.length,
        maxMembers: 2,
      };
      install.machine.tools = { engine: { [`linux-${process.arch}`]: engine }, absent: {} };
      install.toolArtifacts = { engine: engineBytes.toString("base64") };
      install.machine.operations["fixture.jobs.managed"] = {
        ...install.machine.operations["fixture.jobs.run"]!,
        executable: { runtimeTool: "engine" },
        runtimeTools: ["engine"],
        input: { config: { type: "string", required: true } },
        inputFiles: { "config.json": { input: "config" } },
      };
      install.machine.operations["fixture.jobs.companion"] = {
        ...install.machine.operations["fixture.jobs.managed"]!,
        executable: { runtimeTool: "helper" },
        runtimeTools: ["engine", "helper"],
      };
      install.machine.operations["fixture.jobs.absent"] = {
        ...install.machine.operations["fixture.jobs.run"]!,
        executable: { runtimeTool: "absent" },
        runtimeTools: ["absent"],
      };
      let owner: MachineJobOwner | null = null;
      const held: HeldDirectory[] = [];
      let bwrapFd = -1;
      let restoreLaunch: (() => void) | undefined;
      try {
        for (const name of ["journal", "cache", "outputs"])
          mkdirSync(join(root, name), { mode: 0o700 });
        const executableParent = HeldDirectory.openAbsolute(dirname(bwrap!));
        bwrapFd = executableParent.openRuntimeFile(basename(bwrap!));
        executableParent.close();
        const cache = HeldDirectory.openAbsolute(join(root, "cache"), { private: true });
        const outputDirectory = HeldDirectory.openAbsolute(join(root, "outputs"), {
          private: true,
        });
        const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
        held.push(cache, outputDirectory, delegatedCgroup);
        const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
        held.push(protectedRoot);
        const outputs = JobOutputStore.open(outputDirectory);
        const managedState = protectedRoot.openChild("locations", { create: true });
        held.push(managedState);
        const options: Omit<JobOwnerOptions, "journal"> = {
          machineId: "machine",
          admissionPublicKey,
          cache,
          managedState,
          outputs,
          delegatedCgroup,
          bubblewrapFd: bwrapFd,
          anchors: {},
          protectedDirectories: [protectedRoot],
          runtimeTools: {
            absent: [{ fd: bwrapFd, target: "/runtime/bin/absent", writable: false }],
            helper: [{ fd: bwrapFd, target: "/runtime/bin/helper", writable: false }],
          },
          artifactAuthority: {
            origins: [],
            maxRedirects: 0,
            timeoutMs: 1000,
          },
        };
        const journal = new JobJournal(
          HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
        );
        owner = await MachineJobOwner.open({
          ...options,
          journal,
        });
        const events: JobEvent[] = [];
        const completed = Promise.withResolvers<JobResult>();
        let release = owner.attach((event) => {
          events.push(event);
          if (
            event.type === "result" &&
            ["exited", "interrupted", "cancelled"].includes(event.result.state)
          )
            completed.resolve(event.result);
          return true;
        });
        const { artifact: delivery, ...missing } = install;
        await owner.execute(missing);
        expect(events.at(-1)).toMatchObject({ type: "refusal" });
        await owner.execute({
          ...install,
          artifact: { ...delivery, data: Buffer.from("substitution").toString("base64") },
        });
        expect(events.at(-1)).toMatchObject({ type: "refusal" });
        await owner.execute({
          ...install,
          machine: { ...install.machine, tools: { ...install.machine.tools, helper: {} } },
        });
        expect(events.at(-1)).toMatchObject({
          type: "refusal",
          reason: "runtime_tool_alias_ambiguous",
        });
        await owner.execute({
          ...install,
          artifactSha256: engine.sha256,
          artifact: { bundleFile: "primary-archive", data: engineBytes.toString("base64") },
          machine: {
            ...install.machine,
            // Raw artifacts cannot declare companion files. Use the real two-member
            // archive to reach the primary/tool alias collision admission boundary.
            artifacts: { [`linux-${process.arch}`]: { ...engine, bundleFile: "primary-archive" } },
          },
        });
        expect(events.at(-1)).toMatchObject({
          type: "refusal",
          reason: "runtime_tool_alias_ambiguous",
        });
        await owner.execute({ ...install, toolArtifacts: undefined });
        expect(events.at(-1)).toMatchObject({
          type: "installed",
          resources: {
            artifactAvailable: true,
            operations: expect.arrayContaining([
              { operationId: "fixture.jobs.run", available: true },
              expect.objectContaining({ operationId: "fixture.jobs.managed", available: false }),
              expect.objectContaining({ operationId: "fixture.jobs.absent", available: false }),
              expect.objectContaining({ operationId: "fixture.jobs.companion", available: false }),
            ]),
          },
        });
        await owner.execute(install);
        expect(events.at(-1)).toMatchObject({
          type: "installed",
          pluginId: install.pluginId,
          installationRevision: install.installationRevision,
          artifactSha256: sha256,
        });
        expect(
          owner.installedResources(install.pluginId, install.installationRevision).operations,
        ).toEqual(
          expect.arrayContaining([
            { operationId: "fixture.jobs.managed", available: true },
            { operationId: "fixture.jobs.companion", available: true },
          ]),
        );
        const requestBody = {
          jobId: "once",
          machineId: "machine",
          operationId:
            mode === "primary"
              ? "fixture.jobs.run"
              : mode === "managed"
                ? "fixture.jobs.managed"
                : "fixture.jobs.companion",
          pluginId: "fixture.jobs",
          installationRevision: "r1",
          artifactSha256: sha256,
          input: mode === "primary" ? {} : { config: '{"private":true}\n' },
          limits,
          outputs: [],
          parent: null,
          credential: {
            principalId: "actor",
            tokenId: "token",
            grantId: "grant",
            caps: [],
            containerScope: null,
          },
          traceId: "trace",
        };
        const request: JobRequest = { ...requestBody, requestDigest: jobDigest(requestBody) };
        const now = Date.now();
        const permitBody = {
          permitId: "permit",
          jobId: request.jobId,
          requestDigest: request.requestDigest,
          ownerId: owner.identity.ownerId,
          ownerGeneration: owner.identity.generation,
          decisionId: "decision",
          policyRevision: "policy",
          issuedAt: now,
          expiresAt: now + 30000,
        };
        const command: Extract<JobCommand, { type: "start" }> = {
          type: "start",
          request,
          permit: {
            ...permitBody,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(permitBody)),
              keys.privateKey,
            ).toString("base64"),
          },
        };
        const absentBody = {
          ...requestBody,
          jobId: "absent",
          operationId: "fixture.jobs.absent",
          input: {},
        };
        const absentRequest = { ...absentBody, requestDigest: jobDigest(absentBody) };
        const absentPermit = {
          ...permitBody,
          permitId: "absent",
          jobId: "absent",
          requestDigest: absentRequest.requestDigest,
        };
        await owner.execute({
          type: "start",
          request: absentRequest,
          permit: {
            ...absentPermit,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(absentPermit)),
              keys.privateKey,
            ).toString("base64"),
          },
        });
        expect(events.at(-1)).toMatchObject({
          type: "refusal",
          jobId: "absent",
          reason: "runtime_tool_platform_unavailable",
        });
        await owner.execute({
          ...command,
          permit: { ...command.permit, signature: Buffer.alloc(64).toString("base64") },
        });
        expect(events.at(-1)).toEqual({
          type: "refusal",
          jobId: "once",
          reason: "start_permit_refused",
        });
        expect(outputs.recovered("once")).toEqual([]);
        await owner.execute(command);
        const result = await completed.promise;
        expect(result.exitCode).toBe(0);
        const stdout = result.outputs.find((output) => output.name === "stdout")!;
        expect(outputs.read("once", stdout.outputId, 0, 65536).data.toString()).toBe(
          "private-once",
        );
        expect(() => outputs.read("other", stdout.outputId, 0, 65536)).toThrow();
        const firstGeneration = result.ownerGeneration;
        const stdinFinished = Promise.withResolvers<JobResult>();
        release();
        release = owner.attach((event) => {
          events.push(event);
          if (
            event.type === "result" &&
            event.result.jobId === "input-receipts" &&
            event.result.finishedAt !== null
          )
            stdinFinished.resolve(event.result);
          return true;
        });
        await owner.execute(command);
        expect(events.at(-1)).toEqual({ type: "result", result });
        const realLaunchJob = startLinuxJob;
        let launchJob = realLaunchJob;
        const nativeLaunch = spyOn(nativeRuntime, "startLinuxJob").mockImplementation((spec) =>
          launchJob(spec),
        );
        restoreLaunch = () => nativeLaunch.mockRestore();
        // Hold the real owner's runtime stdin callback to exercise overlapping commands,
        // partial-write uncertainty and lifecycle isolation through the public owner API.
        const stdinExit = Promise.withResolvers<LinuxJobResult>();
        let write = Promise.withResolvers<void>();
        let inputCalls = 0;
        let inputCancels = 0;
        const stdinResult: LinuxJobResult = {
          empty: true,
          exitCode: null,
          signal: "SIGKILL",
          reason: "cancelled",
          startedAt: now,
          finishedAt: now,
          boundary: "linux-bubblewrap-cgroup-v2",
          usage: {
            wallMs: 0,
            cpuUsec: 0,
            memoryPeakBytes: 0,
            processesPeak: 0,
            outputBytes: 0,
            oomKills: 0,
          },
        };
        launchJob = async (spec) => ({
          result: stdinExit.promise,
          childDelegation: spec.delegatedCgroup,
          ownsLoopbackListener: () => false,
          ownsLoopbackConnection: () => false,
          input: async () => {
            inputCalls++;
            await write.promise;
          },
          endInput() {},
          release() {},
          async cancel() {
            inputCancels++;
            stdinExit.resolve(stdinResult);
            return stdinResult;
          },
        });
        const stdinBody = { ...requestBody, jobId: "input-receipts" };
        const stdinRequest = { ...stdinBody, requestDigest: jobDigest(stdinBody) };
        const stdinPermit = {
          ...permitBody,
          jobId: stdinBody.jobId,
          permitId: stdinBody.jobId,
          requestDigest: stdinRequest.requestDigest,
        };
        await owner.execute({
          type: "start",
          request: stdinRequest,
          permit: {
            ...stdinPermit,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(stdinPermit)),
              keys.privateKey,
            ).toString("base64"),
          },
        });
        await owner.execute({
          type: "status",
          jobId: stdinBody.jobId,
          admission: {
            request: stdinRequest,
            permit: {
              ...stdinPermit,
              signature: sign(
                null,
                Buffer.from(canonicalJobJson(stdinPermit)),
                keys.privateKey,
              ).toString("base64"),
            },
          },
        });
        expect(events).toContainEqual({
          type: "result",
          result: expect.objectContaining({ jobId: stdinBody.jobId, state: "started" }),
        });
        expect(
          events.some(
            (event) => event.type === "workload_empty" && event.jobId === stdinBody.jobId,
          ),
        ).toBe(false);
        const sendInput = (requestId: string, seq: number) =>
          owner!.execute({
            type: "input",
            jobId: stdinBody.jobId,
            requestId,
            seq,
            data: Buffer.from("private-input").toString("base64"),
            eof: false,
          });
        const firstInput = sendInput("first-input", 0);
        await owner.execute({
          type: "input_authorized",
          jobId: stdinBody.jobId,
          requestId: "first-input",
          allowed: true,
        });
        await sendInput("stale-input", 0);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "input_result",
            requestId: "stale-input",
            accepted: false,
          }),
        );
        expect(
          events.some(
            (event) => event.type === "input_result" && event.requestId === "first-input",
          ),
        ).toBe(false);
        expect(inputCalls).toBe(1);
        expect(inputCancels).toBe(0);
        write.resolve();
        await firstInput;
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "input_result",
            requestId: "first-input",
            accepted: true,
            nextInputSeq: 1,
          }),
        );
        await sendInput("first-input", 0);
        expect(events.at(-1)).toMatchObject({
          type: "input_result",
          requestId: "first-input",
          accepted: false,
          reason: "job_input_delivery_unknown",
          nextInputSeq: 1,
        });
        expect(inputCalls).toBe(1);
        write = Promise.withResolvers<void>();
        const failedInput = sendInput("failed-input", 1);
        await owner.execute({
          type: "input_authorized",
          jobId: stdinBody.jobId,
          requestId: "failed-input",
          allowed: true,
        });
        write.reject(new Error("private write failure"));
        await failedInput;
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "input_result",
            requestId: "failed-input",
            accepted: false,
            reason: "job_input_delivery_unknown",
            nextInputSeq: 2,
            stdinClosed: true,
          }),
        );
        await sendInput("retry-input", 1);
        await sendInput("closed-input", 2);
        expect(inputCalls).toBe(2);
        expect(inputCancels).toBe(0);
        expect(
          events.some((event) => event.type === "refusal" && event.jobId === stdinBody.jobId),
        ).toBe(false);
        await owner.execute({ type: "status", jobId: stdinBody.jobId });
        expect(events.at(-1)).toMatchObject({
          type: "input_state",
          nextInputSeq: 2,
          stdinClosed: true,
        });
        await owner.execute({ type: "cancel", jobId: stdinBody.jobId, reason: "test-finished" });
        expect((await stdinFinished.promise).state).toBe("cancelled");
        launchJob = realLaunchJob;
        let emptyFailure = Promise.withResolvers<void>();
        const host = new TerminalHost({
          jobOwner: owner,
          shellCommand: [busybox!, "echo", "unconfined terminal started"],
          sink: (record) => {
            if (record.evt === "terminal_empty_unproven") emptyFailure.resolve();
          },
        });
        const terminalEvents: TerminalHostEvent[] = [];
        const terminalExit = Promise.withResolvers<void>();
        let terminalRefused = Promise.withResolvers<void>();
        const seat = host.open({
          write(event) {
            terminalEvents.push(event);
            if (event.type === "exited") terminalExit.resolve();
            if (event.type === "create_error") terminalRefused.resolve();
            return true;
          },
          close() {},
        });
        seat.deliver({ type: "attach" });
        const boundBody = {
          ...requestBody,
          jobId: "terminal-once",
          terminal: {
            terminalId: "native-terminal",
            terminalHostId: host.terminalHostId,
            containerId: "home",
          },
        };
        const boundRequest = { ...boundBody, requestDigest: jobDigest(boundBody) };
        const boundPermit = {
          ...permitBody,
          permitId: "terminal-permit",
          jobId: boundRequest.jobId,
          requestDigest: boundRequest.requestDigest,
        };
        const boundCommand: Extract<JobCommand, { type: "start" }> = {
          type: "start",
          request: boundRequest,
          permit: {
            ...boundPermit,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(boundPermit)),
              keys.privateKey,
            ).toString("base64"),
          },
        };
        const create = {
          type: "create",
          terminalId: "native-terminal",
          cols: 80,
          rows: 24,
          env: {},
          runtime: boundCommand,
        };
        try {
          for (const kind of ["shell", "program"] as const) {
            const terminalId = `runtime-free-${kind}`;
            seat.deliver({
              type: "create",
              terminalId,
              cols: 80,
              rows: 24,
              env: {},
              cwd: root,
              ...(kind === "program"
                ? { program: { argv: [busybox!, "echo", "unconfined program started"] } }
                : {}),
            });
            expect(terminalEvents.at(-1)).toMatchObject({ type: "create_error", terminalId });
            expect(host.status().terminals).toEqual([]);
            terminalRefused = Promise.withResolvers<void>();
          }
          // A signed job cannot take the ordinary job RPC path or another terminal's PTY.
          await owner.execute(boundCommand);
          expect(events.at(-1)).toMatchObject({
            type: "refusal",
            reason: "terminal_host_required",
          });
          seat.deliver({ ...create, program: { argv: ["/bin/sh"] } });
          await terminalRefused.promise;
          expect(host.terminalCount).toBe(0);
          terminalRefused = Promise.withResolvers<void>();
          seat.deliver({ ...create, terminalId: "other-terminal" });
          await terminalRefused.promise;
          expect(host.terminalCount).toBe(0);
          expect(terminalEvents.at(-1)).toMatchObject({
            type: "create_error",
            terminalId: "other-terminal",
          });
          terminalRefused = Promise.withResolvers<void>();
          // A verified rejected identity is permanently fenced, so a fresh terminal needs
          // its own job identity rather than renewing a rejected generation's admission.
          const staleUnsigned: Omit<typeof boundRequest, "requestDigest"> & {
            requestDigest?: string;
          } = { ...boundRequest, jobId: "stale-generation-terminal" };
          delete staleUnsigned.requestDigest;
          const staleRequest = { ...staleUnsigned, requestDigest: jobDigest(staleUnsigned) };
          const stalePermit = {
            ...boundPermit,
            jobId: staleRequest.jobId,
            requestDigest: staleRequest.requestDigest,
            permitId: staleRequest.jobId,
            ownerGeneration: boundPermit.ownerGeneration - 1,
          };
          seat.deliver({
            ...create,
            runtime: {
              ...boundCommand,
              request: staleRequest,
              permit: {
                ...stalePermit,
                signature: sign(
                  null,
                  Buffer.from(canonicalJobJson(stalePermit)),
                  keys.privateKey,
                ).toString("base64"),
              },
            },
          });
          await terminalRefused.promise;
          expect(host.terminalCount).toBe(0);
          expect(outputs.recovered(boundRequest.jobId)).toEqual([]);
          seat.deliver(create);
          await terminalExit.promise;
          expect(terminalEvents).toContainEqual({ type: "created", terminalId: "native-terminal" });
          expect(terminalEvents).toContainEqual({
            type: "exited",
            terminalId: "native-terminal",
            exitCode: 0,
          });
          const terminalText = terminalEvents
            .flatMap((event) =>
              event.type === "output" ? [Buffer.from(event.data, "base64").toString()] : [],
            )
            .join("");
          expect(terminalText).toContain("private-once");
          expect(terminalText).toContain("diagnostic");
          expect(
            events.some((event) => event.type === "output" && event.jobId === boundRequest.jobId),
          ).toBe(false);
          expect(outputs.recovered(boundRequest.jobId)).toEqual([]);
          seat.deliver(create);
          expect(terminalEvents.at(-1)).toMatchObject({
            type: "create_error",
            message: "terminal_admission_reused",
          });
          seat.detach();
          const successor = host.open({
            write(event) {
              terminalEvents.push(event);
              if (event.type === "create_error") terminalRefused.resolve();
              return true;
            },
            close() {},
          });
          successor.deliver({ type: "attach" });
          expect(terminalEvents.at(-1)).toMatchObject({
            type: "attached",
            terminals: [{ terminalId: "native-terminal", alive: false, exitCode: 0 }],
          });
          successor.deliver({ type: "kill", terminalId: "native-terminal" });
          for (const failure of ["empty-startup", "startup", "result"] as const) {
            successor.deliver({ type: "drain", draining: false, requestId: `resume-${failure}` });
            let proofAvailable = false;
            const interrupted = Promise.withResolvers<JobResult>();
            release();
            release = owner.attach((event) => {
              events.push(event);
              if (event.type === "result" && event.result.state === "interrupted")
                interrupted.resolve(event.result);
              return true;
            });
            emptyFailure = Promise.withResolvers<void>();
            terminalRefused = Promise.withResolvers<void>();
            const id = `unknown-${failure}`;
            const body = {
              ...boundBody,
              jobId: id,
              terminal: { ...boundBody.terminal, terminalId: id },
            };
            const request = { ...body, requestDigest: jobDigest(body) };
            const permit = {
              ...boundPermit,
              jobId: id,
              permitId: id,
              requestDigest: request.requestDigest,
            };
            const cleanup = async () => {
              if (!proofAvailable) throw new LinuxJobRefusal("cgroup-empty-unproven");
            };
            launchJob = async (spec) => {
              if (failure !== "result")
                throw new LinuxJobRefusal(
                  "cgroup-empty-unproven",
                  undefined,
                  failure === "empty-startup",
                  cleanup,
                );
              return {
                result: Promise.reject(new LinuxJobRefusal("cgroup-empty-unproven")),
                childDelegation: spec.delegatedCgroup,
                ownsLoopbackListener: () => false,
                ownsLoopbackConnection: () => false,
                input: async () => {},
                endInput() {},
                release() {},
                async cancel(): Promise<LinuxJobResult> {
                  await cleanup();
                  return {
                    empty: true,
                    exitCode: null,
                    signal: "SIGKILL",
                    reason: "cancelled",
                    startedAt: now,
                    finishedAt: now,
                    boundary: "linux-bubblewrap-cgroup-v2",
                    usage: {
                      wallMs: 0,
                      cpuUsec: 0,
                      memoryPeakBytes: 0,
                      processesPeak: 0,
                      outputBytes: 0,
                      oomKills: 0,
                    },
                  };
                },
              };
            };
            successor.deliver({
              ...create,
              terminalId: id,
              runtime: {
                type: "start",
                request,
                permit: {
                  ...permit,
                  signature: sign(
                    null,
                    Buffer.from(canonicalJobJson(permit)),
                    keys.privateKey,
                  ).toString("base64"),
                },
              },
            });
            if (failure === "empty-startup") {
              await terminalRefused.promise;
              successor.deliver({ type: "drain", draining: true, requestId: "safe-refusal" });
              expect(owner.maintenanceReady).toBe(true);
              expect(host.terminalCount).toBe(0);
              continue;
            }
            await interrupted.promise;
            if (failure === "startup") await terminalRefused.promise;
            else await emptyFailure.promise;
            expect(owner.maintenanceReady).toBe(false);
            expect(host.status().terminals).toContainEqual(
              expect.objectContaining({ terminalId: id, alive: true }),
            );
            expect(
              terminalEvents.some((event) => event.type === "exited" && event.terminalId === id),
            ).toBe(false);
            successor.deliver({ type: "kill", terminalId: id });
            successor.deliver({ type: "shutdown_request" });
            expect(terminalEvents.at(-1)).toMatchObject({
              type: "shutdown_refused",
              reason: "terminals_retained",
            });
            await expect(owner.shutdown()).rejects.toThrow("cgroup-empty-unproven");
            proofAvailable = true;
            await owner.execute({ type: "cancel", jobId: id, reason: "empty-proof-recovered" });
            expect(owner.maintenanceReady).toBe(true);
            emptyFailure = Promise.withResolvers<void>();
            successor.deliver({ type: "kill", terminalId: id });
            await emptyFailure.promise;
            successor.deliver({ type: "kill", terminalId: id });
            expect(host.terminalCount).toBe(0);
          }
        } finally {
          restoreLaunch();
          restoreLaunch = undefined;
          await host.shutdown();
        }
        release();
        await owner.shutdown();
        unlinkSync(
          join(
            root,
            "cache",
            artifactCacheKey(engine, mode === "companion" ? helperHash : engine.entrySha256),
          ),
        );
        const interruptedBody = { ...requestBody, jobId: "unobserved" };
        const interruptedRequest: JobRequest = {
          ...interruptedBody,
          requestDigest: jobDigest(interruptedBody),
        };
        const interruptedJournal = new JobJournal(
          HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
        );
        interruptedJournal.append({
          kind: "reservation",
          request: interruptedRequest,
          permitId: "unobserved-permit",
          result: {
            ...result,
            jobId: interruptedRequest.jobId,
            requestDigest: interruptedRequest.requestDigest,
            ownerGeneration: interruptedJournal.generation,
            state: "start-committed",
            exitCode: null,
            reason: null,
            startedAt: null,
            finishedAt: null,
            usage: null,
            outputs: [],
          },
        });
        interruptedJournal.close();
        owner = await MachineJobOwner.open({
          ...options,
          journal: new JobJournal(
            HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
          ),
        });
        release = owner.attach((event) => {
          events.push(event);
          return true;
        });
        events.length = 0;
        await owner.execute({
          type: "owner_challenge",
          machineId: options.machineId,
          admissionPublicKey: options.admissionPublicKey,
          nonce: "restored-owner-resource-proof",
          serverEpoch: "restored-hub",
        });
        expect(
          events.findLast(
            (event) =>
              event.type === "installed" &&
              event.pluginId === install.pluginId &&
              event.installationRevision === install.installationRevision,
          ),
        ).toMatchObject({
          resources: {
            operations: expect.arrayContaining([
              { operationId: "fixture.jobs.run", available: true },
              expect.objectContaining({ operationId: "fixture.jobs.managed", available: false }),
              expect.objectContaining({ operationId: "fixture.jobs.absent", available: false }),
              expect.objectContaining({ operationId: "fixture.jobs.companion", available: false }),
            ]),
          },
        });
        await owner.execute({ type: "drain", draining: false });
        await owner.execute(install);
        expect(
          owner.installedResources(install.pluginId, install.installationRevision).operations,
        ).toContainEqual({ operationId: "fixture.jobs.managed", available: true });
        await owner.execute({ type: "status", jobId: stdinBody.jobId });
        expect(events.at(-1)).toMatchObject({
          type: "input_state",
          nextInputSeq: 2,
          stdinClosed: true,
        });
        await owner.execute(command);
        expect(events.at(-1)).toEqual({ type: "result", result });
        expect(owner.identity.generation).toBeGreaterThan(firstGeneration);
        await owner.execute({ type: "status", jobId: interruptedRequest.jobId });
        const recovered = events.findLast(
          (event) => event.type === "result" && event.result.jobId === interruptedRequest.jobId,
        );
        expect(recovered?.type).toBe("result");
        if (recovered?.type !== "result") throw new Error("missing_recovery_result");
        expect(recovered.result.state).toBe("interrupted");
        expect(recovered.result.reason).toBe("owner_restart_effects_unknown");
        expect(recovered.result.usage).toBeNull();
        expect(recovered.result.outputs).toEqual([]);
        const changed = { ...requestBody, input: { changed: true } };
        const changedRequest = { ...changed, requestDigest: jobDigest(changed) };
        const changedPermit = { ...permitBody, requestDigest: changedRequest.requestDigest };
        await owner.execute({
          ...command,
          request: changedRequest,
          permit: {
            ...changedPermit,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(changedPermit)),
              keys.privateKey,
            ).toString("base64"),
          },
        });
        expect(events.at(-1)).toEqual({
          type: "refusal",
          jobId: "once",
          reason: "job_identity_changed",
        });
        release();
        await owner.shutdown();
        owner = null;
        outputs.close();
      } finally {
        restoreLaunch?.();
        await owner?.shutdown();
        if (bwrapFd >= 0) closeSync(bwrapFd);
        for (const directory of held) directory.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});

const outputRoot = process.env.MANIFOLD_TEST_OUTPUT_ROOT;
test.skipIf(!realBackend || !outputRoot)(
  "real owner bounds aggregate sparse output materialization before rolling back earlier archives",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "machine-owner-aggregate-"));
    // Only the workload's source trees belong on the disposable 64 KiB tmpfs.
    // The private archive store must allow an erroneous second archive to materialize.
    const sourceRoot = mkdtempSync(join(outputRoot!, "owner-aggregate-"));
    const keys = generateKeyPairSync("ed25519");
    const sparseBytes = 80 * 1024;
    const outputNames = ["first", "second"];
    const bytes = Buffer.from(
      "#!/bin/busybox sh\nset -eu\n" +
        outputNames
          .map((name) => `/bin/busybox truncate -s ${sparseBytes} /outputs/${name}/hole\n`)
          .join("") +
        "printf sparse-ready\n",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const limits = {
      timeoutMs: 10_000,
      memoryBytes: 128 * 1024 * 1024,
      processes: 32,
      outputBytes: 128 * 1024,
    };
    const install: Extract<JobCommand, { type: "install" }> = {
      type: "install",
      pluginId: "fixture.jobs",
      installationRevision: "aggregate",
      artifactSha256: sha256,
      machine: {
        artifacts: {
          [`linux-${process.arch}`]: {
            url: "https://example.invalid/fixture",
            sha256,
            format: "raw",
            entry: ["fixture"],
            entrySha256: sha256,
            maxBytes: bytes.length,
            maxExpandedBytes: bytes.length,
            maxMembers: 1,
          },
        },
        locations: {
          "fixture.jobs.output": {
            anchor: "state",
            components: ["source"],
            revision: "one",
          },
        },
        operations: {
          "fixture.jobs.run": {
            argv: [],
            input: {},
            runtimeTools: ["busybox"],
            locations: [{ locationId: "fixture.jobs.output", access: "write" }],
            outputs: outputNames,
            network: "none",
            limits,
            stdin: false,
          },
        },
      },
    };
    const held: HeldDirectory[] = [];
    let owner: MachineJobOwner | null = null;
    let outputs: JobOutputStore | null = null;
    let bwrapFd = -1;
    let busyboxFd = -1;
    let detach: (() => void) | undefined;
    try {
      for (const name of ["journal", "cache", "outputs"])
        mkdirSync(join(root, name), { mode: 0o700 });
      mkdirSync(join(sourceRoot, "source"), { mode: 0o700 });
      writeFileSync(
        join(root, "cache", artifactCacheKey(Object.values(install.machine.artifacts)[0]!, sha256)),
        bytes,
        { mode: 0o500 },
      );
      const seed = new JobJournal(
        HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
      );
      seed.append({ kind: "install", command: install });
      seed.close();
      const executableParent = HeldDirectory.openAbsolute(dirname(bwrap!));
      try {
        bwrapFd = executableParent.openFile(basename(bwrap!));
      } finally {
        executableParent.close();
      }
      const runtimeParent = HeldDirectory.openAbsolute(dirname(busybox!));
      try {
        busyboxFd = runtimeParent.openFile(basename(busybox!));
      } finally {
        runtimeParent.close();
      }
      const cache = HeldDirectory.openAbsolute(join(root, "cache"), { private: true });
      held.push(cache);
      const outputDirectory = HeldDirectory.openAbsolute(join(root, "outputs"), { private: true });
      held.push(outputDirectory);
      const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
      held.push(delegatedCgroup);
      const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
      held.push(protectedRoot);
      const sourceAnchor = HeldDirectory.openAbsolute(sourceRoot, { private: true });
      held.push(sourceAnchor);
      const store = JobOutputStore.open(outputDirectory);
      outputs = store;
      const published: JobResult["outputs"] = [];
      let peakMaterializedBytes = 0;
      let peakPublishedBytes = 0;
      const observePayload = () => {
        const materialized = outputDirectory
          .names()
          .filter((name) => name.startsWith(".stage-") || /\.(tar|raw)$/.test(name))
          .reduce(
            (total, name) => total + lstatSync(`${outputDirectory.procPath}/${name}`).size,
            0,
          );
        peakMaterializedBytes = Math.max(peakMaterializedBytes, materialized);
        peakPublishedBytes = Math.max(
          peakPublishedBytes,
          store.recovered("aggregate").reduce((total, output) => total + output.bytes, 0),
        );
      };
      // Observe real retained bytes before the owner can roll back a successful seal,
      // and before the real sealer discards a rejected partially materialized archive.
      const seal = store.seal.bind(store);
      store.seal = (...args) => {
        try {
          const output = seal(...args);
          published.push(output);
          return output;
        } finally {
          observePayload();
        }
      };
      const unlink = outputDirectory.unlink.bind(outputDirectory);
      outputDirectory.unlink = (name) => {
        if (name.startsWith(".stage-")) observePayload();
        unlink(name);
      };
      owner = await MachineJobOwner.open({
        machineId: "machine",
        admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        journal: new JobJournal(
          HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
        ),
        cache,
        managedState: protectedRoot.openChild("locations", { create: true }),
        outputs: store,
        delegatedCgroup,
        bubblewrapFd: bwrapFd,
        anchors: { state: sourceAnchor },
        protectedDirectories: [protectedRoot],
        runtimeTools: {
          busybox: [{ fd: busyboxFd, target: "/bin/busybox", writable: false }],
        },
        artifactAuthority: {
          origins: ["https://example.invalid"],
          maxRedirects: 0,
          timeoutMs: 1000,
        },
      });
      const completed = Promise.withResolvers<JobResult>();
      detach = owner.attach((event) => {
        if (event.type === "refusal") completed.reject(new Error(event.reason));
        if (
          event.type === "result" &&
          ["exited", "interrupted", "cancelled"].includes(event.result.state)
        )
          completed.resolve(event.result);
        return true;
      });
      const requestBody = {
        jobId: "aggregate",
        machineId: "machine",
        operationId: "fixture.jobs.run",
        pluginId: "fixture.jobs",
        installationRevision: "aggregate",
        artifactSha256: sha256,
        input: {},
        limits,
        outputs: outputNames.map((name) => ({
          name,
          locationId: "fixture.jobs.output",
          components: [name],
        })),
        parent: null,
        credential: {
          principalId: "actor",
          tokenId: "token",
          grantId: "grant",
          caps: [],
          containerScope: null,
        },
        traceId: "trace",
      };
      const request: JobRequest = { ...requestBody, requestDigest: jobDigest(requestBody) };
      const now = Date.now();
      const permitBody = {
        permitId: "aggregate-permit",
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        ownerId: owner.identity.ownerId,
        ownerGeneration: owner.identity.generation,
        decisionId: "decision",
        policyRevision: "policy",
        issuedAt: now,
        expiresAt: now + 30000,
      };
      await owner.execute({
        type: "start",
        request,
        permit: {
          ...permitBody,
          signature: sign(
            null,
            Buffer.from(canonicalJobJson(permitBody)),
            keys.privateKey,
          ).toString("base64"),
        },
      });
      const result = await completed.promise;
      expect(result.state).toBe("exited");
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBe("output_collection_refused");
      // Both source payloads really exist, consume no tmpfs data blocks, and would
      // fit separately including tar framing. Only their shared budget is exceeded.
      for (const name of outputNames) {
        const source = lstatSync(join(sourceRoot, "source", name, "hole"));
        expect(source.size).toBe(sparseBytes);
        expect(source.blocks).toBe(0);
      }
      const first = published.find((output) => output.name === "first");
      expect(first?.bytes).toBe(sparseBytes + 1536);
      expect(first!.bytes).toBeLessThan(limits.outputBytes);
      expect(first!.bytes * outputNames.length).toBeGreaterThan(limits.outputBytes);
      expect(peakPublishedBytes).toBe(first!.bytes + Buffer.byteLength("sparse-ready"));
      expect(peakMaterializedBytes).toBe(peakPublishedBytes);
      expect(peakMaterializedBytes).toBeLessThanOrEqual(limits.outputBytes);
      expect(result.outputs).toEqual([]);
      expect(store.recovered(request.jobId)).toEqual([]);
      expect(outputDirectory.names()).toEqual([]);
      for (const output of published)
        expect(() => store.read(request.jobId, output.outputId, 0, 1)).toThrow(
          "unknown_job_output",
        );
    } finally {
      detach?.();
      await owner?.shutdown();
      outputs?.close();
      if (bwrapFd >= 0) closeSync(bwrapFd);
      if (busyboxFd >= 0) closeSync(busyboxFd);
      for (const directory of held) directory.close();
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(!linux || !cgroupRoot)(
  "native direct invocation projects PATCH results and binds cancellation and owner authorization to invoke",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "owner-direct-service-"));
    const held: HeldDirectory[] = [];
    let owner: MachineJobOwner | undefined;
    let journal: JobJournal | undefined;
    let outputs: JobOutputStore | undefined;
    let detach: (() => void) | undefined;
    let blocked = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const requests: { method: string; body: unknown }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({ method: request.method, body: await request.json() });
        if (blocked) {
          entered.resolve();
          return release.promise;
        }
        return Response.json({ changed: true, private: { credential: "never-disclose" } });
      },
    });
    try {
      for (const name of ["journal", "cache", "outputs"])
        mkdirSync(join(root, name), { mode: 0o700 });
      const cache = HeldDirectory.openAbsolute(join(root, "cache"), { private: true });
      const outputDirectory = HeldDirectory.openAbsolute(join(root, "outputs"), { private: true });
      const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
      const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
      held.push(cache, outputDirectory, delegatedCgroup, protectedRoot);
      journal = new JobJournal(
        HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
      );
      outputs = JobOutputStore.open(outputDirectory);
      const keys = generateKeyPairSync("ed25519");
      owner = await MachineJobOwner.open({
        machineId: "machine",
        admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        journal,
        cache,
        managedState: protectedRoot.openChild("locations", { create: true }),
        outputs,
        delegatedCgroup,
        protectedDirectories: [protectedRoot],
        bubblewrapFd: -1,
        anchors: {},
        runtimeTools: {},
        artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
      });
      const events: JobEvent[] = [];
      detach = owner.attach((raw) => {
        const event = JobEventSchema.parse(raw);
        events.push(event);
        if (event.type === "service_authorize") {
          expect(event.subject.kind).toBe("invoke");
          void owner!.execute({
            type: "service_authorized",
            subject: event.subject,
            authorizationId: event.authorizationId,
            allowed: true,
          });
        }
        return true;
      });
      const policy: ServicePolicy = {
        serviceId: "inventory",
        revision: "r1",
        origin: server.url.origin,
        allowLoopbackHttp: true,
        maxConcurrent: 1,
        operations: {
          update: {
            method: "PATCH",
            invocable: true,
            path: "/metadata",
            input: { enabled: { type: "boolean", required: true } },
            query: {},
            body: [{ path: ["enabled"], value: { input: "enabled" } }],
            timeoutMs: 5000,
            maxRequestBytes: 1024,
            maxResponseBytes: 4096,
            maxResultBytes: 1024,
            response: { kind: "projected-json", fields: [["changed"]], maxArrayItems: 1 },
          },
        },
      };
      await owner.execute({
        type: "configure_services",
        configuration: { revision: jobDigest([policy]), policies: [policy] },
      });
      const command = {
        type: "service_invoke" as const,
        requestId: "invoke-1",
        machineId: "machine",
        serviceId: policy.serviceId,
        revision: policy.revision,
        policySha256: jobDigest(policy),
        operationId: "update",
        input: { enabled: true },
      };
      await owner.execute({ ...command, revision: "stale" });
      expect(events.at(-1)).toMatchObject({
        type: "service_invoke_result",
        reply: { ok: false, refusal: "service_binding_mismatch" },
      });
      await owner.execute({ ...command, type: "service_read" });
      expect(events.at(-1)).toMatchObject({
        type: "service_read_result",
        reply: { ok: false, refusal: "service_binding_mismatch" },
      });
      expect(requests).toEqual([]);
      await owner.execute(command);
      expect(events.at(-1)).toEqual({
        type: "service_invoke_result",
        requestId: "invoke-1",
        reply: {
          type: "service_result",
          requestId: "invoke-1",
          ok: true,
          result: { changed: true },
        },
      });
      expect(requests).toEqual([{ method: "PATCH", body: { enabled: true } }]);
      expect(JSON.stringify(events)).not.toContain("never-disclose");
      blocked = true;
      const pending = owner.execute({ ...command, requestId: "invoke-2" });
      await entered.promise;
      await owner.execute({ type: "drain", draining: true });
      expect(owner.maintenanceReady).toBe(false);
      await owner.execute({ type: "service_invoke_cancel", requestId: "invoke-2" });
      await pending;
      expect(owner.maintenanceReady).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "service_invoke_result",
        requestId: "invoke-2",
        reply: { ok: false, refusal: "service_cancelled" },
      });
      expect(
        journal.records.some(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            Reflect.get(record, "kind") === "reservation",
        ),
      ).toBe(false);
    } finally {
      release.resolve(Response.json({ changed: true }));
      detach?.();
      if (owner) await owner.shutdown();
      else journal?.close();
      outputs?.close();
      for (const directory of held) directory.close();
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

async function resourceServiceOwner(scope: "job" | "instance") {
  const root = mkdtempSync(join(tmpdir(), "owner-resource-service-"));
  const held: HeldDirectory[] = [];
  mkdirSync(join(root, "private"), { mode: 0o700 });
  mkdirSync(join(root, "tool"), { mode: 0o700 });
  const toolPath = join(root, "tool", "helper");
  writeFileSync(toolPath, "reviewed runtime", { mode: 0o400 });
  const state = HeldDirectory.openAbsolute(join(root, "private"), { private: true });
  const tool = HeldDirectory.openAbsolute(join(root, "tool"));
  const cache = state.openChild("cache", { create: true });
  const managedState = state.openChild("locations", { create: true });
  const outputDirectory = state.openChild("outputs", { create: true });
  const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
  held.push(state, tool, cache, managedState, outputDirectory, delegatedCgroup);
  const outputs = JobOutputStore.open(outputDirectory);
  const keys = generateKeyPairSync("ed25519");
  const options = {
    machineId: "machine",
    admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    cache,
    managedState,
    outputs,
    delegatedCgroup,
    bubblewrapFd: -1,
    anchors: {},
    runtimeTools: { tool: [{ fd: tool.fd, target: "/runtime/tool", writable: false }] },
    protectedDirectories: [state],
    artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
  };
  const open = () =>
    MachineJobOwner.open({
      ...options,
      journal: new JobJournal(state.openChild("journal", { create: true })),
    });
  let owner = await open();
  const events: JobEvent[] = [];
  const attach = () =>
    owner.attach((event) => {
      events.push(event);
      if (event.type === "service_authorize")
        void owner.execute({
          type: "service_authorized",
          subject: event.subject,
          authorizationId: event.authorizationId,
          allowed: true,
        });
      return true;
    });
  let detach = attach();
  const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 1024 };
  const makeInstall = (pluginId: string): Extract<JobCommand, { type: "install" }> => {
    const bytes = Buffer.from(`#!/bin/sh\n# ${pluginId}\nexit 0\n`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      type: "install",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
      artifact: { bundleFile: "worker", data: bytes.toString("base64") },
      resourceBindings: { tools: {}, anchors: {}, services: {} },
      machine: {
        requiresResourceBindings: true,
        artifacts: {
          [`linux-${process.arch}`]: {
            bundleFile: "worker",
            sha256: hash,
            format: "raw",
            entry: ["worker"],
            entrySha256: hash,
            maxBytes: bytes.length,
            maxExpandedBytes: bytes.length,
            maxMembers: 1,
          },
        },
        locations: {},
        operations: {
          [`${pluginId}.run`]: {
            argv: [],
            input: {},
            runtimeTools: [],
            locations: [],
            outputs: [],
            network: "none",
            limits,
            stdin: false,
          },
        },
      },
    };
  };
  const provider = makeInstall("fixture.provider");
  provider.resourceBindings!.tools.tool = owner.identity.resources!.tools.tool!;
  Object.assign(provider.machine.operations["fixture.provider.run"]!, {
    runtimeTools: ["tool"],
    network: "host",
    providesService: true,
    inputFiles: { bearer: { generated: "service-bearer" } },
  });
  const policy: ServicePolicy = {
    serviceId: "fixture.runtime",
    revision: "r1",
    maxConcurrent: 1,
    runtime: {
      scope,
      pluginId: provider.pluginId,
      operationId: "fixture.provider.run",
      installationRevision: "r1",
      artifactSha256: provider.artifactSha256,
      resourceBindingDigest: jobDigest(provider.resourceBindings),
      input: {},
    },
    operations: {
      read: {
        readable: true,
        method: "GET",
        path: "/items",
        input: {},
        query: {},
        body: [],
        timeoutMs: 1000,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        maxResultBytes: 1024,
        response: { kind: "projected-json", fields: [["value"]], maxArrayItems: 1 },
      },
      generate: {
        kind: "http-proxy",
        method: "POST",
        path: "/generate",
        request: { kind: "json", disclosure: "full" },
        response: {
          kind: "stream",
          disclosure: "full",
          contentTypes: ["application/json"],
          headers: [],
        },
        timeoutMs: 1000,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      },
    },
  };
  if (scope === "job") delete policy.operations.read;
  const configuration = { revision: jobDigest([policy]), policies: [policy] };
  const consumer = makeInstall("fixture.consumer");
  consumer.resourceBindings!.services[policy.serviceId] = jobDigest(policy);
  consumer.machine.operations["fixture.consumer.run"]!.services = [
    { serviceId: policy.serviceId, revision: policy.revision, operationIds: ["generate"] },
  ];
  try {
    await owner.execute(provider);
    await owner.execute({ type: "configure_services", configuration });
    await owner.execute(consumer);
    expect(owner.identity.resources!.services[policy.serviceId]).toBe(jobDigest(policy));
  } catch (error) {
    detach();
    await owner.shutdown();
    outputs.close();
    for (const directory of held.reverse()) directory.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    get owner() {
      return owner;
    },
    events,
    policy,
    provider,
    consumer,
    mutateTool() {
      chmodSync(toolPath, 0o600);
      writeFileSync(toolPath, "unpromoted replacement");
      chmodSync(toolPath, 0o400);
    },
    async recoverWithoutProviderArtifact() {
      detach();
      await owner.shutdown();
      const artifact = Object.values(provider.machine.artifacts)[0]!;
      cache.unlink(artifactCacheKey(artifact, artifact.entrySha256));
      owner = await open();
      detach = attach();
      await owner.execute({ type: "configure_services", configuration });
      await owner.execute({
        type: "owner_challenge",
        machineId: options.machineId,
        admissionPublicKey: options.admissionPublicKey,
        nonce: "recovered",
        serverEpoch: "hub",
      });
      await owner.execute({ type: "drain", draining: false });
    },
    async close() {
      detach();
      await owner.shutdown();
      outputs.close();
      for (const directory of held.reverse()) directory.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!linux || !cgroupRoot)(
  "reacquired runtime artifacts restore dependent service readiness without new configuration",
  async () => {
    const fixture = await resourceServiceOwner("job");
    try {
      await fixture.recoverWithoutProviderArtifact();
      expect(fixture.owner.identity.resources!.services[fixture.policy.serviceId]).toBeUndefined();
      expect(
        fixture.events.findLast(
          (event) => event.type === "installed" && event.pluginId === fixture.consumer.pluginId,
        ),
      ).toMatchObject({
        resources: {
          operations: [
            {
              operationId: "fixture.consumer.run",
              available: false,
              reason: "services_unavailable",
            },
          ],
        },
      });
      fixture.events.length = 0;
      await fixture.owner.execute(fixture.provider);
      expect(fixture.owner.identity.resources!.services[fixture.policy.serviceId]).toBe(
        jobDigest(fixture.policy),
      );
      expect(
        fixture.events.findLast(
          (event) => event.type === "installed" && event.pluginId === fixture.consumer.pluginId,
        ),
      ).toMatchObject({
        resources: { operations: [{ operationId: "fixture.consumer.run", available: true }] },
      });
    } finally {
      await fixture.close();
    }
  },
);

test.skipIf(!linux || !cgroupRoot).each(["read", "tunnel"] as const)(
  "%s service authority refreshes a changed runtime before seeking a hub grant",
  async (mode) => {
    const fixture = await resourceServiceOwner("instance");
    try {
      const call = async () => {
        if (mode === "read") {
          const requestId = `read-${fixture.events.length}`;
          await fixture.owner.execute({
            type: "service_read",
            requestId,
            machineId: "machine",
            serviceId: fixture.policy.serviceId,
            revision: fixture.policy.revision,
            policySha256: jobDigest(fixture.policy),
            operationId: "read",
            input: {},
          });
          const result = fixture.events.findLast(
            (event) => event.type === "service_read_result" && event.requestId === requestId,
          );
          if (result?.type !== "service_read_result") throw new Error("missing_service_result");
          return result.reply.ok ? "ok" : result.reply.refusal;
        }
        const channelId = `tunnel-${fixture.events.length}`;
        await fixture.owner.execute({
          type: "service_tunnel_open",
          channelId,
          serviceId: fixture.policy.serviceId,
          revision: fixture.policy.revision,
          policySha256: jobDigest(fixture.policy),
          operationIds: ["generate"],
        });
        const ready = fixture.events.findLast(
          (event) => event.type === "service_tunnel_ready" && event.channelId === channelId,
        );
        if (ready?.type !== "service_tunnel_ready" || !ready.endpoint)
          throw new Error("missing_service_tunnel");
        const response = await fetch(`${ready.endpoint.url}/generate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ready.endpoint.bearer}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        await response.arrayBuffer();
        return response.status;
      };
      // Authorization precedes endpoint resolution, so no workload needs to be spawned.
      await call();
      expect(fixture.events.some((event) => event.type === "service_authorize")).toBe(true);
      fixture.events.length = 0;
      fixture.mutateTool();
      expect(await call()).toBe(mode === "read" ? "service_unauthorized" : 403);
      expect(fixture.events.some((event) => event.type === "service_authorize")).toBe(false);
      expect(fixture.owner.identity.resources!.services[fixture.policy.serviceId]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  },
);

const instanceServiceWorker = process.env.MANIFOLD_TEST_INSTANCE_SERVICE;
test.skipIf(!realBackend || !instanceServiceWorker).each([
  "cooperative", "lost-completion", "launch-race", "noncooperative",
] as const)(
  "instance retirement preserves native %s ownership until confirmed exit",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "owner-retirement-"));
    const held: HeldDirectory[] = [];
    const keys = generateKeyPairSync("ed25519");
    let owner: MachineJobOwner | undefined;
    let outputs: JobOutputStore | undefined;
    let bwrapFd = -1;
    let restoreLaunch: (() => void) | undefined;
    const handoff = Promise.withResolvers<void>();
    let launching: Promise<void> | undefined;
    try {
      const state = HeldDirectory.openAbsolute(root, { private: true });
      const cache = state.openChild("cache", { create: true });
      const managedState = state.openChild("locations", { create: true });
      const outputDirectory = state.openChild("outputs", { create: true });
      const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
      held.push(state, cache, managedState, outputDirectory, delegatedCgroup);
      const executableParent = HeldDirectory.openAbsolute(dirname(bwrap!));
      bwrapFd = executableParent.openRuntimeFile(basename(bwrap!));
      executableParent.close();
      outputs = JobOutputStore.open(outputDirectory);
      owner = await MachineJobOwner.open({
        machineId: "machine",
        admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        journal: new JobJournal(state.openChild("journal", { create: true })),
        cache, managedState, outputs, delegatedCgroup,
        bubblewrapFd: bwrapFd,
        anchors: {},
        runtimeTools: {},
        protectedDirectories: [state],
        artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
      });
      const bytes = readFileSync(instanceServiceWorker!);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const limits = {
        timeoutMs: 10_000, memoryBytes: 64 * 1024 * 1024, processes: 16, outputBytes: 65536,
      };
      const install: Extract<JobCommand, { type: "install" }> = {
        type: "install",
        pluginId: "fixture.retirement",
        installationRevision: "r1",
        artifactSha256: hash,
        artifact: { bundleFile: "worker", data: bytes.toString("base64") },
        machine: {
          artifacts: {
            [`linux-${process.arch}`]: {
              bundleFile: "worker", sha256: hash, format: "raw", entry: ["worker"],
              entrySha256: hash, maxBytes: bytes.length, maxExpandedBytes: bytes.length,
              maxMembers: 1,
            },
          },
          locations: {
            "fixture.retirement.state": {
              managed: true, anchor: "state", components: ["service"], revision: "r1",
              kind: "directory", guestPath: "/home/job/service-state",
            },
          },
          operations: {
            "fixture.retirement.serve": {
              argv: [], input: {}, runtimeTools: [], providesService: true,
              environment: {
                FIXED_SERVICE_SETTING: "reviewed",
                WAIT_FOR_FLUSH: "1",
                ...(mode === "noncooperative" ? { IGNORE_RETIREMENT: "1" } : {}),
              },
              inputFiles: { serviceBearer: { generated: "service-bearer" } },
              locations: [{ locationId: "fixture.retirement.state", access: "write" }],
              outputs: [], network: "host", limits, stdin: false,
            },
          },
        },
      };
      const policy: ServicePolicy = {
        serviceId: "fixture.retirement.service",
        revision: "r1",
        maxConcurrent: 1,
        runtime: {
          scope: "instance", pluginId: install.pluginId, operationId: "fixture.retirement.serve",
          installationRevision: "r1", artifactSha256: hash,
          resourceBindingDigest: jobDigest(null), input: {},
        },
        operations: {
          snapshot: {
            readable: true, method: "GET", path: "/snapshot", input: {}, query: {}, body: [],
            timeoutMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 1024, maxResultBytes: 1024,
            response: { kind: "projected-json", fields: [["starts"]], maxArrayItems: 1 },
          },
        },
      };
      const events: JobEvent[] = [];
      const ready = Promise.withResolvers<void>();
      const draining = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<JobResult>();
      let stdout = "";
      let transportConnected = true;
      const receive = (event: JobEvent): boolean => {
        // Observe native finalization even when the transport refuses delivery.
        if (event.type === "result" && event.result.jobId === "retiring" &&
            event.result.finishedAt !== null) finished.resolve(event.result);
        if (!transportConnected) return false;
        events.push(JobEventSchema.parse(event));
        if (event.type === "service_ready" && event.jobId === "retiring") ready.resolve();
        if (event.type === "output" && event.jobId === "retiring" && event.outputId === "stdout") {
          stdout += Buffer.from(event.data, "base64").toString();
          if (stdout.includes("draining")) draining.resolve();
        }
        return true;
      };
      const detach = owner.attach(receive);
      await owner.execute(install);
      await owner.execute({
        type: "configure_services",
        configuration: { revision: jobDigest([policy]), policies: [policy] },
      });
      const admission = (jobId: string, instance = true) => {
        const body = {
          jobId, machineId: "machine", pluginId: install.pluginId,
          operationId: "fixture.retirement.serve", installationRevision: "r1",
          artifactSha256: hash, input: {}, outputs: [],
          limits: { ...limits, timeoutMs: instance ? 0 : limits.timeoutMs },
          credential: {
            principalId: "actor", tokenId: null, grantId: null, caps: [], containerScope: null,
          },
          parent: null, traceId: "retirement",
          ...(instance ? { service: {
            serviceId: policy.serviceId, revision: "r1", policySha256: jobDigest(policy),
          } } : {}),
        };
        const request = { ...body, requestDigest: jobDigest(body) };
        const now = Date.now();
        const permit = {
          permitId: jobId, jobId, requestDigest: request.requestDigest,
          ownerId: owner!.identity.ownerId, ownerGeneration: owner!.identity.generation,
          decisionId: "decision", policyRevision: "policy",
          issuedAt: now, expiresAt: now + 30000,
        };
        return {
          request,
          permit: {
            ...permit,
            signature: sign(null, Buffer.from(canonicalJobJson(permit)), keys.privateKey)
              .toString("base64"),
          },
        };
      };
      // Retirement cannot even reconcile absence for an ordinary signed job.
      await expect(owner.execute({
        type: "retire", jobId: "ordinary", reason: "replace", admission: admission("ordinary", false),
      })).rejects.toThrow();
      expect(events.some((event) =>
        event.type === "workload_empty" && event.jobId === "ordinary")).toBe(false);

      const command = { type: "start" as const, ...admission("retiring") };
      if (mode === "launch-race" || mode === "noncooperative") {
        const nativeStarted = Promise.withResolvers<void>();
        const launch = startLinuxJob;
        const spy = spyOn(nativeRuntime, "startLinuxJob").mockImplementation(async (spec) => {
          const handle = await launch(spec);
          nativeStarted.resolve();
          await handoff.promise;
          return handle;
        });
        restoreLaunch = () => spy.mockRestore();
        launching = owner.execute(command);
        await Promise.race([
          nativeStarted.promise,
          launching.then(() => { throw new Error(events.findLast(event => event.type === "refusal")?.reason ?? "native launch did not reach handoff"); }),
        ]);
      } else {
        await owner.execute(command);
        await Promise.race([
          ready.promise,
          finished.promise.then(() => {
            throw new Error(events.findLast(event => event.type === "refusal")?.reason ?? "service exited before readiness");
          }),
        ]);
      }
      const retire = { type: "retire", jobId: "retiring", reason: "replace",
        admission: { request: command.request, permit: command.permit } };
      await owner.execute(retire);
      await owner.execute(retire);
      // Retirement returns while launch is pending; native FD handoff can now complete.
      handoff.resolve();
      await launching;
      restoreLaunch?.();
      restoreLaunch = undefined;
      await Promise.race([
        draining.promise,
        finished.promise.then(() => { throw new Error("worker exited without cooperative shutdown"); }),
      ]);
      const statePath = join(root, "locations", install.pluginId, "service");
      expect(existsSync(join(statePath, "flushed"))).toBe(false);
      expect(events.some((event) =>
        event.type === "workload_empty" && event.jobId === "retiring")).toBe(false);
      events.length = 0;
      await owner.execute({ type: "status", jobId: "retiring" });
      expect(events).toContainEqual({
        type: "result", result: expect.objectContaining({ jobId: "retiring", state: "started" }),
      });
      expect(events.some((event) => event.type === "service_ready")).toBe(false);
      await owner.execute({ type: "start", ...admission("too-early") });
      expect(events).toContainEqual({
        type: "refusal", jobId: "too-early", reason: "instance_service_binding_mismatch",
      });
      expect(readFileSync(join(statePath, "starts"), "utf8")).toBe("1\n");
      if (mode === "noncooperative") {
        await owner.execute({ type: "cancel", jobId: "retiring", reason: "explicit-force" });
        expect((await finished.promise).state).toBe("cancelled");
        expect(existsSync(join(statePath, "flushed"))).toBe(false);
      } else {
        if (mode === "lost-completion") transportConnected = false;
        writeFileSync(join(statePath, "flush-allowed"), "release\n");
        const result = await finished.promise;
        expect(result).toMatchObject({ state: "exited", exitCode: 0, reason: null });
        expect(readFileSync(join(statePath, "flushed"), "utf8")).toBe("durable shutdown\n");
        if (mode === "lost-completion") {
          expect(events.some((event) => event.type === "workload_empty" ||
            (event.type === "result" && event.result.finishedAt !== null))).toBe(false);
          detach();
          transportConnected = true;
          owner.attach(receive);
          events.length = 0;
          // Reconciliation must recover both fences and the lost terminal result,
          // without status/start replay or restarting this owner or its workload.
          await owner.execute(retire);
          expect(events).toContainEqual({ type: "result", result });
        }
      }
      expect(events).toContainEqual({
        type: "workload_empty", jobId: "retiring", requestDigest: command.request.requestDigest,
        ownerId: command.permit.ownerId, ownerGeneration: command.permit.ownerGeneration,
      });
      // Replay cannot relaunch the retired identity, and exclusion ends only after empty.
      await owner.execute(retire);
      await owner.execute(command);
      expect(readFileSync(join(statePath, "starts"), "utf8")).toBe("1\n");
      await owner.execute({ type: "start", ...admission("replacement") });
      expect(events).toContainEqual(expect.objectContaining({
        type: "state", jobId: "replacement", state: "started",
      }));
    } finally {
      handoff.resolve();
      await launching;
      restoreLaunch?.();
      await owner?.shutdown();
      outputs?.close();
      if (bwrapFd >= 0) closeSync(bwrapFd);
      for (const directory of held.reverse()) directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
