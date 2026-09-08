import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  canonicalJobJson,
  JobCommandSchema,
  JobRequestSchema,
  JobResultSchema,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type JobRequest,
  type JobResult,
  type MachineOperation,
} from "@manifold/protocol";
import type { HeldDirectory } from "./job-files.ts";
import {
  acquireArtifact,
  openCachedArtifact,
  type ArtifactAuthority,
  type PinnedArtifact,
} from "./job-artifacts.ts";
import type { JobJournal } from "./job-journal.ts";
import { jobDigest } from "./job-journal.ts";
import { JobContext } from "./job-context.ts";
import type { JobOutputStore } from "./job-outputs.ts";
import { type JobOutputLease, type JobOutputByteStream } from "./job-outputs.ts";
import {
  preflightLinuxJob,
  recoverLinuxJobs,
  startLinuxJob,
  type LinuxJobBind,
  type LinuxJobHandle,
  type LinuxJobResult,
  type LinuxJobSpec,
} from "./job-linux.ts";
import { DirectoryExclusions, resolveJobLocation, type JobLocation } from "./job-locations.ts";

export interface JobOwnerOptions {
  machineId: string;
  admissionPublicKey: string;
  journal: JobJournal;
  cache: HeldDirectory;
  outputs: JobOutputStore;
  delegatedCgroup: HeldDirectory;
  bubblewrapFd: number;
  anchors: Readonly<Record<string, HeldDirectory>>;
  protectedDirectories: readonly HeldDirectory[];
  /** Reviewed local runtime closures, not executable/cwd/env RPC fields. */
  runtimeTools: Readonly<Record<string, readonly LinuxJobBind[]>>;
  artifactAuthority: ArtifactAuthority;
}
interface Installation {
  command: Extract<JobCommand, { type: "install" }>;
  artifact: PinnedArtifact;
  enabled: boolean;
}
interface OwnedJob {
  request: JobRequest;
  result: JobResult;
  handle: LinuxJobHandle | null;
  context: JobContext | null;
  locations: Map<string, JobLocation>;
  leases: JobOutputLease[];
  releaseWriters: Array<() => void>;
  inputSeq: number;
  inputBytes: number;
  inputTail: Promise<void>;
  inputEnded: boolean;
  depth: number;
  children: Set<string>;
  empty: Promise<void>;
  resolveEmpty(): void;
  childBudgetMs: number;
  outputGap: boolean;
  cancelRequested: boolean;
  stdio: Partial<Record<"stdout" | "stderr", JobOutputByteStream>>;
  outputSeq: number;
  childExitSent: boolean;
  launched: Promise<void>;
  resolveLaunched(): void;
  finalized: Promise<void>;
  resolveFinalized(): void;
}
const ACTIVE: Record<string, true> = { "start-committed": true, started: true };

/** Independently supervised machine authority. No workload is owned by the websocket transport. */
export class MachineJobOwner {
  private readonly installs = new Map<string, Installation>();
  private readonly jobs = new Map<string, OwnedJob>();
  private readonly permits = new Set<string>();
  private readonly challenges = new Set<string>();
  private readonly admissionKey: KeyObject;
  private readonly exclusions: DirectoryExclusions;
  private sink: ((event: JobEvent) => boolean) | null = null;
  private draining = false;
  private ready = false;

  private constructor(private readonly options: JobOwnerOptions) {
    this.admissionKey = createPublicKey(options.admissionPublicKey);
    if (options.protectedDirectories.length === 0) throw new Error("private_owner_roots_required");
    this.exclusions = new DirectoryExclusions(options.protectedDirectories);
  }

