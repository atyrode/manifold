import { createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connectWorkloadLoopback } from "./job-listener-proof.ts";
import {
  canonicalJobJson,
  JOB_OWNER_PROTOCOL_VERSION,
  JobCommandSchema,
  JobRequestSchema,
  JobResultSchema,
  ServiceConfigurationSchema,
  WorkerContextSchema,
  jobResourceBindingsFor,
  jobResourceRefusal,
  jobResourceRequirements,
  servicePolicyCredentialRefs,
  type JobResourceInventory,
  type JobResourceRequirements,
  type ServiceAuthoritySubject,
  type ServiceCall,
  type ServiceConfiguration,
  type ServiceCredentialReference,
  type ServicePolicy,
  type ServiceReply,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type JobRequest,
  type JobResult,
  type MachineOperation,
  type JobInstallationResources,
  type JobArtifactDelivery,
} from "@manifold/protocol";
import { type HeldDirectory } from "./job-files.ts";
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
import {
  DirectoryExclusions,
  resolveJobLocation,
  resolveManagedJobLocation,
  type JobLocation,
} from "./job-locations.ts";
import { JobResources } from "./job-resources.ts";
import {
  createJobServiceRunner,
  heldServiceCredentialResolver,
  type AuthorizeServiceCall,
  type JobServiceRunner,
} from "./job-services.ts";
import { createJobServiceProxy, type JobServiceProxy } from "./job-service-proxy.ts";
import { materializeJobInputs, type JobServiceEndpoint } from "./job-inputs.ts";
import { createServiceTunnel, type ServiceTunnel } from "./job-service-tunnel.ts";

interface OwnedServiceTunnel {
  wire: ServiceTunnel;
  signal: AbortSignal;
  controller: AbortController;
  command?: Extract<JobCommand, { type: "service_tunnel_open" }>;
  ready?: (endpoint: JobServiceEndpoint | null) => void;
}

export interface JobOwnerOptions {
  machineId: string;
  admissionPublicKey: string;
  journal: JobJournal;
  cache: HeldDirectory;
  managedState: HeldDirectory;
  outputs: JobOutputStore;
  delegatedCgroup: HeldDirectory;
  bubblewrapFd: number;
  anchors: Readonly<Record<string, HeldDirectory>>;
  protectedDirectories: readonly HeldDirectory[];
  /** Reviewed local runtime closures, not executable/cwd/env RPC fields. */
  runtimeTools: Readonly<Record<string, readonly LinuxJobBind[]>>;
  artifactAuthority: ArtifactAuthority;
  /** Bootstrap-held source credentials; only references and allowed origins are advertised. */
  serviceCredentials?: ReadonlyMap<string, { fd: number; origins: readonly string[] }>;
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
  serviceController: AbortController;
  serviceProxies: Map<string, JobServiceProxy>;
  runtimeServices: Map<string, RuntimeService>;
  serviceRuntime: RuntimeService | undefined;
}

interface RuntimeService {
  policy: ServicePolicy;
  invocationId: string;
  childJobId: string | null;
  bearer: string;
  ready: Promise<JobServiceEndpoint & { signal: AbortSignal }>;
  resolve(endpoint: JobServiceEndpoint & { signal: AbortSignal }): void;
  reject(reason: Error): void;
}
interface InstanceRuntimeService {
  policy: ServicePolicy;
  job: OwnedJob;
  bearer: string;
  port: number | null;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
}
const ACTIVE: Record<string, true> = { "start-committed": true, started: true };

/** Independently supervised machine authority. No workload is owned by the websocket transport. */
export class MachineJobOwner {
  private readonly installs = new Map<string, Installation>();
  private readonly jobs = new Map<string, OwnedJob>();
  private readonly pendingStarts = new Map<string, Promise<void>>();
  private readonly instanceRuntimeServices = new Map<string, InstanceRuntimeService>();
  private readonly permits = new Set<string>();
  private readonly challenges = new Set<string>();
  private readonly admissionKey: KeyObject;
  private readonly exclusions: DirectoryExclusions;
  private sink: ((event: JobEvent) => boolean) | null = null;
  private draining = false;
  private ready = false;
  private terminalHostId: string | undefined;
  private readonly inputAuthorizations = new Map<
    string,
    {
      jobId: string;
      resolve(allowed: boolean): void;
    }
  >();
  private readonly resources: JobResources;
  private serviceConfiguration: ServiceConfiguration = { revision: null, policies: [] };
  private serviceRunner: JobServiceRunner = createJobServiceRunner({ policies: [] });
  private seatController = new AbortController();
  private configurationController = new AbortController();
  private readonly serviceTunnels = new Map<string, OwnedServiceTunnel>();
  private readonly serviceAuthorizations = new Map<
    string,
    {
      subject: ServiceAuthoritySubject;
      resolve(allowed: boolean): void;
    }
  >();
  private readonly directServiceCalls = new Map<
    string,
    {
      command: Extract<JobCommand, { type: "service_read" | "service_invoke" }>;
      controller: AbortController;
    }
  >();

