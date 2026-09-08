import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
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
  type JobInstallationResources,
  type JobArtifactDelivery,
} from "@manifold/protocol";
import { privateByteFile, type HeldDirectory } from "./job-files.ts";
import { deliveredArtifact } from "@manifold/plugin-kit/artifacts";
import {
  acquireArtifact,
  openCachedArtifact,
  artifactCacheKey,
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
  preflightLinuxJobRuntime,
  recoverLinuxJobs,
  startLinuxJob,
  LinuxJobRefusal,
  type LinuxJobBind,
  type LinuxJobHandle,
  type LinuxJobOutput,
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
  artifact: PinnedArtifact | null;
  tools: Map<string, PinnedArtifact>;
  toolFailures: Map<string, string>;
  runtimeAliases: Map<string, { tool: string | null; companion: boolean }>;
  enabled: boolean;
}
interface OwnedJob {
  request: JobRequest;
  result: JobResult;
  handle: LinuxJobHandle | null;
  startupCleanup: (() => Promise<void>) | undefined;
  emptyObserved: boolean;
  context: JobContext | null;
  locations: Map<string, JobLocation>;
  inputFiles: LinuxJobBind[];
  leases: JobOutputLease[];
  releaseWriters: Array<() => void>;
  inputSeq: number;
  inputBytes: number;
  inputTail: Promise<void>;
  inputEnded: boolean;
  inputBusy: boolean;
  inputRequests: Set<string>;
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
  private terminalHostId: string | undefined;
  private readonly inputAuthorizations = new Map<string, {
    jobId: string; resolve(allowed: boolean): void;
  }>();

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
      if (kind === "input") {
        const job = owner.requireJob(String(Reflect.get(raw, "jobId")));
        const seq = Reflect.get(raw, "nextInputSeq");
        const requestId = Reflect.get(raw, "requestId");
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq !== job.inputSeq + 1 || typeof requestId !== "string")
          throw new Error("invalid_input_journal");
        job.inputSeq = seq;
        job.inputRequests.add(requestId);
        // Recovery never resumes a possibly partially written stream.
        job.inputEnded = true;
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

  bindTerminalHost(terminalHostId: string): void {
    if (this.terminalHostId) throw new Error("terminal_host_already_bound");
    this.terminalHostId = terminalHostId;
  }
  get maintenanceReady(): boolean {
    return this.draining && [...this.jobs.values()].every((job) => job.emptyObserved);
  }