  static async open(options: JobOwnerOptions): Promise<MachineJobOwner> {
    const owner = new MachineJobOwner(options);
    // Recovery proves no old descendants retain output writers before a new generation admits.
    await recoverLinuxJobs(options.delegatedCgroup);
    const recoveredInstalls = new Map<string, Extract<JobCommand, { type: "install" }>>();
    for (const raw of options.journal.records) {
      if (raw === null || typeof raw !== "object") throw new Error("invalid_job_journal_record");
      const kind = Reflect.get(raw, "kind");
      if (kind === "generation" || kind === "invocation") continue;
      if (kind === "drain") {
        owner.draining = Reflect.get(raw, "draining") === true;
        continue;
      }
      if (kind === "install") {
        const command = JobCommandSchema.parse(Reflect.get(raw, "command"));
        if (command.type !== "install") throw new Error("invalid_install_record");
        recoveredInstalls.set(
          owner.installKey(command.pluginId, command.installationRevision),
          command,
        );
        continue;
      }
      if (kind === "reservation") {
        const request = JobRequestSchema.parse(Reflect.get(raw, "request"));
        const permitId = Reflect.get(raw, "permitId");
        if (
          typeof permitId !== "string" ||
          owner.permits.has(permitId) ||
          owner.jobs.has(request.jobId)
        )
          throw new Error("duplicate_reservation_record");
        owner.permits.add(permitId);
        const job = owner.newJob(request);
        job.result = JobResultSchema.parse(Reflect.get(raw, "result"));
        owner.jobs.set(request.jobId, job);
        continue;
      }
      if (kind === "result") {
        const result = JobResultSchema.parse(Reflect.get(raw, "result"));
        const job = owner.jobs.get(result.jobId);
        if (!job || job.request.requestDigest !== result.requestDigest)
          throw new Error("orphan_job_result");
        job.result = result;
        continue;
      }
      throw new Error("unknown_job_journal_record");
    }
    for (const command of recoveredInstalls.values()) {
      if (command.action !== "purge") owner.restoreInstallation(command);
    }
    for (const job of owner.jobs.values()) {
      if (ACTIVE[job.result.state]) {
        job.result = {
          ...job.result,
          state: "interrupted",
          reason: "owner_restart_effects_unknown",
          finishedAt: Date.now(),
          usage: null,
          outputs: [],
        };
        options.journal.append({ kind: "result", result: job.result });
      }
      job.resolveEmpty();
      job.resolveLaunched();
      job.resolveFinalized();
    }
    owner.ready = true;
    return owner;
  }

  get identity(): JobOwner {
    const journal = this.options.journal;
    return {
      ownerId: journal.ownerId,
      publicKey: journal.publicKey,
      generation: journal.generation,
      platforms:
        process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")
          ? [`linux-${process.arch}`]
          : [],
      inventoryDigest: journal.inventoryDigest(),
    };
  }

  attach(sink: (event: JobEvent) => boolean): () => void {
    if (this.sink) throw new Error("job_owner_seat_taken");
    this.sink = sink;
    for (const job of this.jobs.values()) {
      if (job.outputGap) sink({ type: "refusal", jobId: job.request.jobId, reason: "output_gap" });
    }
    return () => {
      if (this.sink === sink) this.sink = null;
    };
  }

