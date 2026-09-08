import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import {
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
  type JobCommand,
  type JobEvent,
  type JobRequest,
  type JobResult,
} from "@manifold/protocol";
import { HeldDirectory } from "../src/job-files.ts";
import { JobJournal, jobDigest } from "../src/job-journal.ts";
import { MachineJobOwner, type JobOwnerOptions } from "../src/job-owner.ts";
import { JobOutputStore } from "../src/job-outputs.ts";

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

describe.skipIf(!realBackend || !compiledProbe)("real supervised job owner", () => {
  test("bundled worker installation runs once; transport and owner restarts never replay; stdout stays job-bound", async () => {
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
            stdin: false,
          },
        },
      },
    };
    let owner: MachineJobOwner | null = null;
    const held: HeldDirectory[] = [];
    let bwrapFd = -1;
    try {
      for (const name of ["journal", "cache", "outputs"])
        mkdirSync(join(root, name), { mode: 0o700 });
      const executableParent = HeldDirectory.openAbsolute(dirname(bwrap!));
      bwrapFd = executableParent.openFile(basename(bwrap!));
      executableParent.close();
      const cache = HeldDirectory.openAbsolute(join(root, "cache"), { private: true });
      const outputDirectory = HeldDirectory.openAbsolute(join(root, "outputs"), { private: true });
      const delegatedCgroup = HeldDirectory.openAbsolute(cgroupRoot!);
      held.push(cache, outputDirectory, delegatedCgroup);
      const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
      held.push(protectedRoot);
      const outputs = JobOutputStore.open(outputDirectory);
      const options: Omit<JobOwnerOptions, "journal"> = {
        machineId: "machine",
        admissionPublicKey,
        cache,
        outputs,
        delegatedCgroup,
        bubblewrapFd: bwrapFd,
        anchors: {},
        protectedDirectories: [protectedRoot],
        runtimeTools: {},
        artifactAuthority: {
          origins: [],
          maxRedirects: 0,
          timeoutMs: 1000,
        },
      };
      owner = await MachineJobOwner.open({
        ...options,
        journal: new JobJournal(
          HeldDirectory.openAbsolute(join(root, "journal"), { private: true }),
        ),
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
      await owner.execute({ ...install, artifact: { ...delivery, data: Buffer.from("substitution").toString("base64") } });
      expect(events.at(-1)).toMatchObject({ type: "refusal" });
      await owner.execute(install);
      expect(events.at(-1)).toMatchObject({
        type: "installed", pluginId: install.pluginId,
        installationRevision: install.installationRevision, artifactSha256: sha256,
      });
      const requestBody = {
        jobId: "once",
        machineId: "machine",
        operationId: "fixture.jobs.run",
        pluginId: "fixture.jobs",
        installationRevision: "r1",
        artifactSha256: sha256,
        input: {},
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
      expect(outputs.read("once", stdout.outputId, 0, 65536).data.toString()).toBe("private-once");
      expect(() => outputs.read("other", stdout.outputId, 0, 65536)).toThrow();
      const firstGeneration = result.ownerGeneration;
      release();
      release = owner.attach((event) => {
        events.push(event);
        return true;
      });
      await owner.execute(command);
      expect(events.at(-1)).toEqual({ type: "result", result });
      release();
      await owner.shutdown();
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
      await owner.execute(command);
      expect(events.at(-1)).toEqual({ type: "result", result });
      expect(owner.identity.generation).toBeGreaterThan(firstGeneration);
      await owner.execute({ ...command, request: interruptedRequest });
      const recovered = events.at(-1);
      expect(recovered?.type).toBe("result");
      if (recovered?.type !== "result") throw new Error("missing_recovery_result");
      expect(recovered.result.state).toBe("interrupted");
      expect(recovered.result.reason).toBe("owner_restart_effects_unknown");
      expect(recovered.result.usage).toBeNull();
      expect(recovered.result.outputs).toEqual([]);
      const changed = { ...requestBody, input: { changed: true } };
      await owner.execute({
        ...command,
        request: { ...changed, requestDigest: jobDigest(changed) },
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
      await owner?.shutdown();
      if (bwrapFd >= 0) closeSync(bwrapFd);
      for (const directory of held) directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
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
      writeFileSync(join(root, "cache", `${sha256}-${sha256}`), bytes, { mode: 0o500 });
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