  setDraining(draining: boolean): void {
    this.options.journal.append({ kind: "drain", draining });
    this.draining = draining;
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
      ...(this.terminalHostId ? { terminalHostId: this.terminalHostId } : {}),
    };
  }

  attach(sink: (event: JobEvent) => boolean): () => void {
    if (this.sink) throw new Error("job_owner_seat_taken");
    this.sink = sink;
    for (const job of this.jobs.values()) {
      if (job.outputGap) sink({ type: "refusal", jobId: job.request.jobId, reason: "output_gap" });
    }
    return () => {
      if (this.sink === sink) {
        this.sink = null;
        for (const pending of this.inputAuthorizations.values()) pending.resolve(false);
      }
    };
  }

  async execute(raw: unknown, parentJobId: string | null = null): Promise<void> {
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
          if (command.request.terminal) throw new Error("terminal_host_required");
          await this.start(command);
          return;
        case "drain":
          this.setDraining(command.draining);
          return;
        case "status": {
          const job = this.requireJob(command.jobId);
          this.emit({ type: "result", result: job.result }, job);
          await job.inputTail;
          this.emitInputState(job);
          return;
        }
        case "cancel":
          await this.cancel(command.jobId);
          return;
        case "input_authorized": {
          const pending = this.inputAuthorizations.get(command.requestId);
          if (pending?.jobId === command.jobId) pending.resolve(command.allowed);
          return;
        }
        case "input":
          await this.input(command, parentJobId);
          return;
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
      if (command.type === "input") {
        this.emit({
          type: "input_result", jobId, requestId: command.requestId, seq: command.seq,
          accepted: false, reason: "job_input_refused",
          nextInputSeq: job?.inputSeq ?? null, stdinClosed: job?.inputEnded ?? true,
        }, job);
        return;
      }
      this.emit({ type: "refusal", jobId, reason }, job);
    }
  }

  private emitInputState(job: OwnedJob): void {
    this.emit({
      type: "input_state", jobId: job.request.jobId,
      requestDigest: job.request.requestDigest, ownerId: job.result.ownerId,
      ownerGeneration: job.result.ownerGeneration,
      nextInputSeq: job.inputSeq, stdinClosed: job.inputEnded,
    }, job);
  }

  private async input(
    command: Extract<JobCommand, { type: "input" }>, parentJobId: string | null,
  ): Promise<void> {
    const job = this.requireJob(command.jobId);
    const reply = (accepted: boolean, reason: string | null) => this.emit({
      type: "input_result", jobId: command.jobId, requestId: command.requestId,
      seq: command.seq, accepted, reason, nextInputSeq: job.inputSeq,
      stdinClosed: job.inputEnded,
    }, job);
    const data = Buffer.from(command.data, "base64");
    const seat = this.sink;
    if (job.inputRequests.has(command.requestId)) {
      // A duplicate does not prove that the original command was unconsumed.
      reply(false, "job_input_delivery_unknown");
      return;
    }
    if (job.request.terminal || job.result.state !== "started" || !job.handle ||
        job.inputEnded || job.inputBusy || command.seq !== job.inputSeq ||
        job.inputSeq === Number.MAX_SAFE_INTEGER ||
        job.inputRequests.size >= 4096 ||
        job.inputBytes + data.length > job.request.limits.outputBytes ||
        !seat || this.inputAuthorizations.has(command.requestId)) {
      reply(false, "job_input_conflict_or_closed");
      return;
    }
    job.inputBusy = true;
    job.inputRequests.add(command.requestId);
    const settled = Promise.withResolvers<void>();
    job.inputTail = settled.promise;
    let reserved = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const authorization = Promise.withResolvers<boolean>();
      this.inputAuthorizations.set(command.requestId, {
        jobId: command.jobId, resolve: authorization.resolve,
      });
      timer = setTimeout(() => authorization.resolve(false), 5000);
      this.emit({
        type: "input_authorize", jobId: command.jobId, requestId: command.requestId,
        seq: command.seq, parentJobId,
      });
      const allowed = await authorization.promise;
      clearTimeout(timer);
      this.inputAuthorizations.delete(command.requestId);
      if (!allowed || this.sink !== seat || job.cancelRequested || job.result.state !== "started" ||
          !job.handle || job.inputEnded) {
        reply(false, "job_input_authority_or_state_refused");
        return;
      }
      // Consume the cursor durably before touching stdin; neither a partial write nor
      // a lost receipt permits replay. The journal contains no input bytes or digest.
      this.options.journal.append({
        kind: "input", jobId: command.jobId, requestId: command.requestId,
        nextInputSeq: job.inputSeq + 1,
      });
      job.inputSeq++;
      job.inputBytes += data.length;
      reserved = true;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("job_input_delivery_unknown")), 5000);
      });
      await Promise.race([job.handle.input(data), timeout]);
      if (command.eof) {
        job.handle.endInput();
        job.inputEnded = true;
      }
      reply(true, null);
    } catch {
      if (reserved) job.inputEnded = true;
      reply(false, reserved ? "job_input_delivery_unknown" : "job_input_refused");
    } finally {
      clearTimeout(timer);
      this.inputAuthorizations.delete(command.requestId);
      job.inputBusy = false;
      settled.resolve();
      this.emitInputState(job);
    }
  }

  private restoreInstallation(command: Extract<JobCommand, { type: "install" }>): void {
    const runtimeAliases = this.runtimeAliases(command);
    const spec = command.machine.artifacts[this.platform()];
    if (!spec || spec.sha256 !== command.artifactSha256)
      throw new Error("installed_artifact_platform_mismatch");
    let artifact: PinnedArtifact | null = null;
    try { artifact = openCachedArtifact(spec, this.options.cache); } catch { /* Report unavailable, never ambient fallback. */ }
    const key = this.installKey(command.pluginId, command.installationRevision);
    const tools = new Map<string, PinnedArtifact>();
    const toolFailures = new Map<string, string>();
    for (const [alias, platforms] of Object.entries(command.machine.tools ?? {})) {
      const tool = platforms[this.platform()];
      try {
        if (!tool) throw new Error("runtime_tool_platform_unavailable");
        tools.set(alias, openCachedArtifact(tool, this.options.cache));
      } catch { toolFailures.set(alias, "runtime_tool_cache_unavailable"); }
    }
    this.installs.get(key)?.artifact?.close();
    for (const tool of this.installs.get(key)?.tools.values() ?? []) tool.close();
    this.installs.set(key, {
      command: { ...command, action: undefined },
      enabled: command.action !== "disable", artifact, tools, toolFailures, runtimeAliases,
    });
  }

  private async install(incoming: Extract<JobCommand, { type: "install" }>): Promise<void> {
    const { artifact: delivery, toolArtifacts, ...command } = incoming;
    const artifactSpec = command.machine.artifacts[this.platform()];
    if (!artifactSpec || artifactSpec.sha256 !== command.artifactSha256)
      throw new Error("unsupported_artifact_platform");
    const runtimeAliases = this.runtimeAliases(command);
    if (command.action) {
      if (delivery !== undefined || toolArtifacts !== undefined) throw new Error("artifact_unexpected_delivery");
    }
    if (this.draining && !command.action) throw new Error("owner_draining");
    const key = this.installKey(command.pluginId, command.installationRevision);
    const existing = this.installs.get(key);
    const primarySource = `${artifactSpec.url ?? artifactSpec.bundleFile}\0${artifactSpec.sha256}`;
    const selectedTools = Object.entries(command.machine.tools ?? {}).map(([alias, platforms]) => {
      const spec = platforms[this.platform()];
      return [alias, spec, spec ? `${spec.url ?? spec.bundleFile}\0${spec.sha256}` : ""] as const;
    }).sort((a, b) => a[2] === b[2] ? 0 : a[2] === primarySource ? -1 :
      b[2] === primarySource ? 1 : a[2].localeCompare(b[2]));
    for (const name of Object.keys(toolArtifacts ?? {}))
      if (!selectedTools.some(([, spec]) => spec?.bundleFile === name))
        throw new Error("artifact_unexpected_delivery");
    const archives = new Map<string, Buffer>();
    const decoded = new Map<string, Buffer>();
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
        affected.some((job) => !job.emptyObserved || job.leases.length > 0)
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
        existing.artifact?.close();
        for (const tool of existing.tools.values()) tool.close();
        this.installs.delete(key);
        const specs = [artifactSpec, ...selectedTools.flatMap(([, spec]) => spec ? [spec] : [])];
        for (const spec of specs) {
          for (const digest of new Set([spec.entrySha256, ...Object.values(spec.files ?? {}).map((file) => file.sha256)])) {
            const name = artifactCacheKey(spec, digest);
            const shared = [...this.installs.values()].some((installation) => {
              const machine = installation.command.machine;
              const others = [machine.artifacts[this.platform()], ...Object.values(machine.tools ?? {}).map((platforms) => platforms[this.platform()])];
              return others.some((other) => other && artifactCacheKey(other, digest) === name);
            });
            if (!shared) {
              try { this.options.cache.unlink(name); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
          }
        }
      }
      this.emit({
        type: "installed",
        pluginId: command.pluginId,
        installationRevision: command.installationRevision,
        artifactSha256: command.artifactSha256,
        resources: this.installedResources(command.pluginId, command.installationRevision),
      });
      return;
    }
    if (existing) {
      deliveredArtifact(artifactSpec, delivery, decoded);
      if (jobDigest(existing.command) !== jobDigest(command))
        throw new Error("installation_revision_changed");
      if (!existing.artifact) existing.artifact = await acquireArtifact(
        artifactSpec, this.options.cache, this.options.artifactAuthority, delivery, archives, decoded);
      if (!existing.enabled) {
        this.options.journal.append({ kind: "install", command });
        existing.enabled = true;
      }
    } else {
      if (this.installs.size >= 128) throw new Error("installation_capacity");
      for (const locationId of Object.keys(command.machine.locations))
        if (!locationId.startsWith(`${command.pluginId}.`))
          throw new Error("location_namespace_mismatch");
      for (const [id, operation] of Object.entries(command.machine.operations)) {
        if (!id.startsWith(`${command.pluginId}.`)) throw new Error("operation_namespace_mismatch");
        for (const location of operation.locations)
          if (!command.machine.locations[location.locationId])
            throw new Error("undeclared_location");
      }
      const artifact = await acquireArtifact(
        artifactSpec,
        this.options.cache,
        this.options.artifactAuthority,
        delivery,
        archives, decoded,
      );
      try {
        if (this.draining || this.installs.has(key)) throw new Error("installation_raced");
        this.options.journal.append({ kind: "install", command });
        this.installs.set(key, { command, artifact, enabled: true, tools: new Map(), toolFailures: new Map(), runtimeAliases });
      } catch (error) {
        artifact.close();
        throw error;
      }
    }
    const installation = this.installs.get(key)!;
    for (const [alias, spec] of selectedTools) {
      try {
        if (!spec) throw new Error("runtime_tool_platform_unavailable");
        const member: JobArtifactDelivery | undefined = spec.bundleFile === undefined ? undefined :
          delivery?.bundleFile === spec.bundleFile ? delivery :
          toolArtifacts?.[spec.bundleFile] === undefined ? undefined :
          { bundleFile: spec.bundleFile, data: toolArtifacts[spec.bundleFile]! };
        const artifact = await acquireArtifact(spec, this.options.cache, this.options.artifactAuthority, member, archives, decoded);
        installation.tools.get(alias)?.close();
        installation.tools.set(alias, artifact);
        installation.toolFailures.delete(alias);
      } catch (error) {
        installation.tools.get(alias)?.close();
        installation.tools.delete(alias);
        installation.toolFailures.set(alias, error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message)
          ? error.message : "runtime_tool_acquisition_refused");
      }
    }
    this.emit({
      type: "installed",
      pluginId: command.pluginId,
      installationRevision: command.installationRevision,
      artifactSha256: command.artifactSha256,
      resources: this.installedResources(command.pluginId, command.installationRevision),
    });
  }

  /** Private in-process handoff from the sole TerminalHost, never a job RPC command. */
  async startTerminal(
    command: Extract<JobCommand, { type: "start" }>,
    terminalId: string,
    terminalHostId: string,
    launch: (spec: LinuxJobSpec) => Promise<LinuxJobHandle>,
  ): Promise<void> {
    const binding = command.request.terminal;
    if (!this.ready || !binding || binding.terminalId !== terminalId ||
        binding.terminalHostId !== terminalHostId || terminalHostId !== this.terminalHostId || command.request.parent)
      throw new Error("terminal_binding_refused");
    await this.start(command, launch);
  }

  private async start(
    command: Extract<JobCommand, { type: "start" }>,
    terminalLaunch?: (spec: LinuxJobSpec) => Promise<LinuxJobHandle>,
  ): Promise<void> {
    const { request, permit } = command;
    const { requestDigest, ...immutable } = request;
    if (jobDigest(immutable) !== requestDigest) throw new Error("request_digest_mismatch");
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (request.terminal) throw new Error("terminal_admission_reused");
      if (existing.request.requestDigest !== requestDigest) throw new Error("job_identity_changed");
      this.emit({ type: "result", result: existing.result }, existing);
      return;
    }
    if ([...this.jobs.values()].filter((job) => !job.emptyObserved).length >= 64)
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
    if (Boolean(request.terminal) !== Boolean(terminalLaunch))
      throw new Error("terminal_host_required");
    const installation = this.installs.get(
      this.installKey(request.pluginId, request.installationRevision),
    );
    const operation = installation?.command.machine.operations[request.operationId];
    if (
      !installation?.enabled || !installation.artifact ||
      !operation ||
      installation.command.artifactSha256 !== request.artifactSha256
    )
      throw new Error("operation_not_installed");
    this.validateInput(operation, request);
    if (request.terminal && !operation.stdin) throw new Error("terminal_operation_requires_stdin");
    const unavailable = this.operationUnavailable(installation, operation);
    if (unavailable) throw new Error(unavailable);
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
      preflightLinuxJobRuntime();
      if (request.outputs.length > 30) throw new Error("output_count_limit");
      if (!request.terminal) {
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
      }
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
        command: (next) => this.execute(next, request.jobId),
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
        const configured = this.runtimeTool(installation, tool);
        if (!configured) throw new Error("runtime_tool_unavailable");
        for (const bind of configured)
          if (!runtime.some((prior) => prior.fd === bind.fd && prior.target === bind.target))
            runtime.push(bind);
      }
      for (const [name, declaration] of Object.entries(operation.inputFiles ?? {})) {
        const value = request.input[declaration.input];
        if (typeof value !== "string") throw new Error("input_file_string_required");
        job.inputFiles.push({ fd: privateByteFile(Buffer.from(value)), target: `/inputs/${name}`, writable: false });
      }
      const spec: LinuxJobSpec = {
        bubblewrapFd: this.options.bubblewrapFd,
        artifactFd: installation.artifact.fd,
        executableRuntimeTool: operation.executable?.runtimeTool,
        inputFiles: job.inputFiles,
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
        ...(request.terminal ? {} : { onOutput: (output: LinuxJobOutput) => {
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
        } }),
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
      job.handle = await (terminalLaunch ? terminalLaunch(spec) : startLinuxJob(spec));
      job.resolveLaunched();
      job.context.releaseChildFd();
      job.result = { ...job.result, state: "started", startedAt: Date.now() };
      job.inputEnded = !operation.stdin;
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
      this.emitInputState(job);
      void job.handle.result
        .then((result) => this.finish(job, result, parent))
        .catch(() => this.interrupt(job));
      if (job.cancelRequested) await job.handle?.cancel();
    } catch (error) {
      job.resolveLaunched();
      job.context?.close();
      const safelyRefused = error instanceof LinuxJobRefusal && error.workloadEmpty && !job.handle;
      if (error instanceof LinuxJobRefusal && !error.workloadEmpty) job.startupCleanup = error.cleanup;
      if (this.jobs.has(request.jobId) && !safelyRefused) {
        await this.interrupt(job);
      } else {
        job.resolveEmpty();
        for (const release of job.releaseWriters) release();
        job.releaseWriters = [];
        for (const lease of job.leases) this.options.outputs.abort(lease);
        for (const stream of Object.values(job.stdio)) stream.abort();
        for (const location of job.locations.values()) location.close();
        job.leases = [];
        job.stdio = {};
        job.locations.clear();
        if (safelyRefused && this.jobs.has(request.jobId)) {
          job.result = { ...job.result, state: "refused", reason: error.code, finishedAt: Date.now() };
          this.options.journal.append({ kind: "result", result: job.result });
          this.emit({ type: "result", result: job.result }, job);
          job.resolveFinalized();
        }
        this.closeInputFiles(job);
      }
      throw error;
    }
  }

  private async finish(job: OwnedJob, observed: LinuxJobResult, parent?: OwnedJob): Promise<void> {
    if (observed.empty !== true) throw new Error("workload_empty_proof_required");
    const handle = job.handle;
    for (const childId of job.children) await this.cancel(childId);
    job.resolveEmpty();
    this.closeInputFiles(job);
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
    for (const channel of job.request.terminal ? [] : ["stdout", "stderr"] as const)
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
    job.handle = null;
    job.context?.close();
    for (const location of job.locations.values()) location.close();
    job.locations.clear();
  }

  private async interrupt(job: OwnedJob): Promise<void> {
    this.draining = true;
    // Immutable inputs have no output-writer authority. Child mounts retain their own kernel
    // references; releasing our transport copies is safe even if empty proof is unavailable.
    this.closeInputFiles(job);
    if (job.handle) {
      try {
        const observed = await job.handle.cancel();
        if (observed.empty !== true) throw new Error("workload_empty_proof_required");
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
    if (job.handle) {
      const observed = await job.handle.cancel();
      if (observed.empty !== true) throw new Error("workload_empty_proof_required");
      job.resolveEmpty();
      for (const release of job.releaseWriters) release();
      job.releaseWriters = [];
    } else if (job.startupCleanup) {
      await job.startupCleanup();
      job.startupCleanup = undefined;
      job.resolveEmpty();
      for (const release of job.releaseWriters) release();
      job.releaseWriters = [];
    } else if (!job.emptyObserved) throw new Error("workload_empty_unproven");
  }

  private validateInput(operation: MachineOperation, request: JobRequest): void {
    if (Object.values(operation.inputFiles ?? {}).reduce((bytes, { input }) =>
      bytes + (typeof request.input[input] === "string" ? Buffer.byteLength(request.input[input]) : 0), 0) > 65536)
      throw new Error("input_file_byte_limit");
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
      startupCleanup: undefined,
      emptyObserved: false,
      context: null,
      locations: new Map(),
      inputFiles: [],
      leases: [],
      releaseWriters: [],
      inputSeq: 0,
      inputBytes: 0,
      inputTail: Promise.resolve(),
      inputEnded: false,
      inputBusy: false,
      inputRequests: new Set(),
      depth: 0,
      children: new Set(),
      empty: empty.promise,
      resolveEmpty() {
        this.emptyObserved = true;
        empty.resolve();
      },
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
        event.type === "state" || event.type === "input_result" || event.type === "input_state")
    ) {
      parent.context.send(event);
      if (event.type === "output") return;
    }
    if (!this.sink?.(event) && job && event.type === "output") job.outputGap = true;
  }
  private installKey(pluginId: string, revision: string): string {
    return `${pluginId}\0${revision}`;
  }
  private closeInputFiles(job: OwnedJob): void {
    for (const file of job.inputFiles) closeSync(file.fd);
    job.inputFiles = [];
  }
  private runtimeAliases(command: Installation["command"]): Installation["runtimeAliases"] {
    const aliases: Installation["runtimeAliases"] = new Map();
    const add = (alias: string, tool: string | null, companion: boolean): void => {
      if (aliases.has(alias)) throw new Error("runtime_tool_alias_ambiguous");
      aliases.set(alias, { tool, companion });
    };
    for (const alias of Object.keys(command.machine.artifacts[this.platform()]?.files ?? {}))
      add(alias, null, true);
    for (const [tool, platforms] of Object.entries(command.machine.tools ?? {})) {
      add(tool, tool, false);
      for (const alias of Object.keys(platforms[this.platform()]?.files ?? {}))
        add(alias, tool, true);
    }
    return aliases;
  }
  private runtimeTool(installation: Installation, alias: string): readonly LinuxJobBind[] | undefined {
    const source = installation.runtimeAliases.get(alias);
    if (source) {
      const artifact = source.tool === null ? installation.artifact : installation.tools.get(source.tool);
      const pinned = source.companion ? artifact?.files[alias] : artifact;
      return pinned ? [{ fd: pinned.fd, target: `/runtime/bin/${alias}`, writable: false }] : undefined;
    }
    return Object.hasOwn(this.options.runtimeTools, alias) ? this.options.runtimeTools[alias] : undefined;
  }
  private operationUnavailable(installation: Installation, operation: MachineOperation): string | undefined {
    if (!installation.enabled || !installation.artifact) return "operation_not_installed";
    for (const alias of operation.runtimeTools) {
      const binds = this.runtimeTool(installation, alias);
      if (!binds) return installation.toolFailures.get(alias) ?? "runtime_tool_unavailable";
      if (operation.executable?.runtimeTool === alias) {
        const matches = binds.filter((bind) => bind.target === `/runtime/bin/${alias}` && !bind.writable);
        if (matches.length !== 1) return "runtime_executable_unavailable";
        try {
          const stat = fstatSync(matches[0]!.fd);
          if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o6022)) return "runtime_executable_untrusted";
        } catch { return "runtime_executable_unavailable"; }
      }
    }
    return undefined;
  }
  installedResources(pluginId: string, revision: string): JobInstallationResources {
    const installation = this.installs.get(this.installKey(pluginId, revision));
    return {
      artifactAvailable: installation?.artifact !== null && installation?.artifact !== undefined,
      tools: installation ? [...new Set([
        ...Object.keys(installation.command.machine.tools ?? {}),
        ...Object.values(installation.command.machine.operations).flatMap((operation) => operation.runtimeTools),
      ])].map((alias) => {
        const managed = Object.hasOwn(installation.command.machine.tools ?? {}, alias);
        const artifact = installation.tools.get(alias);
        return { alias, managed, available: this.runtimeTool(installation, alias) !== undefined,
          ...(artifact ? { artifactSha256: artifact.archiveSha256, entrySha256: artifact.entrySha256 } : {}),
          ...(installation.toolFailures.has(alias) ? { reason: installation.toolFailures.get(alias)! } : {}) };
      }) : [],
      operations: installation ? Object.entries(installation.command.machine.operations).map(([operationId, operation]) => {
        const reason = this.operationUnavailable(installation, operation);
        return { operationId, available: reason === undefined, ...(reason ? { reason } : {}) };
      }) : [],
    };
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
    if (![...this.jobs.values()].every((job) => job.emptyObserved))
      throw new Error("workload_empty_unproven");
    this.ready = false;
    for (const job of this.jobs.values()) {
      job.handle?.release();
      job.handle = null;
      job.context?.close();
      for (const lease of job.leases) this.options.outputs.abort(lease);
      for (const stream of Object.values(job.stdio)) stream.abort();
      for (const location of job.locations.values()) location.close();
      job.leases = [];
      job.stdio = {};
      job.locations.clear();
    }
    for (const installation of this.installs.values()) {
      installation.artifact?.close();
      for (const tool of installation.tools.values()) tool.close();
    }
    this.options.journal.close();
  }
}