  async execute(raw: unknown): Promise<void> {
    const command = JobCommandSchema.parse(raw);
    if (!this.ready) throw new Error("job_owner_not_ready");
    try {
      switch (command.type) {
        case "owner_challenge": {
          if (
            command.machineId !== this.options.machineId ||
            command.admissionPublicKey !== this.options.admissionPublicKey
          )
            throw new Error("owner_challenge_identity_mismatch");
          const challenge = `${command.serverEpoch}:${command.nonce}`;
          if (this.challenges.has(challenge) || this.challenges.size >= 4096)
            throw new Error("owner_challenge_replayed_or_exhausted");
          this.challenges.add(challenge);
          const body = {
            nonce: command.nonce,
            serverEpoch: command.serverEpoch,
            machineId: command.machineId,
            owner: this.identity,
          };
          this.emit({ type: "owner_proof", ...body, signature: this.options.journal.proof(body) });
          return;
        }
        case "invocation_reply":
          this.requireJob(command.parentJobId).context?.reply(
            command.invocationId,
            command.jobId,
            command.reason,
          );
          return;
        case "install":
          await this.install(command);
          return;
        case "start":
          await this.start(command);
          return;
        case "drain":
          this.options.journal.append({ kind: "drain", draining: command.draining });
          this.draining = command.draining;
          return;
        case "status": {
          const job = this.requireJob(command.jobId);
          this.emit({ type: "result", result: job.result }, job);
          return;
        }
        case "cancel":
          await this.cancel(command.jobId);
          return;
        case "input": {
          const job = this.requireJob(command.jobId);
          const data = Buffer.from(command.data, "base64");
          if (
            command.seq !== job.inputSeq ||
            job.inputEnded ||
            job.inputBytes + data.length > job.request.limits.outputBytes ||
            !job.handle
          )
            throw new Error("job_input_gap_or_limit");
          job.inputSeq++;
          job.inputBytes += data.length;
          const handle = job.handle;
          job.inputEnded = command.eof;
          const accepted = job.inputTail.then(async () => {
            await handle.input(data);
            if (command.eof) handle.endInput();
          });
          job.inputTail = accepted;
          await accepted;
          return;
        }
        case "output_read": {
          const output = this.options.outputs.read(
            command.jobId,
            command.outputId,
            command.offset,
            command.maxBytes,
          );
          this.emit({
            type: "output",
            jobId: command.jobId,
            outputId: command.outputId,
            requestId: command.requestId,
            seq: command.offset,
            data: output.data.toString("base64"),
            eof: output.eof,
          });
          return;
        }
        case "output_release":
          this.options.outputs.release(command.jobId, command.outputId);
          return;
      }
    } catch (error) {
      const jobId =
        "jobId" in command && command.jobId !== null
          ? command.jobId
          : command.type === "start"
            ? command.request.jobId
            : "owner";
      // Only fixed identifiers cross the wire; syscall paths and exception text stay private.
      const reason =
        error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message)
          ? error.message
          : "job_command_refused";
      const job = this.jobs.get(jobId);
      if (command.type === "input" && job)
        await this.cancel(jobId).catch(() => {
          this.draining = true;
        });
      this.emit({ type: "refusal", jobId, reason }, job);
    }
  }

  private restoreInstallation(command: Extract<JobCommand, { type: "install" }>): void {
    const spec = command.machine.artifacts[this.platform()];
    if (!spec || spec.sha256 !== command.artifactSha256)
      throw new Error("installed_artifact_platform_mismatch");
    const artifact = openCachedArtifact(spec, this.options.cache);
    const key = this.installKey(command.pluginId, command.installationRevision);
    this.installs.get(key)?.artifact.close();
    this.installs.set(key, {
      command: { ...command, action: undefined },
      enabled: command.action !== "disable",
      artifact,
    });
  }

  private async install(command: Extract<JobCommand, { type: "install" }>): Promise<void> {
    if (this.draining && !command.action) throw new Error("owner_draining");
    const key = this.installKey(command.pluginId, command.installationRevision);
    const existing = this.installs.get(key);
    if (command.action) {
      if (
        !existing ||
        existing.command.artifactSha256 !== command.artifactSha256 ||
        jobDigest(existing.command.machine) !== jobDigest(command.machine)
      )
        throw new Error("installation_revision_changed");
      const affected = [...this.jobs.values()].filter(
        (job) => job.request.pluginId === command.pluginId,
      );
      if (
        command.action === "purge" &&
        affected.some((job) => ACTIVE[job.result.state] || job.leases.length > 0)
      )
        throw new Error("installation_active_leases");
      this.options.journal.append({ kind: "install", command });
      existing.enabled = false;
      if (command.action === "disable") {
        for (const installation of this.installs.values()) {
          if (
            installation !== existing &&
            installation.command.pluginId === command.pluginId &&
            installation.enabled
          ) {
            this.options.journal.append({
              kind: "install",
              command: { ...installation.command, action: "disable" },
            });
            installation.enabled = false;
          }
        }
        await Promise.all(affected.map((job) => this.cancel(job.request.jobId)));
      } else {
        for (const job of affected)
          for (const output of this.options.outputs.recovered(job.request.jobId))
            this.options.outputs.release(job.request.jobId, output.outputId);
        existing.artifact.close();
        this.installs.delete(key);
        const spec = command.machine.artifacts[this.platform()]!;
        const digests = new Set([
          spec.entrySha256,
          ...Object.values(spec.files ?? {}).map((file) => file.sha256),
        ]);
        for (const digest of digests) {
          const shared = [...this.installs.values()].some((installation) => {
            const other = installation.command.machine.artifacts[this.platform()];
            return (
              other?.sha256 === spec.sha256 &&
              (other.entrySha256 === digest ||
                Object.values(other.files ?? {}).some((file) => file.sha256 === digest))
            );
          });
          if (!shared) this.options.cache.unlink(`${spec.sha256}-${digest}`);
        }
      }
      this.emit({
        type: "installed",
        pluginId: command.pluginId,
        installationRevision: command.installationRevision,
        artifactSha256: command.artifactSha256,
      });
      return;
    }
    if (existing) {
      if (jobDigest(existing.command) !== jobDigest(command))
        throw new Error("installation_revision_changed");
      if (!existing.enabled) {
        this.options.journal.append({ kind: "install", command });
        existing.enabled = true;
      }
    } else {
      if (this.installs.size >= 128) throw new Error("installation_capacity");
      const artifactSpec = command.machine.artifacts[this.platform()];
      if (!artifactSpec || artifactSpec.sha256 !== command.artifactSha256)
        throw new Error("unsupported_artifact_platform");
      for (const locationId of Object.keys(command.machine.locations))
        if (!locationId.startsWith(`${command.pluginId}.`))
          throw new Error("location_namespace_mismatch");
      for (const [id, operation] of Object.entries(command.machine.operations)) {
        if (!id.startsWith(`${command.pluginId}.`)) throw new Error("operation_namespace_mismatch");
        for (const tool of operation.runtimeTools)
          if (!this.options.runtimeTools[tool] && !artifactSpec.files?.[tool])
            throw new Error("runtime_tool_unavailable");
        for (const location of operation.locations)
          if (!command.machine.locations[location.locationId])
            throw new Error("undeclared_location");
      }
      const artifact = await acquireArtifact(
        artifactSpec,
        this.options.cache,
        this.options.artifactAuthority,
      );
      try {
        if (this.draining || this.installs.has(key)) throw new Error("installation_raced");
        this.options.journal.append({ kind: "install", command });
        this.installs.set(key, { command, artifact, enabled: true });
      } catch (error) {
        artifact.close();
        throw error;
      }
    }
    this.emit({
      type: "installed",
      pluginId: command.pluginId,
      installationRevision: command.installationRevision,
      artifactSha256: command.artifactSha256,
    });
  }

  private async start(command: Extract<JobCommand, { type: "start" }>): Promise<void> {
    const { request, permit } = command;
    const { requestDigest, ...immutable } = request;
    if (jobDigest(immutable) !== requestDigest) throw new Error("request_digest_mismatch");
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (existing.request.requestDigest !== requestDigest) throw new Error("job_identity_changed");
      this.emit({ type: "result", result: existing.result }, existing);
      return;
    }
    if ([...this.jobs.values()].filter((job) => ACTIVE[job.result.state]).length >= 64)
      throw new Error("owner_active_job_limit");
    const now = Date.now();
    const { signature, ...signedPermit } = permit;
    if (
      this.draining ||
      request.machineId !== this.options.machineId ||
      permit.jobId !== request.jobId ||
      permit.requestDigest !== requestDigest ||
      permit.ownerId !== this.options.journal.ownerId ||
      permit.ownerGeneration !== this.options.journal.generation ||
      permit.expiresAt <= now ||
      permit.issuedAt > now ||
      permit.expiresAt - permit.issuedAt > 30_000 ||
      this.permits.has(permit.permitId) ||
      !verify(
        null,
        Buffer.from(canonicalJobJson(signedPermit)),
        this.admissionKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error("start_permit_refused");
    const installation = this.installs.get(
      this.installKey(request.pluginId, request.installationRevision),
    );
    const operation = installation?.command.machine.operations[request.operationId];
    if (
      !installation?.enabled ||
      !operation ||
      installation.command.artifactSha256 !== request.artifactSha256
    )
      throw new Error("operation_not_installed");
    this.validateInput(operation, request);
    let parent: OwnedJob | undefined;
    if (request.parent) {
      parent = this.requireJob(request.parent.parentJobId);
      const invocation = parent.context?.invocations.get(request.parent.invocationId);
      if (
        !ACTIVE[parent.result.state] ||
        !parent.handle ||
        !invocation ||
        invocation.refused ||
        invocation.childJobId !== null ||
        parent.depth >= 8 ||
        parent.children.size >= 16 ||
        parent.childBudgetMs + request.limits.timeoutMs > parent.request.limits.timeoutMs ||
        jobDigest(request.credential) !== jobDigest(parent.request.credential) ||
        invocation.operationId !== request.operationId ||
        jobDigest(invocation.input) !== jobDigest(request.input) ||
        jobDigest(invocation.outputs) !== jobDigest(request.outputs)
      )
        throw new Error("parent_invocation_refused");
    }
    const job = this.newJob(request);
    job.depth = parent ? parent.depth + 1 : 0;
    try {
      if (request.outputs.length > 30) throw new Error("output_count_limit");
      job.stdio.stdout = this.options.outputs.createByteStream(
        request.jobId,
        "stdout",
        request.limits.outputBytes,
      );
      job.stdio.stderr = this.options.outputs.createByteStream(
        request.jobId,
        "stderr",
        request.limits.outputBytes,
      );
      const locations: LinuxJobBind[] = [];
      // This token is private to synchronous preparation, before any writable fd is mounted.
      const preparation = {};
      for (const declaration of operation.locations) {
        const resource = installation.command.machine.locations[declaration.locationId]!;
        const anchor = this.options.anchors[resource.anchor];
        if (!anchor || job.locations.has(declaration.locationId))
          throw new Error("location_anchor_unavailable_or_duplicate");
        const resolved = resolveJobLocation(
          anchor,
          declaration.locationId,
          resource,
          declaration.access,
          this.exclusions,
          (parentFd) => this.options.outputs.assertCreateAllowed(parentFd, preparation),
        );
        job.locations.set(declaration.locationId, resolved);
        if (resolved.writable)
          job.releaseWriters.push(
            this.options.outputs.retainWriter(resolved.fd, resolved.parentFd, preparation),
          );
        locations.push({
          fd: resolved.fd,
          target: resolved.guestPath,
          writable: resolved.writable,
        });
      }
      for (const binding of request.outputs) {
        if (
          !operation.outputs.includes(binding.name) ||
          job.leases.some((lease) => lease.name === binding.name)
        )
          throw new Error("undeclared_output");
        const location =
          parent?.locations.get(binding.locationId) ?? job.locations.get(binding.locationId);
        if (!location?.writable || !location.directory)
          throw new Error("output_location_not_writable_directory");
        job.leases.push(
          this.options.outputs.create(
            request.jobId,
            binding,
            location.directory,
            request.limits.outputBytes,
          ),
        );
      }
      job.context = new JobContext(request.jobId, {
        invoke: (event) => {
          this.options.journal.append({
            kind: "invocation",
            parentJobId: event.parentJobId,
            invocationId: event.invocationId,
            digest: jobDigest(event),
          });
          this.emit(event);
        },
        command: (next) => this.execute(next),
        failure: (reason) => {
          const pending = [...(job.context?.invocations.values() ?? [])].some(
            (invocation) =>
              !invocation.refused &&
              (invocation.childJobId === null ||
                !this.jobs.get(invocation.childJobId)?.childExitSent),
          );
          // Closing an unused context during ordinary process exit is not a cancellation.
          if (reason === "context_closed" && !pending) return;
          void this.cancel(request.jobId).catch(() => {
            this.draining = true;
          });
        },
      });
      job.context.send({
        type: "context",
        locations: [...job.locations].map(([locationId, location]) => ({
          locationId,
          guestPath: location.guestPath,
          access: location.access,
        })),
      });
      const runtime: LinuxJobBind[] = [];
      for (const tool of operation.runtimeTools) {
        const bundled = installation.artifact.files[tool];
        const configured = bundled
          ? [{ fd: bundled.fd, target: `/runtime/bin/${tool}`, writable: false }]
          : this.options.runtimeTools[tool];
        if (!configured) throw new Error("runtime_tool_unavailable");
        for (const bind of configured)
          if (!runtime.some((prior) => prior.fd === bind.fd && prior.target === bind.target))
            runtime.push(bind);
      }
      const spec: LinuxJobSpec = {
        bubblewrapFd: this.options.bubblewrapFd,
        artifactFd: installation.artifact.fd,
        argv: operation.argv.map((slot) =>
          "literal" in slot ? slot.literal : String(request.input[slot.input]),
        ),
        runtime,
        locations,
        outputs: job.leases.map((lease) => ({
          fd: lease.directory.fd,
          target: `/outputs/${lease.name}`,
          writable: true,
        })),
        delegatedCgroup: parent?.handle?.childDelegation ?? this.options.delegatedCgroup,
        limits: request.limits,
        network: operation.network,
        bidirectional: operation.stdin,
        nestedCgroup: true,
        contextFd: job.context.childFd,
        onOutput: (output) => {
          job.stdio[output.channel]!.write(output.bytes);
          job.outputSeq = output.sequence;
          this.emit(
            {
              type: "output",
              jobId: request.jobId,
              outputId: output.channel,
              requestId: request.jobId,
              seq: output.sequence,
              data: Buffer.from(output.bytes).toString("base64"),
              eof: false,
            },
            job,
          );
        },
      };
      preflightLinuxJob(spec);
      for (const lease of job.leases)
        job.releaseWriters.push(this.options.outputs.retainWriter(lease.directory.fd));
      // The immutable tombstone and single-use consumption become durable before any spawn.
      this.options.journal.append({
        kind: "reservation",
        request,
        permitId: permit.permitId,
        result: job.result,
      });
      this.jobs.set(request.jobId, job);
      this.permits.add(permit.permitId);
      if (parent && request.parent) {
        parent.context!.bind(request.parent.invocationId, request.jobId);
        parent.children.add(request.jobId);
        parent.childBudgetMs += request.limits.timeoutMs;
      }
      job.handle = await startLinuxJob(spec);
      job.resolveLaunched();
      job.context.releaseChildFd();
      job.result = { ...job.result, state: "started", startedAt: Date.now() };
      this.options.journal.append({ kind: "result", result: job.result });
      this.emit(
        {
          type: "state",
          jobId: request.jobId,
          requestDigest,
          ownerId: job.result.ownerId,
          ownerGeneration: job.result.ownerGeneration,
          state: "started",
        },
        job,
      );
      void job.handle.result
        .then((result) => this.finish(job, result, parent))
        .catch(() => this.interrupt(job));
      if (job.cancelRequested) await job.handle?.cancel();
    } catch (error) {
      job.resolveLaunched();
      job.context?.close();
      if (this.jobs.has(request.jobId)) {
        await this.interrupt(job);
      } else {
        job.resolveEmpty();
        for (const release of job.releaseWriters) release();
        job.releaseWriters = [];
        for (const lease of job.leases) this.options.outputs.abort(lease);
        for (const stream of Object.values(job.stdio)) stream.abort();
        for (const location of job.locations.values()) location.close();
      }
      throw error;
    }
  }

  private async finish(job: OwnedJob, observed: LinuxJobResult, parent?: OwnedJob): Promise<void> {
    const handle = job.handle;
    job.handle = null;
    for (const childId of job.children) await this.cancel(childId);
    job.resolveEmpty();
    for (const release of job.releaseWriters) release();
    job.releaseWriters = [];
    const result: JobResult = {
      ...job.result,
      state: observed.reason === "cancelled" ? "cancelled" : "exited",
      exitCode: observed.exitCode,
      reason: observed.reason === "exited" ? null : observed.reason,
      startedAt: observed.startedAt,
      finishedAt: observed.finishedAt,
      usage: {
        elapsedMs: observed.usage.wallMs,
        memoryBytes: observed.usage.memoryPeakBytes,
        processes: observed.usage.processesPeak,
        outputBytes: observed.usage.outputBytes,
      },
    };
    for (const channel of ["stdout", "stderr"] as const)
      this.emit(
        {
          type: "output",
          jobId: job.request.jobId,
          outputId: channel,
          requestId: job.request.jobId,
          seq: ++job.outputSeq,
          data: "",
          eof: true,
        },
        job,
      );
    // Execution observation precedes child_exit; no final result is sent on that context.
    this.emit(
      {
        type: "state",
        jobId: job.request.jobId,
        requestDigest: job.request.requestDigest,
        ownerId: result.ownerId,
        ownerGeneration: result.ownerGeneration,
        state: result.state,
      },
      job,
    );
    if (parent?.context) {
      parent.context.send({
        type: "child_exit",
        jobId: job.request.jobId,
        exitCode: result.exitCode,
        reason: result.reason,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        usage: result.usage,
        outputsSealed: false,
      });
      job.childExitSent = true;
    }
    const outputs: JobResult["outputs"] = [];
    let outputReason: string | null = null;
    try {
      // Includes only jobs with overlapping held writable resources. Bounded inode-scan
      // failures refuse collection through the same cleanup as archive failures.
      // No await occurs between the final released check and synchronous collection.
      do {
        await this.options.outputs.waitForWriters(job.leases);
      } while (job.leases.some((lease) => !lease.writersReleased));
      let remainingBytes = job.request.limits.outputBytes;
      for (const stream of Object.values(job.stdio)) {
        const output = stream.seal({ workloadEmpty: true, writersReleased: true });
        outputs.push(output);
        remainingBytes -= output.bytes;
        if (remainingBytes < 0) throw new Error("aggregate_output_limit");
      }
      for (const lease of job.leases) {
        const output = this.options.outputs.seal(
          lease,
          { workloadEmpty: true, writersReleased: true },
          remainingBytes,
        );
        outputs.push(output);
        remainingBytes -= output.bytes;
      }
    } catch {
      outputReason = "output_collection_refused";
      const sealedIds = new Set(outputs.map((output) => output.outputId));
      for (const output of outputs)
        this.options.outputs.release(job.request.jobId, output.outputId);
      for (const stream of Object.values(job.stdio)) stream.abort();
      for (const lease of job.leases)
        if (!sealedIds.has(lease.outputId)) this.options.outputs.abort(lease);
      outputs.length = 0;
    }
    job.leases = [];
    job.stdio = {};
    const final = { ...result, reason: outputReason ?? result.reason, outputs };
    this.options.journal.append({ kind: "result", result: final });
    job.result = final;
    this.emit({ type: "result", result: final }, job);
    job.resolveFinalized();
    handle?.release();
    job.context?.close();
    for (const location of job.locations.values()) location.close();
    job.locations.clear();
  }

  private async interrupt(job: OwnedJob): Promise<void> {
    this.draining = true;
    if (job.handle) {
      try {
        await job.handle.cancel();
        job.resolveEmpty();
        for (const release of job.releaseWriters) release();
        job.releaseWriters = [];
      } catch {
        /* No output sealing without empty proof. */
      }
    }
    job.result = {
      ...job.result,
      state: "interrupted",
      reason: "workload_effects_unknown",
      finishedAt: Date.now(),
      usage: null,
      outputs: [],
    };
    this.options.journal.append({ kind: "result", result: job.result });
    this.emit({ type: "result", result: job.result }, job);
    job.resolveFinalized();
  }

  private async cancel(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    job.cancelRequested = true;
    await job.launched;
    for (const child of job.children) await this.cancel(child);
    if (job.handle) await job.handle.cancel();
  }

  private validateInput(operation: MachineOperation, request: JobRequest): void {
    for (const [name, value] of Object.entries(request.input)) {
      const field = operation.input[name];
      if (
        !field ||
        typeof value !== field.type ||
        (typeof value === "string" && value.length > (field.maxLength ?? 65536)) ||
        (field.enum && !field.enum.includes(value))
      )
        throw new Error("operation_input_invalid");
      if (
        field.format === "revisioned-id" &&
        (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}$/.test(value))
      )
        throw new Error("operation_input_format");
    }
    for (const [name, field] of Object.entries(operation.input))
      if (field.required && !(name in request.input)) throw new Error("operation_input_missing");
    for (const slot of operation.argv)
      if ("input" in slot && !(slot.input in request.input)) throw new Error("argv_input_missing");
    for (const key of ["timeoutMs", "memoryBytes", "processes", "outputBytes"] as const)
      if (request.limits[key] > operation.limits[key]) throw new Error("operation_limit_exceeded");
  }

  private newJob(request: JobRequest): OwnedJob {
    const empty = Promise.withResolvers<void>();
    const launched = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<void>();
    return {
      request,
      result: {
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        ownerId: this.options.journal.ownerId,
        ownerGeneration: this.options.journal.generation,
        state: "start-committed",
        exitCode: null,
        reason: null,
        startedAt: null,
        finishedAt: null,
        usage: null,
        limits: request.limits,
        outputs: [],
      },
      handle: null,
      context: null,
      locations: new Map(),
      leases: [],
      releaseWriters: [],
      inputSeq: 0,
      inputBytes: 0,
      inputTail: Promise.resolve(),
      inputEnded: false,
      depth: 0,
      children: new Set(),
      empty: empty.promise,
      resolveEmpty: empty.resolve,
      childBudgetMs: 0,
      outputGap: false,
      cancelRequested: false,
      stdio: {},
      outputSeq: 0,
      childExitSent: false,
      launched: launched.promise,
      resolveLaunched: launched.resolve,
      finalized: finalized.promise,
      resolveFinalized: finalized.resolve,
    };
  }
  private requireJob(jobId: string): OwnedJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("unknown_job");
    return job;
  }
  private emit(event: JobEvent, job?: OwnedJob): void {
    const parent = job?.request.parent && this.jobs.get(job.request.parent.parentJobId);
    if (
      parent?.context &&
      (event.type === "output" ||
        event.type === "refusal" ||
        (event.type === "result" && !job?.childExitSent) ||
        event.type === "state")
    ) {
      parent.context.send(event);
      if (event.type === "output") return;
    }
    if (!this.sink?.(event) && job && event.type === "output") job.outputGap = true;
  }
  private installKey(pluginId: string, revision: string): string {
    return `${pluginId}\0${revision}`;
  }
  private platform(): "linux-x64" | "linux-arm64" {
    if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
      throw new Error("unsupported_job_platform");
    return `linux-${process.arch}`;
  }
  async shutdown(): Promise<void> {
    if (!this.ready) return;
    this.draining = true;
    this.options.journal.append({ kind: "drain", draining: true });
    await Promise.all([...this.jobs.values()].map((job) => this.cancel(job.request.jobId)));
    await Promise.all([...this.jobs.values()].map((job) => job.finalized));
    this.ready = false;
    this.options.journal.close();
  }
}