  private constructor(private readonly options: JobOwnerOptions) {
    this.admissionKey = createPublicKey(options.admissionPublicKey);
    if (options.protectedDirectories.length === 0) throw new Error("private_owner_roots_required");
    this.exclusions = new DirectoryExclusions(options.protectedDirectories);
    this.resources = new JobResources({
      anchors: options.anchors,
      runtimeTools: options.runtimeTools,
      credentialReferences: () => this.credentialReferences(),
      runtimeAvailable: (policy, inventory) => this.runtimeAvailable(policy, inventory, new Set()),
    });
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
      if (kind === "reservation" || kind === "rejection") {
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
        if (
          typeof seq !== "number" ||
          !Number.isSafeInteger(seq) ||
          seq !== job.inputSeq + 1 ||
          typeof requestId !== "string"
        )
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
    return (
      this.draining &&
      this.directServiceCalls.size === 0 &&
      [...this.jobs.values()].every((job) => job.emptyObserved)
    );
  }

  setDraining(draining: boolean): void {
    // Transport resynchronization must not change inventory for an unchanged admission latch.
    if (this.draining === draining) return;
    this.options.journal.append({ kind: "drain", draining });
    this.draining = draining;
    if (draining) for (const tunnel of this.serviceTunnels.values()) tunnel.controller.abort();
  }
  get identity(): JobOwner {
    const journal = this.options.journal;
    return {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
      ownerId: journal.ownerId,
      publicKey: journal.publicKey,
      generation: journal.generation,
      platforms:
        process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")
          ? [`linux-${process.arch}`]
          : [],
      inventoryDigest: journal.inventoryDigest(),
      resources: this.resources.snapshot(),
      ...(this.terminalHostId ? { terminalHostId: this.terminalHostId } : {}),
    };
  }

  attach(sink: (event: JobEvent) => boolean): () => void {
    if (this.sink) throw new Error("job_owner_seat_taken");
    this.sink = sink;
    this.seatController = new AbortController();
    for (const job of this.jobs.values()) {
      if (job.outputGap) sink({ type: "refusal", jobId: job.request.jobId, reason: "output_gap" });
    }
    return () => {
      if (this.sink === sink) {
        this.sink = null;
        this.seatController.abort();
        for (const pending of this.serviceAuthorizations.values()) pending.resolve(false);
        for (const pending of this.directServiceCalls.values()) pending.controller.abort();
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
          this.publishResources();
          for (const installation of this.installs.values())
            this.publishInstallation(installation.command);
          return;
        }
        case "invocation_reply":
          if (command.reason !== null) {
            const parent = this.requireJob(command.parentJobId);
            for (const runtime of parent.runtimeServices.values())
              if (runtime.invocationId === command.invocationId)
                runtime.reject(new Error("service_unavailable"));
          }
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
          const job = await this.reconcileStart(command);
          this.emitEmpty(job);
          this.emit({ type: "result", result: job.result }, job);
          if (job.request.service) {
            const instance = this.instanceRuntimeServices.get(job.request.service.serviceId);
            if (instance?.job === job) this.publishInstanceReady(instance);
          }
          await job.inputTail;
          this.emitInputState(job);
          return;
        }
        case "cancel": {
          const job = await this.reconcileStart(command);
          this.emitEmpty(job);
          await this.cancel(command.jobId);
          return;
        }
        case "configure_services":
          this.configureServices(command.configuration);
          return;
        case "service_authorized": {
          const pending = this.serviceAuthorizations.get(command.authorizationId);
          if (pending && jobDigest(pending.subject) === jobDigest(command.subject))
            pending.resolve(command.allowed);
          return;
        }
        case "service_tunnel_open":
          await this.acceptServiceTunnel(command);
          return;
        case "service_tunnel_ready":
          this.serviceTunnels.get(command.channelId)?.ready?.(command.endpoint);
          return;
        case "service_tunnel_frame":
          this.serviceTunnels.get(command.frame.channelId)?.wire.receive(command.frame);
          return;
        case "service_read":
        case "service_invoke":
          await this.directService(command);
          return;
        case "service_read_cancel":
        case "service_invoke_cancel": {
          const pending = this.directServiceCalls.get(command.requestId);
          if (pending && command.type === `${pending.command.type}_cancel`)
            pending.controller.abort();
          return;
        }
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
        this.emit(
          {
            type: "input_result",
            jobId,
            requestId: command.requestId,
            seq: command.seq,
            accepted: false,
            reason: "job_input_refused",
            nextInputSeq: job?.inputSeq ?? null,
            stdinClosed: job?.inputEnded ?? true,
          },
          job,
        );
        return;
      }
      this.emit({ type: "refusal", jobId, reason }, job);
    }
  }

  private credentialReferences(): ServiceCredentialReference[] {
    return [...(this.options.serviceCredentials ?? [])].map(([ref, value]) => {
      let available = false;
      try {
        const stat = fstatSync(value.fd);
        available =
          stat.isFile() &&
          stat.uid === process.getuid?.() &&
          (stat.mode & 0o077) === 0 &&
          stat.nlink === 1 &&
          stat.size > 0 &&
          stat.size <= 16384;
      } catch {
        /* A lost descriptor never becomes ambient path lookup. */
      }
      return { ref, origins: [...value.origins], available };
    });
  }

  private policy(serviceId: string): ServicePolicy | undefined {
    return this.serviceConfiguration.policies.find((policy) => policy.serviceId === serviceId);
  }

  private publishResources(): void {
    this.emit({ type: "resources", resources: this.resources.snapshot() });
  }

  private publishInstallation(command: Extract<JobCommand, { type: "install" }>): void {
    this.emit({
      type: "installed",
      pluginId: command.pluginId,
      installationRevision: command.installationRevision,
      artifactSha256: command.artifactSha256,
      resources: this.installedResources(command.pluginId, command.installationRevision),
    });
  }

  private configureServices(raw: ServiceConfiguration): void {
    const configuration = ServiceConfigurationSchema.parse(raw);
    if (
      configuration.revision !== null &&
      configuration.revision !== jobDigest(configuration.policies)
    )
      throw new Error("service_configuration_digest_mismatch");
    if (jobDigest(configuration) === jobDigest(this.serviceConfiguration)) return;
    this.configurationController.abort();
    this.configurationController = new AbortController();
    this.serviceRunner.close();
    this.serviceConfiguration = configuration;
    this.resources.configure(configuration.policies);
    this.serviceRunner = createJobServiceRunner({
      policies: configuration.policies,
      resolveCredential: heldServiceCredentialResolver(
        new Map(
          [...(this.options.serviceCredentials ?? [])].map(([ref, value]) => [ref, value.fd]),
        ),
      ),
      resolveRuntime: (policy, signal) => this.instanceService(policy, signal),
    });
    this.publishResources();
    for (const installation of this.installs.values())
      this.publishInstallation(installation.command);
  }

  private serviceAvailable(
    policy: ServicePolicy,
    operationIds: readonly string[],
    inventory: JobResourceInventory,
    visiting: Set<string>,
  ): boolean {
    if (
      operationIds.some((id) => !Object.hasOwn(policy.operations, id)) ||
      servicePolicyCredentialRefs(policy, operationIds).some(
        (ref) =>
          !inventory.credentialReferences?.some(
            (reference) =>
              reference.ref === ref &&
              reference.available &&
              reference.origins.includes(policy.origin!),
          ),
      )
    )
      return false;
    return !policy.runtime || this.runtimeAvailable(policy, inventory, visiting);
  }

  private runtimeAvailable(
    policy: ServicePolicy,
    inventory: JobResourceInventory,
    visiting: Set<string>,
  ): boolean {
    const runtime = policy.runtime;
    if (!runtime || visiting.has(policy.serviceId) || visiting.size >= 8) return false;
    const installation = this.installs.get(
      this.installKey(runtime.pluginId, runtime.installationRevision),
    );
    const operation = installation?.command.machine.operations[runtime.operationId];
    if (
      !installation ||
      !operation?.providesService ||
      operation.network !== "host" ||
      !Object.values(operation.inputFiles ?? {}).some(
        (file) => file.generated === "service-bearer",
      ) ||
      installation.command.artifactSha256 !== runtime.artifactSha256 ||
      this.operationRuntimeUnavailable(installation, operation) ||
      jobDigest(
        jobResourceBindingsFor(
          installation.command.machine,
          runtime.operationId,
          this.platform(),
          installation.command.resourceBindings,
        ) ?? null,
      ) !== runtime.resourceBindingDigest ||
      jobResourceRefusal(
        installation.command.machine,
        runtime.operationId,
        this.platform(),
        installation.command.resourceBindings,
        inventory,
      )
    )
      return false;
    const next = new Set(visiting).add(policy.serviceId);
    return (operation.services ?? []).every((binding) => {
      const dependency = this.policy(binding.serviceId);
      return (
        dependency !== undefined &&
        this.serviceAvailable(dependency, binding.operationIds, inventory, next)
      );
    });
  }

  private refreshOperationResources(installation: Installation, operationId: string): void {
    const required: JobResourceRequirements = { tools: [], anchors: [], services: [] };
    const visited = new Set<string>();
    const collect = (current: Installation, id: string): void => {
      const key = `${current.command.pluginId}\0${current.command.installationRevision}\0${id}`;
      if (visited.has(key) || visited.size >= 64) return;
      visited.add(key);
      const next = jobResourceRequirements(current.command.machine, id, this.platform());
      for (const group of ["tools", "anchors", "services"] as const)
        required[group].push(...next[group]);
      for (const serviceId of next.services) {
        const runtime = this.policy(serviceId)?.runtime;
        const child =
          runtime &&
          this.installs.get(this.installKey(runtime.pluginId, runtime.installationRevision));
        if (child?.command.machine.operations[runtime!.operationId])
          collect(child, runtime!.operationId);
      }
    };
    collect(installation, operationId);
    for (const group of ["tools", "anchors", "services"] as const)
      required[group] = [...new Set(required[group])];
    if (this.resources.refresh(required)) this.publishResources();
  }

  private serviceSubjectValid(
    subject: ServiceAuthoritySubject,
    request: Parameters<AuthorizeServiceCall>[0],
    policySha256: string,
  ): boolean {
    const policy = this.policy(request.serviceId);
    if (
      !this.sink ||
      this.draining ||
      !policy ||
      policy.revision !== request.revision ||
      jobDigest(policy) !== policySha256 ||
      !Object.hasOwn(policy.operations, request.operationId)
    )
      return false;
    if (subject.kind === "tunnel") {
      const tunnel = this.serviceTunnels.get(subject.channelId);
      const command = tunnel?.command;
      return (
        !!command &&
        !tunnel.signal.aborted &&
        command.serviceId === request.serviceId &&
        command.revision === request.revision &&
        command.policySha256 === policySha256 &&
        command.operationIds.includes(request.operationId) &&
        this.serviceAvailable(policy, [request.operationId], this.resources.snapshot(), new Set())
      );
    }
    if (subject.kind !== "job") {
      const pending = this.directServiceCalls.get(subject.requestId);
      if (
        !pending ||
        pending.command.type !== `service_${subject.kind}` ||
        pending.controller.signal.aborted ||
        pending.command.serviceId !== request.serviceId ||
        pending.command.revision !== request.revision ||
        pending.command.operationId !== request.operationId ||
        pending.command.policySha256 !== policySha256
      )
        return false;
      if (this.resources.refresh({ tools: [], anchors: [], services: [request.serviceId] }))
        this.publishResources();
    } else {
      const job = this.jobs.get(subject.jobId);
      const installation =
        job &&
        this.installs.get(this.installKey(job.request.pluginId, job.request.installationRevision));
      const operation = job && installation?.command.machine.operations[job.request.operationId];
      if (
        !job ||
        !installation ||
        !operation ||
        job.result.state !== "started" ||
        !job.handle ||
        job.cancelRequested ||
        job.serviceController.signal.aborted ||
        job.request.resourceBindings?.services[request.serviceId] !== policySha256 ||
        !operation.services?.some(
          (binding) =>
            binding.serviceId === request.serviceId &&
            binding.revision === request.revision &&
            binding.operationIds.includes(request.operationId),
        )
      )
        return false;
      this.refreshOperationResources(installation, job.request.operationId);
      if (
        jobResourceRefusal(
          installation.command.machine,
          job.request.operationId,
          this.platform(),
          job.request.resourceBindings,
          this.resources.snapshot(),
        )
      )
        return false;
    }
    const inventory = this.resources.snapshot();
    return (
      inventory.services[request.serviceId] === policySha256 &&
      this.serviceAvailable(policy, [request.operationId], inventory, new Set())
    );
  }

  private async authorizeService(
    subject: ServiceAuthoritySubject,
    request: Parameters<AuthorizeServiceCall>[0],
    policySha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      signal.aborted ||
      this.serviceAuthorizations.size >= 256 ||
      !this.serviceSubjectValid(subject, request, policySha256)
    )
      return false;
    const seat = this.sink;
    const authorizationId = randomUUID();
    const pending = Promise.withResolvers<boolean>();
    const abort = () => pending.resolve(false);
    this.serviceAuthorizations.set(authorizationId, { subject, resolve: pending.resolve });
    const timer = setTimeout(abort, 5000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (
        !seat?.({
          type: "service_authorize",
          subject,
          authorizationId,
          serviceId: request.serviceId,
          revision: request.revision,
          policySha256,
          operationId: request.operationId,
        })
      )
        return false;
      return (
        (await pending.promise) &&
        this.sink === seat &&
        !signal.aborted &&
        this.serviceSubjectValid(subject, request, policySha256)
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.serviceAuthorizations.delete(authorizationId);
    }
  }

  private async directService(
    command: Extract<JobCommand, { type: "service_read" | "service_invoke" }>,
  ): Promise<void> {
    const kind = command.type === "service_read" ? "read" : "invoke";
    const resultType =
      command.type === "service_read" ? "service_read_result" : "service_invoke_result";
    const refuse = (refusal: Extract<ServiceReply, { ok: false }>["refusal"]) =>
      this.emit({
        type: resultType,
        requestId: command.requestId,
        reply: { type: "service_result", requestId: command.requestId, ok: false, refusal },
      });
    if (
      command.machineId !== this.options.machineId ||
      this.directServiceCalls.has(command.requestId) ||
      this.directServiceCalls.size >= 64 ||
      !this.sink ||
      this.draining
    ) {
      refuse("service_unavailable");
      return;
    }
    const policy = this.policy(command.serviceId);
    const operation = policy?.operations[command.operationId];
    if (
      !policy ||
      !operation ||
      "kind" in operation ||
      operation.response.kind !== "projected-json" ||
      (kind === "read"
        ? operation.readable !== true || operation.method !== "GET"
        : operation.invocable !== true) ||
      policy.revision !== command.revision ||
      jobDigest(policy) !== command.policySha256
    ) {
      refuse("service_binding_mismatch");
      return;
    }
    const controller = new AbortController();
    const seat = this.sink;
    this.directServiceCalls.set(command.requestId, { command, controller });
    try {
      const reply = await this.serviceRunner.call(
        {
          type: "service",
          requestId: command.requestId,
          serviceId: command.serviceId,
          operationId: command.operationId,
          input: command.input,
        },
        {
          serviceId: command.serviceId,
          revision: command.revision,
          operationIds: [command.operationId],
        },
        (request, signal) =>
          this.authorizeService(
            { kind, requestId: command.requestId },
            request,
            command.policySha256,
            signal,
          ),
        AbortSignal.any([
          controller.signal,
          this.seatController.signal,
          this.configurationController.signal,
        ]),
      );
      if (this.sink === seat) this.emit({ type: resultType, requestId: command.requestId, reply });
    } finally {
      controller.abort();
      this.directServiceCalls.delete(command.requestId);
    }
  }

  private async jobServiceCall(
    job: OwnedJob,
    request: ServiceCall,
    signal: AbortSignal,
  ): Promise<ServiceReply> {
    await job.launched;
    const installation = this.installs.get(
      this.installKey(job.request.pluginId, job.request.installationRevision),
    );
    const binding = installation?.command.machine.operations[
      job.request.operationId
    ]?.services?.find((binding) => binding.serviceId === request.serviceId);
    const fingerprint = job.request.resourceBindings?.services[request.serviceId];
    if (!binding || !fingerprint)
      return {
        type: "service_result",
        requestId: request.requestId,
        ok: false,
        refusal: "service_binding_mismatch",
      };
    return this.serviceRunner.call(
      request,
      binding,
      (call, authoritySignal) =>
        this.authorizeService(
          { kind: "job", jobId: job.request.jobId },
          call,
          fingerprint,
          authoritySignal,
        ),
      AbortSignal.any([
        signal,
        job.serviceController.signal,
        this.seatController.signal,
        this.configurationController.signal,
      ]),
    );
  }

  private async closeServices(job: OwnedJob): Promise<void> {
    job.serviceController.abort();
    job.context?.abortServices();
    const instance =
      job.request.service && this.instanceRuntimeServices.get(job.request.service.serviceId);
    if (instance && instance.job === job) {
      instance.port = null;
      instance.bearer = "";
      clearTimeout(instance.startupTimer);
      instance.startupTimer = undefined;
    }
    job.serviceRuntime?.reject(new Error("service_cancelled"));
    for (const runtime of job.runtimeServices.values()) {
      runtime.reject(new Error("service_cancelled"));
      runtime.bearer = "";
    }
    await Promise.all([...job.serviceProxies.values()].map((proxy) => proxy.close()));
    job.serviceProxies.clear();
    job.runtimeServices.clear();
  }

  private async prepareServiceProxies(job: OwnedJob, operation: MachineOperation): Promise<void> {
    const ids = new Set(
      Object.values(operation.inputFiles ?? {}).flatMap((file) =>
        (file.jsonValues ?? []).map((value) => value.serviceId),
      ),
    );
    if (ids.size && operation.network !== "host")
      throw new Error("service_proxy_requires_host_network");
    for (const serviceId of ids) {
      const policy = this.policy(serviceId);
      const binding = operation.services?.find((binding) => binding.serviceId === serviceId);
      const fingerprint = job.request.resourceBindings?.services[serviceId];
      if (!policy || !binding || !fingerprint || jobDigest(policy) !== fingerprint)
        throw new Error("service_binding_mismatch");
      const proxy = await createJobServiceProxy({
        policies: [policy],
        bindings: [binding],
        signal: job.serviceController.signal,
        authoritySignal: () =>
          AbortSignal.any([this.seatController.signal, this.configurationController.signal]),
        resolveCredential: heldServiceCredentialResolver(
          new Map(
            [...(this.options.serviceCredentials ?? [])].map(([ref, value]) => [ref, value.fd]),
          ),
        ),
        authorize: async (call, signal) => {
          await job.launched;
          return this.authorizeService(
            { kind: "job", jobId: job.request.jobId },
            call,
            fingerprint,
            signal,
          );
        },
        resolveRuntime: (boundPolicy, signal) =>
          boundPolicy.remote
            ? this.remoteService(job, boundPolicy, signal)
            : boundPolicy.runtime?.scope === "instance"
              ? this.instanceService(boundPolicy, signal)
              : this.runtimeService(job, boundPolicy, signal),
      });
      job.serviceProxies.set(serviceId, proxy);
    }
  }

  private async runtimeService(
    parent: OwnedJob,
    policy: ServicePolicy,
    signal: AbortSignal,
  ): Promise<JobServiceEndpoint & { signal: AbortSignal; socket: Socket }> {
    signal.throwIfAborted();
    if (
      !policy.runtime ||
      !parent.context ||
      parent.cancelRequested ||
      parent.result.state !== "started" ||
      parent.serviceController.signal.aborted ||
      !this.runtimeAvailable(policy, this.resources.snapshot(), new Set())
    )
      throw new Error("service_unavailable");
    let instance = parent.runtimeServices.get(policy.serviceId);
    if (!instance) {
      if (parent.runtimeServices.size >= 16 || parent.context.invocations.size >= 64)
        throw new Error("service_runtime_limit");
      const ready = Promise.withResolvers<JobServiceEndpoint & { signal: AbortSignal }>();
      const invocationId = randomUUID();
      const input: JobRequest["input"] = {};
      for (const [name, source] of Object.entries(policy.runtime.input)) {
        const value = "input" in source ? parent.request.input[source.input] : source.literal;
        if (value === undefined) throw new Error("service_runtime_input_missing");
        input[name] = value;
      }
      const created: RuntimeService = {
        policy,
        invocationId,
        childJobId: null,
        bearer: randomBytes(32).toString("base64url"),
        ready: ready.promise,
        resolve: ready.resolve,
        reject: ready.reject,
      };
      parent.runtimeServices.set(policy.serviceId, created);
      instance = created;
      parent.context.invocations.set(invocationId, {
        parentJobId: parent.request.jobId,
        invocationId,
        origin: "owner",
        childJobId: null,
        operationId: policy.runtime.operationId,
        input,
        outputs: [],
        refused: false,
      });
      const timer = setTimeout(() => ready.reject(new Error("service_start_timeout")), 30_000);
      void ready.promise.then(
        () => clearTimeout(timer),
        () => {
          clearTimeout(timer);
          const invocation = parent.context?.invocations.get(invocationId);
          if (invocation) invocation.refused = true;
          if (created.childJobId && this.jobs.has(created.childJobId))
            void this.cancel(created.childJobId).catch(() => {
              this.draining = true;
            });
        },
      );
      const event: Extract<JobEvent, { type: "invocation" }> = {
        type: "invocation",
        parentJobId: parent.request.jobId,
        invocationId,
        operationId: policy.runtime.operationId,
        input,
        outputs: [],
      };
      this.options.journal.append({
        kind: "invocation",
        parentJobId: event.parentJobId,
        invocationId,
        digest: jobDigest(event),
      });
      if (!this.sink?.(event)) ready.reject(new Error("service_owner_unavailable"));
    }
    const endpoint = await instance.ready;
    signal.throwIfAborted();
    const child = instance.childJobId && this.jobs.get(instance.childJobId);
    if (!child || child.result.state !== "started" || endpoint.signal.aborted)
      throw new Error("service_unavailable");
    const lifetime = AbortSignal.any([signal, endpoint.signal, parent.serviceController.signal]);
    const socket = await connectWorkloadLoopback(
      Number(new URL(endpoint.url).port),
      (connected) =>
        !parent.cancelRequested &&
        parent.result.state === "started" &&
        !child.cancelRequested &&
        child.result.state === "started" &&
        jobDigest(this.policy(policy.serviceId) ?? null) === jobDigest(policy) &&
        child.handle?.ownsLoopbackConnection(connected) === true,
      lifetime,
    );
    return { ...endpoint, socket };
  }

  private openServiceTunnel(channelId: string, signal: AbortSignal): OwnedServiceTunnel {
    if (
      !this.sink ||
      this.draining ||
      this.serviceTunnels.has(channelId) ||
      this.serviceTunnels.size >= 64
    )
      throw new Error("service_unavailable");
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      signal,
      controller.signal,
      this.seatController.signal,
      this.configurationController.signal,
    ]);
    lifetime.throwIfAborted();
    const wire = createServiceTunnel({
      channelId,
      signal: lifetime,
      send: (frame) => this.sink?.({ type: "service_tunnel_frame", frame }) === true,
    });
    const tunnel: OwnedServiceTunnel = { wire, signal: lifetime, controller };
    this.serviceTunnels.set(channelId, tunnel);
    wire.stream.on("error", () => controller.abort());
    wire.stream.once("close", () => {
      controller.abort();
      tunnel.ready?.(null);
      if (this.serviceTunnels.get(channelId) === tunnel) this.serviceTunnels.delete(channelId);
    });
    return tunnel;
  }

  private async remoteService(
    job: OwnedJob,
    policy: ServicePolicy,
    signal: AbortSignal,
  ): Promise<JobServiceEndpoint & { signal: AbortSignal; socket: Duplex }> {
    if (
      !policy.remote ||
      job.result.state !== "started" ||
      job.cancelRequested ||
      jobDigest(this.policy(policy.serviceId) ?? null) !== jobDigest(policy)
    )
      throw new Error("service_unavailable");
    const channelId = randomUUID();
    const tunnel = this.openServiceTunnel(
      channelId,
      AbortSignal.any([signal, job.serviceController.signal]),
    );
    const ready = Promise.withResolvers<JobServiceEndpoint | null>();
    tunnel.ready = ready.resolve;
    const timer = setTimeout(() => tunnel.controller.abort(), 5000);
    try {
      if (
        !this.sink?.({
          type: "service_tunnel_open",
          channelId,
          jobId: job.request.jobId,
          serviceId: policy.serviceId,
          revision: policy.revision,
          policySha256: jobDigest(policy),
        })
      )
        tunnel.controller.abort();
      const endpoint = await ready.promise;
      delete tunnel.ready;
      if (!endpoint || tunnel.signal.aborted) throw new Error("service_unavailable");
      return { ...endpoint, signal: tunnel.signal, socket: tunnel.wire.stream };
    } catch {
      tunnel.controller.abort();
      throw new Error("service_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  private async acceptServiceTunnel(
    command: Extract<JobCommand, { type: "service_tunnel_open" }>,
  ): Promise<void> {
    const policy = this.policy(command.serviceId);
    if (
      !policy ||
      policy.runtime?.scope !== "instance" ||
      policy.revision !== command.revision ||
      jobDigest(policy) !== command.policySha256 ||
      command.operationIds.some(
        (id) => !policy.operations[id] || !("kind" in policy.operations[id]!),
      )
    ) {
      this.emit({ type: "service_tunnel_ready", channelId: command.channelId, endpoint: null });
      return;
    }
    let tunnel: OwnedServiceTunnel | undefined;
    let proxy: JobServiceProxy | undefined;
    let socket: Socket | undefined;
    try {
      tunnel = this.openServiceTunnel(command.channelId, this.seatController.signal);
      tunnel.command = command;
      const signal = tunnel.signal;
      proxy = await createJobServiceProxy({
        policies: [policy],
        bindings: [
          {
            serviceId: policy.serviceId,
            revision: policy.revision,
            operationIds: command.operationIds,
          },
        ],
        signal,
        authorize: (call, requestSignal) =>
          this.authorizeService(
            { kind: "tunnel", channelId: command.channelId },
            call,
            command.policySha256,
            requestSignal,
          ),
        resolveRuntime: (bound, requestSignal) => this.instanceService(bound, requestSignal),
      });
      const connected = Promise.withResolvers<void>();
      socket = createConnection({
        host: "127.0.0.1",
        port: Number(new URL(proxy.url).port),
        signal,
      });
      socket.once("connect", connected.resolve);
      socket.on("error", () => {
        connected.reject(new Error("service_unavailable"));
        tunnel?.controller.abort();
      });
      await connected.promise;
      signal.throwIfAborted();
      const heldProxy = proxy;
      const heldSocket = socket;
      tunnel.wire.stream.once("close", () => {
        heldSocket.destroy();
        void heldProxy.close();
      });
      socket.once("close", () => tunnel?.controller.abort());
      tunnel.wire.stream.pipe(socket).pipe(tunnel.wire.stream);
      if (
        !this.sink?.({
          type: "service_tunnel_ready",
          channelId: command.channelId,
          endpoint: { url: proxy.url, bearer: proxy.bearer },
        })
      )
        throw new Error("service_unavailable");
    } catch {
      tunnel?.controller.abort();
      socket?.destroy();
      await proxy?.close();
      this.emit({ type: "service_tunnel_ready", channelId: command.channelId, endpoint: null });
    }
  }

  private async instanceService(
    policy: ServicePolicy,
    signal: AbortSignal,
  ): Promise<JobServiceEndpoint & { signal: AbortSignal; socket: Socket }> {
    signal.throwIfAborted();
    const instance = this.instanceRuntimeServices.get(policy.serviceId);
    if (
      !instance ||
      instance.port === null ||
      policy.runtime?.scope !== "instance" ||
      instance.job.result.state !== "started" ||
      instance.job.cancelRequested ||
      instance.job.serviceController.signal.aborted ||
      jobDigest(instance.policy) !== jobDigest(policy) ||
      jobDigest(this.policy(policy.serviceId) ?? null) !== jobDigest(policy)
    )
      throw new Error("service_unavailable");
    const lifetime = AbortSignal.any([
      signal,
      instance.job.serviceController.signal,
      this.configurationController.signal,
    ]);
    const socket = await connectWorkloadLoopback(
      instance.port,
      (connected) =>
        !instance.job.cancelRequested &&
        instance.job.result.state === "started" &&
        jobDigest(this.policy(policy.serviceId) ?? null) === jobDigest(policy) &&
        instance.job.handle?.ownsLoopbackConnection(connected) === true,
      lifetime,
    );
    return {
      url: `http://127.0.0.1:${instance.port}`,
      bearer: instance.bearer,
      signal: lifetime,
      socket,
    };
  }
  private publishInstanceReady(instance: InstanceRuntimeService): void {
    const job = instance.job;
    if (
      instance.port !== null &&
      job.request.service &&
      job.result.state === "started" &&
      !job.cancelRequested &&
      !job.serviceController.signal.aborted &&
      jobDigest(this.policy(instance.policy.serviceId) ?? null) === jobDigest(instance.policy) &&
      job.handle?.ownsLoopbackListener(instance.port)
    )
      this.emit(
        { type: "service_ready", jobId: job.request.jobId, service: job.request.service },
        job,
      );
  }
  private async announceServiceReady(job: OwnedJob, port: number): Promise<void> {
    await job.launched;
    if (job.request.service) {
      const instance = this.instanceRuntimeServices.get(job.request.service.serviceId);
      if (
        !instance ||
        instance.job !== job ||
        instance.port !== null ||
        job.result.state !== "started" ||
        job.cancelRequested ||
        job.serviceController.signal.aborted ||
        jobDigest(this.policy(instance.policy.serviceId) ?? null) !== jobDigest(instance.policy) ||
        !job.handle?.ownsLoopbackListener(port)
      )
        throw new Error("service_listener_unproven");
      instance.port = port;
      clearTimeout(instance.startupTimer);
      instance.startupTimer = undefined;
      this.publishInstanceReady(instance);
      return;
    }
    const runtime = job.serviceRuntime;
    const parent = job.request.parent && this.jobs.get(job.request.parent.parentJobId);
    if (
      !runtime ||
      !parent ||
      parent.runtimeServices.get(runtime.policy.serviceId) !== runtime ||
      parent.cancelRequested ||
      parent.serviceController.signal.aborted ||
      job.result.state !== "started" ||
      job.cancelRequested ||
      job.serviceController.signal.aborted ||
      runtime.childJobId !== job.request.jobId ||
      jobDigest(this.policy(runtime.policy.serviceId) ?? null) !== jobDigest(runtime.policy) ||
      !job.handle?.ownsLoopbackListener(port)
    )
      throw new Error("service_listener_unproven");
    runtime.resolve({
      url: `http://127.0.0.1:${port}`,
      bearer: runtime.bearer,
      signal: job.serviceController.signal,
    });
  }

  private emitInputState(job: OwnedJob): void {
    this.emit(
      {
        type: "input_state",
        jobId: job.request.jobId,
        requestDigest: job.request.requestDigest,
        ownerId: job.result.ownerId,
        ownerGeneration: job.result.ownerGeneration,
        nextInputSeq: job.inputSeq,
        stdinClosed: job.inputEnded,
      },
      job,
    );
  }

  private async input(
    command: Extract<JobCommand, { type: "input" }>,
    parentJobId: string | null,
  ): Promise<void> {
    const job = this.requireJob(command.jobId);
    const reply = (accepted: boolean, reason: string | null) =>
      this.emit(
        {
          type: "input_result",
          jobId: command.jobId,
          requestId: command.requestId,
          seq: command.seq,
          accepted,
          reason,
          nextInputSeq: job.inputSeq,
          stdinClosed: job.inputEnded,
        },
        job,
      );
    const data = Buffer.from(command.data, "base64");
    const seat = this.sink;
    if (job.inputRequests.has(command.requestId)) {
      // A duplicate does not prove that the original command was unconsumed.
      reply(false, "job_input_delivery_unknown");
      return;
    }
    if (
      job.request.terminal ||
      job.result.state !== "started" ||
      !job.handle ||
      job.inputEnded ||
      job.inputBusy ||
      command.seq !== job.inputSeq ||
      job.inputSeq === Number.MAX_SAFE_INTEGER ||
      job.inputRequests.size >= 4096 ||
      job.inputBytes + data.length > job.request.limits.outputBytes ||
      !seat ||
      this.inputAuthorizations.has(command.requestId)
    ) {
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
        jobId: command.jobId,
        resolve: authorization.resolve,
      });
      timer = setTimeout(() => authorization.resolve(false), 5000);
      this.emit({
        type: "input_authorize",
        jobId: command.jobId,
        requestId: command.requestId,
        seq: command.seq,
        parentJobId,
      });
      const allowed = await authorization.promise;
      clearTimeout(timer);
      this.inputAuthorizations.delete(command.requestId);
      if (
        !allowed ||
        this.sink !== seat ||
        job.cancelRequested ||
        job.result.state !== "started" ||
        !job.handle ||
        job.inputEnded
      ) {
        reply(false, "job_input_authority_or_state_refused");
        return;
      }
      // Consume the cursor durably before touching stdin; neither a partial write nor
      // a lost receipt permits replay. The journal contains no input bytes or digest.
      this.options.journal.append({
        kind: "input",
        jobId: command.jobId,
        requestId: command.requestId,
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
    try {
      artifact = openCachedArtifact(spec, this.options.cache);
    } catch {
      /* Report unavailable, never ambient fallback. */
    }
    const key = this.installKey(command.pluginId, command.installationRevision);
    const tools = new Map<string, PinnedArtifact>();
    const toolFailures = new Map<string, string>();
    for (const [alias, platforms] of Object.entries(command.machine.tools ?? {})) {
      const tool = platforms[this.platform()];
      try {
        if (!tool) throw new Error("runtime_tool_platform_unavailable");
        tools.set(alias, openCachedArtifact(tool, this.options.cache));
      } catch {
        toolFailures.set(alias, "runtime_tool_cache_unavailable");
      }
    }
    this.installs.get(key)?.artifact?.close();
    for (const tool of this.installs.get(key)?.tools.values() ?? []) tool.close();
    this.installs.set(key, {
      command: { ...command, action: undefined },
      enabled: command.action !== "disable",
      artifact,
      tools,
      toolFailures,
      runtimeAliases,
    });
  }

  private async install(incoming: Extract<JobCommand, { type: "install" }>): Promise<void> {
    const { artifact: delivery, toolArtifacts, ...command } = incoming;
    const artifactSpec = command.machine.artifacts[this.platform()];
    if (!artifactSpec || artifactSpec.sha256 !== command.artifactSha256)
      throw new Error("unsupported_artifact_platform");
    const runtimeAliases = this.runtimeAliases(command);
    if (command.action) {
      if (delivery !== undefined || toolArtifacts !== undefined)
        throw new Error("artifact_unexpected_delivery");
    }
    if (this.draining && !command.action) throw new Error("owner_draining");
    const key = this.installKey(command.pluginId, command.installationRevision);
    const existing = this.installs.get(key);
    const primarySource = `${artifactSpec.url ?? artifactSpec.bundleFile}\0${artifactSpec.sha256}`;
    const selectedTools = Object.entries(command.machine.tools ?? {})
      .map(([alias, platforms]) => {
        const spec = platforms[this.platform()];
        return [alias, spec, spec ? `${spec.url ?? spec.bundleFile}\0${spec.sha256}` : ""] as const;
      })
      .sort((a, b) =>
        a[2] === b[2]
          ? 0
          : a[2] === primarySource
            ? -1
            : b[2] === primarySource
              ? 1
              : a[2].localeCompare(b[2]),
      );
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
        const specs = [artifactSpec, ...selectedTools.flatMap(([, spec]) => (spec ? [spec] : []))];
        for (const spec of specs) {
          for (const digest of new Set([
            spec.entrySha256,
            ...Object.values(spec.files ?? {}).map((file) => file.sha256),
          ])) {
            const name = artifactCacheKey(spec, digest);
            const shared = [...this.installs.values()].some((installation) => {
              const machine = installation.command.machine;
              const others = [
                machine.artifacts[this.platform()],
                ...Object.values(machine.tools ?? {}).map(
                  (platforms) => platforms[this.platform()],
                ),
              ];
              return others.some((other) => other && artifactCacheKey(other, digest) === name);
            });
            if (!shared) {
              try {
                this.options.cache.unlink(name);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
          }
        }
      }
      this.publishInstallation(command);
      return;
    }
    if (existing) {
      deliveredArtifact(artifactSpec, delivery, decoded);
      if (jobDigest(existing.command) !== jobDigest(command))
        throw new Error("installation_revision_changed");
      if (!existing.artifact)
        existing.artifact = await acquireArtifact(
          artifactSpec,
          this.options.cache,
          this.options.artifactAuthority,
          delivery,
          archives,
          decoded,
        );
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
        archives,
        decoded,
      );
      try {
        if (this.draining || this.installs.has(key)) throw new Error("installation_raced");
        this.options.journal.append({ kind: "install", command });
        this.installs.set(key, {
          command,
          artifact,
          enabled: true,
          tools: new Map(),
          toolFailures: new Map(),
          runtimeAliases,
        });
      } catch (error) {
        artifact.close();
        throw error;
      }
    }
    const installation = this.installs.get(key)!;
    for (const [alias, spec] of selectedTools) {
      try {
        if (!spec) throw new Error("runtime_tool_platform_unavailable");
        const member: JobArtifactDelivery | undefined =
          spec.bundleFile === undefined
            ? undefined
            : delivery?.bundleFile === spec.bundleFile
              ? delivery
              : toolArtifacts?.[spec.bundleFile] === undefined
                ? undefined
                : { bundleFile: spec.bundleFile, data: toolArtifacts[spec.bundleFile]! };
        const artifact = await acquireArtifact(
          spec,
          this.options.cache,
          this.options.artifactAuthority,
          member,
          archives,
          decoded,
        );
        installation.tools.get(alias)?.close();
        installation.tools.set(alias, artifact);
        installation.toolFailures.delete(alias);
      } catch (error) {
        installation.tools.get(alias)?.close();
        installation.tools.delete(alias);
        installation.toolFailures.set(
          alias,
          error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message)
            ? error.message
            : "runtime_tool_acquisition_refused",
        );
      }
    }
    this.publishInstallation(command);
  }

  /** Private in-process handoff from the sole TerminalHost, never a job RPC command. */
  async startTerminal(
    command: Extract<JobCommand, { type: "start" }>,
    terminalId: string,
    terminalHostId: string,
    launch: (spec: LinuxJobSpec) => Promise<LinuxJobHandle>,
  ): Promise<void> {
    const binding = command.request.terminal;
    if (
      !this.ready ||
      !binding ||
      binding.terminalId !== terminalId ||
      binding.terminalHostId !== terminalHostId ||
      terminalHostId !== this.terminalHostId ||
      command.request.parent
    )
      throw new Error("terminal_binding_refused");
    await this.start(command, launch);
  }

  /** Signature/identity authentication is independent of admission freshness. Old permits
   * may reconcile absence after recovery, but can never admit into a new generation. */
  private verifyAdmission({
    request,
    permit,
  }: Pick<Extract<JobCommand, { type: "start" }>, "request" | "permit">): void {
    const { requestDigest, ...immutable } = request;
    const { signature, ...signedPermit } = permit;
    if (
      jobDigest(immutable) !== requestDigest ||
      request.machineId !== this.options.machineId ||
      permit.jobId !== request.jobId ||
      permit.requestDigest !== requestDigest ||
      permit.ownerId !== this.options.journal.ownerId ||
      permit.ownerGeneration > this.options.journal.generation ||
      !verify(
        null,
        Buffer.from(canonicalJobJson(signedPermit)),
        this.admissionKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error("start_permit_refused");
  }

  private rejectUnadmitted(
    admission: Pick<Extract<JobCommand, { type: "start" }>, "request" | "permit">,
  ): OwnedJob {
    const { request, permit } = admission;
    if (this.jobs.has(request.jobId) || this.permits.has(permit.permitId))
      throw new Error("job_identity_changed");
    const job = this.newJob(request);
    job.result = {
      ...job.result,
      ownerGeneration: permit.ownerGeneration,
      state: "refused",
      reason: "start_not_admitted",
      finishedAt: Date.now(),
    };
    // No proof leaves this process until replay is fenced by an fsynced identity.
    this.options.journal.append({
      kind: "rejection",
      request,
      permitId: permit.permitId,
      result: job.result,
    });
    this.jobs.set(request.jobId, job);
    this.permits.add(permit.permitId);
    job.inputEnded = true;
    job.resolveEmpty();
    job.resolveLaunched();
    job.resolveFinalized();
    this.emit({ type: "result", result: job.result }, job);
    return job;
  }

  private async reconcileStart(
    command: Extract<JobCommand, { type: "status" | "cancel" }>,
  ): Promise<OwnedJob> {
    if (command.admission) {
      this.verifyAdmission(command.admission);
      if (command.jobId !== command.admission.request.jobId)
        throw new Error("job_identity_changed");
    }
    await this.pendingStarts.get(command.jobId);
    const job = this.jobs.get(command.jobId);
    if (job) {
      if (
        command.admission &&
        (job.request.requestDigest !== command.admission.request.requestDigest ||
          job.result.ownerGeneration !== command.admission.permit.ownerGeneration)
      )
        throw new Error("job_identity_changed");
      return job;
    }
    if (!command.admission) throw new Error("unknown_job");
    return this.rejectUnadmitted(command.admission);
  }

  private async start(
    command: Extract<JobCommand, { type: "start" }>,
    terminalLaunch?: (spec: LinuxJobSpec) => Promise<LinuxJobHandle>,
  ): Promise<void> {
    this.verifyAdmission(command);
    if (this.pendingStarts.has(command.request.jobId))
      await this.pendingStarts.get(command.request.jobId);
    const pending = Promise.withResolvers<void>();
    this.pendingStarts.set(command.request.jobId, pending.promise);
    try {
      await this.prepareStart(command, terminalLaunch);
    } catch (error) {
      if (!this.jobs.has(command.request.jobId)) this.rejectUnadmitted(command);
      throw error;
    } finally {
      this.pendingStarts.delete(command.request.jobId);
      pending.resolve();
    }
  }

  private async prepareStart(
    command: Extract<JobCommand, { type: "start" }>,
    terminalLaunch?: (spec: LinuxJobSpec) => Promise<LinuxJobHandle>,
  ): Promise<void> {
    const { request, permit } = command;
    const { requestDigest } = request;
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (request.terminal) throw new Error("terminal_admission_reused");
      if (existing.request.requestDigest !== requestDigest) throw new Error("job_identity_changed");
      this.emitEmpty(existing);
      this.emit({ type: "result", result: existing.result }, existing);
      return;
    }
    if ([...this.jobs.values()].filter((job) => !job.emptyObserved).length >= 64)
      throw new Error("owner_active_job_limit");
    const now = Date.now();
    if (
      this.draining ||
      permit.ownerGeneration !== this.options.journal.generation ||
      permit.expiresAt <= now ||
      permit.issuedAt > now ||
      permit.expiresAt - permit.issuedAt > 30_000 ||
      this.permits.has(permit.permitId)
    )
      throw new Error("start_permit_refused");
    if (Boolean(request.terminal) !== Boolean(terminalLaunch))
      throw new Error("terminal_host_required");
    const installation = this.installs.get(
      this.installKey(request.pluginId, request.installationRevision),
    );
    const operation = installation?.command.machine.operations[request.operationId];
    if (
      !installation?.enabled ||
      !installation.artifact ||
      !operation ||
      installation.command.artifactSha256 !== request.artifactSha256
    )
      throw new Error("operation_not_installed");
    if (
      jobDigest(request.resourceBindings ?? null) !==
      jobDigest(
        jobResourceBindingsFor(
          installation.command.machine,
          request.operationId,
          this.platform(),
          installation.command.resourceBindings,
        ) ?? null,
      )
    )
      throw new Error("resource_bindings_mismatch");
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
        parent.cancelRequested ||
        parent.serviceController.signal.aborted ||
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
    job.serviceRuntime =
      parent && request.parent
        ? [...parent.runtimeServices.values()].find(
            (runtime) => runtime.invocationId === request.parent!.invocationId,
          )
        : undefined;
    if (operation.providesService && !job.serviceRuntime && !request.service)
      throw new Error("service_runtime_parent_required");
    if (job.serviceRuntime) {
      const expected = job.serviceRuntime.policy.runtime!;
      if (
        job.serviceRuntime.childJobId !== null ||
        jobDigest(this.policy(job.serviceRuntime.policy.serviceId) ?? null) !==
          jobDigest(job.serviceRuntime.policy) ||
        expected.pluginId !== request.pluginId ||
        expected.operationId !== request.operationId ||
        expected.installationRevision !== request.installationRevision ||
        expected.artifactSha256 !== request.artifactSha256 ||
        expected.resourceBindingDigest !== jobDigest(request.resourceBindings ?? null)
      )
        throw new Error("service_runtime_binding_mismatch");
      job.serviceRuntime.childJobId = request.jobId;
    }
    let spawnAttempted = false;
    try {
      if (request.service) {
        const policy = this.policy(request.service.serviceId);
        // request.service.revision is the signed registry CAS identity, not the
        // manifest's contract revision; the complete reviewed policy stays digest-bound.
        const runtime = policy?.runtime;
        if (
          !policy ||
          !runtime ||
          runtime.scope !== "instance" ||
          !operation.providesService ||
          jobDigest(policy) !== request.service.policySha256 ||
          runtime.pluginId !== request.pluginId ||
          runtime.operationId !== request.operationId ||
          runtime.installationRevision !== request.installationRevision ||
          runtime.artifactSha256 !== request.artifactSha256 ||
          runtime.resourceBindingDigest !== jobDigest(request.resourceBindings ?? null) ||
          Object.values(runtime.input).some((source) => !("literal" in source)) ||
          jobDigest(request.input) !==
            jobDigest(
              Object.fromEntries(
                Object.entries(runtime.input).map(([name, source]) => [
                  name,
                  "literal" in source ? source.literal : undefined,
                ]),
              ),
            ) ||
          this.instanceRuntimeServices.has(policy.serviceId)
        )
          throw new Error("instance_service_binding_mismatch");
        const instance: InstanceRuntimeService = {
          policy,
          job,
          bearer: randomBytes(32).toString("base64url"),
          port: null,
          startupTimer: undefined,
        };
        this.instanceRuntimeServices.set(policy.serviceId, instance);
        void job.empty.then(() => {
          if (this.instanceRuntimeServices.get(policy.serviceId) === instance)
            this.instanceRuntimeServices.delete(policy.serviceId);
        });
        void job.launched.then(() => {
          if (job.result.state !== "started" || instance.port !== null || job.cancelRequested)
            return;
          instance.startupTimer = setTimeout(() => {
            void this.cancel(request.jobId).catch(() => {
              this.draining = true;
            });
          }, 30_000);
        });
      }
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
        if ((!resource.managed && !anchor) || job.locations.has(declaration.locationId))
          throw new Error("location_anchor_unavailable_or_duplicate");
        const beforeCreate = (parentFd: number) =>
          this.options.outputs.assertCreateAllowed(parentFd, preparation);
        const resolved = resource.managed
          ? resolveManagedJobLocation(
              this.options.managedState,
              request.pluginId,
              declaration.locationId,
              resource,
              declaration.access,
              beforeCreate,
            )
          : resolveJobLocation(
              anchor!,
              declaration.locationId,
              resource,
              declaration.access,
              this.exclusions,
              beforeCreate,
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
      const workingDirectory = operation.workingDirectory
        ? job.locations.get(operation.workingDirectory.locationId)
        : undefined;
      if (operation.workingDirectory && !workingDirectory?.directory)
        throw new Error("working_directory_unavailable");
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
        service: (call, signal) => this.jobServiceCall(job, call, signal),
        serviceReady: (port) => this.announceServiceReady(job, port),
        failure: (reason) => {
          const pending = [...(job.context?.invocations.values() ?? [])].some(
            (invocation) =>
              invocation.origin === "worker" &&
              !invocation.refused &&
              (invocation.childJobId === null ||
                !this.jobs.get(invocation.childJobId)?.childExitSent),
          );
          // Closing an unused context during ordinary process exit is not a cancellation.
          if (reason === "context_closed" && !pending && !operation.providesService) return;
          void this.cancel(request.jobId).catch(() => {
            this.draining = true;
          });
        },
      });
      job.context.send(
        WorkerContextSchema.parse({
          type: "context",
          locations: [...job.locations].map(([locationId, location]) => ({
            locationId,
            guestPath: location.guestPath,
            access: location.access,
          })),
        }),
      );
      const runtime: LinuxJobBind[] = [];
      for (const tool of operation.runtimeTools) {
        const configured = this.runtimeTool(installation, tool);
        if (!configured) throw new Error("runtime_tool_unavailable");
        for (const bind of configured)
          if (!runtime.some((prior) => prior.fd === bind.fd && prior.target === bind.target))
            runtime.push(bind);
      }
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
      await this.prepareServiceProxies(job, operation);
      if (job.cancelRequested) throw new Error("cancelled_before_start");
      job.inputFiles = materializeJobInputs(
        operation,
        request.input,
        job.serviceProxies,
        request.service
          ? this.instanceRuntimeServices.get(request.service.serviceId)?.bearer
          : job.serviceRuntime?.bearer,
      );
      const spec: LinuxJobSpec = {
        bubblewrapFd: this.options.bubblewrapFd,
        artifactFd: installation.artifact.fd,
        ...(operation.executable
          ? { executableRuntimeTool: operation.executable.runtimeTool }
          : {}),
        inputFiles: job.inputFiles,
        argv: operation.argv
          .filter((slot) => !slot.when || request.input[slot.when.input] === slot.when.equals)
          .map((slot) => ("literal" in slot ? slot.literal : String(request.input[slot.input]))),
        runtime,
        locations,
        ...(workingDirectory ? { workingDirectory: workingDirectory.guestPath } : {}),
        outputs: job.leases.map((lease) => ({
          fd: lease.directory.fd,
          target: `/outputs/${lease.name}`,
          writable: true,
        })),
        delegatedCgroup: parent?.handle?.childDelegation ?? this.options.delegatedCgroup,
        limits: request.limits,
        ...(request.service ? { persistentService: true as const } : {}),
        ...(operation.environment ? { environment: operation.environment } : {}),
        network: operation.network,
        providesService: operation.providesService === true,
        bidirectional: operation.stdin,
        nestedCgroup: true,
        contextFd: job.context.childFd,
        ...(request.terminal
          ? {}
          : {
              onOutput: (output: LinuxJobOutput) => {
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
            }),
      };
      preflightLinuxJob(spec);
      for (const lease of job.leases)
        job.releaseWriters.push(this.options.outputs.retainWriter(lease.directory.fd));
      const changed = this.operationUnavailable(installation, operation);
      if (changed) throw new Error(changed);
      spawnAttempted = true;
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
      if (!spawnAttempted || (error instanceof LinuxJobRefusal && error.workloadEmpty))
        job.resolveEmpty();
      if (error instanceof LinuxJobRefusal && !error.workloadEmpty)
        job.startupCleanup = error.cleanup;
      job.resolveLaunched();
      await this.closeServices(job);
      job.context?.close();
      const safelyRefused =
        !spawnAttempted || (error instanceof LinuxJobRefusal && error.workloadEmpty && !job.handle);
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
          job.result = {
            ...job.result,
            state: job.cancelRequested ? "cancelled" : "refused",
            reason:
              error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message)
                ? error.message
                : "job_preparation_refused",
            finishedAt: Date.now(),
          };
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
    await this.closeServices(job);
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
    for (const channel of job.request.terminal ? [] : (["stdout", "stderr"] as const))
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
    if (parent?.context && !job.serviceRuntime) {
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
    await this.closeServices(job);
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
    await this.closeServices(job);
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
    this.emitEmpty(job);
  }

  private validateInput(operation: MachineOperation, request: JobRequest): void {
    if (
      (request.limits.timeoutMs === 0) !== Boolean(request.service) ||
      (request.service && (request.parent || request.terminal))
    )
      throw new Error("invalid_service_lifetime");
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
      if (
        (!slot.when || request.input[slot.when.input] === slot.when.equals) &&
        "input" in slot &&
        !(slot.input in request.input)
      )
        throw new Error("argv_input_missing");
    for (const key of ["timeoutMs", "memoryBytes", "processes", "outputBytes"] as const)
      if (request.limits[key] > operation.limits[key]) throw new Error("operation_limit_exceeded");
  }

  private newJob(request: JobRequest): OwnedJob {
    const empty = Promise.withResolvers<void>();
    const launched = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<void>();
    const job: OwnedJob = {
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
      resolveEmpty: () => {
        if (job.emptyObserved) return;
        job.emptyObserved = true;
        empty.resolve();
        this.emitEmpty(job);
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
      serviceController: new AbortController(),
      serviceProxies: new Map(),
      runtimeServices: new Map(),
      serviceRuntime: undefined,
    };
    return job;
  }
  private requireJob(jobId: string): OwnedJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("unknown_job");
    return job;
  }
  private emitEmpty(job: OwnedJob): void {
    if (!job.emptyObserved || this.jobs.get(job.request.jobId) !== job) return;
    this.emit(
      {
        type: "workload_empty",
        jobId: job.request.jobId,
        requestDigest: job.request.requestDigest,
        ownerId: job.result.ownerId,
        ownerGeneration: job.result.ownerGeneration,
      },
      job,
    );
  }
  private emit(event: JobEvent, job?: OwnedJob): void {
    const parent = job?.request.parent && this.jobs.get(job.request.parent.parentJobId);
    if (
      !job?.serviceRuntime &&
      parent?.context &&
      (event.type === "output" ||
        event.type === "refusal" ||
        (event.type === "result" && !job?.childExitSent) ||
        event.type === "state" ||
        event.type === "input_result" ||
        event.type === "input_state")
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
  private runtimeTool(
    installation: Installation,
    alias: string,
  ): readonly LinuxJobBind[] | undefined {
    const source = installation.runtimeAliases.get(alias);
    if (source) {
      const artifact =
        source.tool === null ? installation.artifact : installation.tools.get(source.tool);
      const pinned = source.companion ? artifact?.files[alias] : artifact;
      const spec =
        source.tool === null
          ? installation.command.machine.artifacts[this.platform()]
          : installation.command.machine.tools?.[source.tool]?.[this.platform()];
      const relative = source.companion ? spec?.files?.[alias]?.relativeTarget : undefined;
      const target = relative
        ? `${source.tool === null ? "/job" : "/runtime/bin"}/${relative.join("/")}`
        : `/runtime/bin/${alias}`;
      return pinned ? [{ fd: pinned.fd, target, writable: false }] : undefined;
    }
    return Object.hasOwn(this.options.runtimeTools, alias)
      ? this.options.runtimeTools[alias]
      : undefined;
  }
  private operationRuntimeUnavailable(
    installation: Installation,
    operation: MachineOperation,
  ): string | undefined {
    if (!installation.enabled || !installation.artifact) return "operation_not_installed";
    for (const alias of operation.runtimeTools) {
      const binds = this.runtimeTool(installation, alias);
      if (!binds) return installation.toolFailures.get(alias) ?? "runtime_tool_unavailable";
      if (operation.executable?.runtimeTool === alias) {
        const matches = binds.filter(
          (bind) => bind.target === `/runtime/bin/${alias}` && !bind.writable,
        );
        if (matches.length !== 1) return "runtime_executable_unavailable";
        try {
          const stat = fstatSync(matches[0]!.fd);
          if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o6022)
            return "runtime_executable_untrusted";
        } catch {
          return "runtime_executable_unavailable";
        }
      }
    }
    return undefined;
  }
  private operationUnavailable(
    installation: Installation,
    operation: MachineOperation,
  ): string | undefined {
    const basic = this.operationRuntimeUnavailable(installation, operation);
    if (basic) return basic;
    const operationId = Object.keys(installation.command.machine.operations).find(
      (id) => installation.command.machine.operations[id] === operation,
    );
    if (!operationId) return "unknown_operation";
    this.refreshOperationResources(installation, operationId);
    return (
      jobResourceRefusal(
        installation.command.machine,
        operationId,
        this.platform(),
        installation.command.resourceBindings,
        this.resources.snapshot(),
      ) ?? undefined
    );
  }
  installedResources(pluginId: string, revision: string): JobInstallationResources {
    const installation = this.installs.get(this.installKey(pluginId, revision));
    // Publishing observations must not block the control loop on tool trees.
    // Admission and the pre-spawn check refresh their required resource fingerprints.
    const inventory = installation ? this.resources.snapshot() : undefined;
    return {
      artifactAvailable: installation?.artifact !== null && installation?.artifact !== undefined,
      tools: installation
        ? [
            ...new Set([
              ...Object.keys(installation.command.machine.tools ?? {}),
              ...Object.values(installation.command.machine.operations).flatMap(
                (operation) => operation.runtimeTools,
              ),
            ]),
          ].map((alias) => {
            const managed = Object.hasOwn(installation.command.machine.tools ?? {}, alias);
            const artifact = installation.tools.get(alias);
            return {
              alias,
              managed,
              available: this.runtimeTool(installation, alias) !== undefined,
              ...(artifact
                ? { artifactSha256: artifact.archiveSha256, entrySha256: artifact.entrySha256 }
                : {}),
              ...(installation.toolFailures.has(alias)
                ? { reason: installation.toolFailures.get(alias)! }
                : {}),
            };
          })
        : [],
      operations: installation
        ? Object.entries(installation.command.machine.operations).map(
            ([operationId, operation]) => {
              const reason =
                this.operationRuntimeUnavailable(installation, operation) ??
                jobResourceRefusal(
                  installation.command.machine,
                  operationId,
                  this.platform(),
                  installation.command.resourceBindings,
                  inventory!,
                ) ??
                undefined;
              return {
                operationId,
                available: reason === undefined,
                ...(reason ? { reason } : {}),
              };
            },
          )
        : [],
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
    this.seatController.abort();
    this.configurationController.abort();
    this.serviceRunner.close();
    for (const pending of this.directServiceCalls.values()) pending.controller.abort();
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
