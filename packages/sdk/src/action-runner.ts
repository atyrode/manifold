import {
  ACTION_RUNNER_MAX_FRAMES,
  AcknowledgeAgentPolicyResultSchema,
  ActionRunnerActivitySchema,
  ActionRunnerBindSchema,
  ActionRunnerRequestSchema,
  ActionRunnerReadResultsSchema,
  ActionRunnerResponseSchema,
  AgentPolicyChallengeSchema,
  CreateRunCredentialResultSchema,
  FinishAgentRunResultSchema,
  InspectRunResultSchema,
  JsonProjectionError,
  MANIFOLD_ROOT_URI,
  RenewAgentRunResultSchema,
  actionResultProjectionDigest,
  compileJsonProjection,
  projectJson,
  type ActionResultProjection,
  type ActionRunnerReadResults,
  type JsonProjection,
  type ActionProtocol,
  type ActionRunnerBind,
  type ActionRunnerRequest,
  type ActionRunnerResponse,
  type AgentPolicyChallenge,
  type AgentRun,
  type AgentRunTerminalOutcome,
} from "@manifold/protocol";
import {
  ActionHttpError,
  ActionProtocolError,
  discoverActions,
  invokeAction,
  type ActionHttpOptions,
  type ActionInvocation,
} from "./action-http.ts";

type RunnerErrorCode = Extract<ActionRunnerResponse, { type: "error" }>["code"];
export class ActionRunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    readonly traceId: number | null = null,
  ) {
    super(code);
    this.name = "ActionRunnerError";
  }
}

interface OwnedRun {
  run: Pick<AgentRun, "id" | "agentId" | "parentRunId" | "target" | "expiresAt">;
  token: string;
  policy: AgentPolicyChallenge | null;
  acknowledged: boolean;
  finished: boolean;
}

interface ReadResultContract {
  digest: string;
  projection: JsonProjection;
  policy: ActionResultProjection;
  maxResultBytes: number;
}

const MAX_RESPONSE_BYTES = 16 * 1_048_576;

const LIFECYCLE = {
  create: "core.access.createRun",
  child: "core.access.createChildRun",
  inspect: "core.access.inspectRun",
  activity: "core.access.reportRunActivity",
  policy: "core.access.getAgentPolicy",
  ack: "core.access.acknowledgeAgentPolicy",
  renew: "core.access.renewAgentRun",
  finish: "core.access.finishAgentRun",
} as const;

/** The sole sequence executor. No bearer-bearing value is returned by its public methods. */
export class ActionRunner {
  readonly #origin: string;
  #launcherToken: string;
  readonly #binding: ActionRunnerBind;
  readonly #emit: (frame: ActionRunnerResponse) => void;
  readonly #runs = new Map<string, OwnedRun>();
  readonly #ids = new Set<string>();
  readonly #secrets = new Set<string>();
  readonly #readResults: ActionRunnerReadResults;
  readonly #readContracts = new Map<
    string,
    ReadResultContract | "projection_unavailable" | "projection_changed"
  >();
  #protocol: ActionProtocol | null = null;
  #root: OwnedRun | null = null;
  #admissionUncertain = false;
  #activityFrames = 0;
  #closed = false;
  #cleanupConfirmed = false;
  #terminalOutcome: AgentRunTerminalOutcome | null = null;
  #attempt: { door: string; target: string; runId: string | null } | null = null;

  constructor(options: {
    origin: string;
    token: string;
    bind: ActionRunnerBind;
    readResults?: ActionRunnerReadResults;
    emit: (frame: ActionRunnerResponse) => void;
  }) {
    let url: URL;
    try {
      url = new URL(options.origin);
    } catch {
      throw new ActionRunnerError("invalid_frame");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/" ||
      !/^[a-f0-9]{64}$/i.test(options.token)
    )
      throw new ActionRunnerError("credential_input");
    this.#origin = url.origin;
    this.#launcherToken = options.token;
    this.#secrets.add(options.token);
    const binding = ActionRunnerBindSchema.safeParse(options.bind);
    if (!binding.success) throw new ActionRunnerError("invalid_frame");
    this.#checkInput(binding.data);
    this.#binding = binding.data;
    const readResults = ActionRunnerReadResultsSchema.safeParse(options.readResults ?? []);
    if (!readResults.success) throw new ActionRunnerError("invalid_frame");
    this.#readResults = readResults.data;
    this.#emit = options.emit;
  }

  get closed(): boolean {
    return this.#closed;
  }
  get successful(): boolean {
    return this.#closed && this.#cleanupConfirmed && this.#terminalOutcome === "completed";
  }

  #checkString(value: string): void {
    for (const secret of this.#secrets) {
      if (value.includes(secret)) throw new ActionRunnerError("credential_input");
    }
    if (/(?:bearer\s|[#?&](?:key|token|access_token|api_key)=|https?:\/\/[^/\s]+@)/i.test(value))
      throw new ActionRunnerError("credential_input");
  }

  /** Reject secret carriers recursively, including inside opaque action arguments. */
  #checkInput(
    value: unknown,
    depth = 0,
    budget = { nodes: Infinity },
    maxDepth = 32,
    maxArrayItems = Infinity,
  ): void {
    if (depth > maxDepth || --budget.nodes < 0) throw new ActionRunnerError("limit_exceeded");
    if (typeof value === "string") {
      this.#checkString(value);
    } else if (Array.isArray(value)) {
      if (value.length > maxArrayItems) throw new ActionRunnerError("limit_exceeded");
      for (const item of value) this.#checkInput(item, depth + 1, budget, maxDepth, maxArrayItems);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          /^(?:token|bearer|password|secret|credentials?|authorization|cookies?|privatekey|ownerkey|apikey|accesstoken|refreshtoken|sponsortoken|runnertoken|runtoken|manifoldrunnertoken|manifoldruntoken)$/i.test(
            key.replace(/[_-]/g, ""),
          )
        ) {
          throw new ActionRunnerError("credential_input");
        }
        this.#checkString(key);
        this.#checkInput(child, depth + 1, budget, maxDepth, maxArrayItems);
      }
    }
  }

  #send(frame: ActionRunnerResponse): void {
    const parsed = ActionRunnerResponseSchema.safeParse(frame);
    if (!parsed.success) throw new ActionRunnerError("invalid_response");
    const encoded = JSON.stringify(parsed.data);
    if (Buffer.byteLength(encoded) + 1 > MAX_RESPONSE_BYTES)
      throw new ActionRunnerError("limit_exceeded");
    // Do not redact policy bytes: fail closed rather than deliver a different challenge.
    for (const secret of this.#secrets) {
      if (encoded.includes(secret)) throw new ActionRunnerError("invalid_response");
    }
    this.#emit(parsed.data);
  }

  #options(run?: OwnedRun): ActionHttpOptions {
    return {
      origin: this.#origin,
      token: run?.token ?? this.#launcherToken,
      timeoutMs: 30_000,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    };
  }

  #owned(runId: string): OwnedRun {
    const run = this.#runs.get(runId);
    if (run === undefined || run.finished) throw new ActionRunnerError("invalid_state");
    return run;
  }

  #sponsor(run: OwnedRun): OwnedRun | undefined {
    // An adopted root refreshes its own bearer; Agent-mode roots retain the scoped runner.
    if (run === this.#root) return "runId" in this.#binding ? run : undefined;
    if (run.run.parentRunId === null) throw new ActionRunnerError("invalid_state");
    return this.#owned(run.run.parentRunId);
  }

  async #discover(id: string | null, run?: OwnedRun): Promise<ActionProtocol> {
    this.#protocol = await discoverActions(this.#options(run));
    this.#readContracts.clear();
    for (const entry of this.#readResults) {
      const action = this.#protocol.actions.find((candidate) => candidate.name === entry.door);
      const policy = action?.resultProjection;
      if (
        policy === undefined ||
        action?.runAccess !== undefined ||
        Object.values(LIFECYCLE).some((door) => door === entry.door)
      ) {
        this.#readContracts.set(entry.door, "projection_unavailable");
        continue;
      }
      const digest = await actionResultProjectionDigest(policy);
      this.#readContracts.set(
        entry.door,
        digest !== entry.contractDigest
          ? "projection_changed"
          : {
              digest,
              policy,
              projection: compileJsonProjection(policy.fields),
              maxResultBytes: Math.min(
                policy.maxResultBytes,
                entry.maxResultBytes ?? policy.maxResultBytes,
              ),
            },
      );
    }
    this.#send({ type: "discovery", id, runId: run?.run.id ?? null, ...this.#protocol });
    return this.#protocol;
  }

  async #call(
    run: OwnedRun | undefined,
    door: string,
    args: unknown,
    justification?: string,
    target = run?.run.target ?? MANIFOLD_ROOT_URI,
    attemptRunId = run?.run.id ?? null,
    resultProjectionDigest?: string,
  ): Promise<ActionInvocation> {
    this.#attempt = { door, target, runId: attemptRunId };
    if (this.#protocol === null || !this.#protocol.actions.some((action) => action.name === door)) {
      throw new ActionRunnerError("unknown_action");
    }
    return invokeAction(this.#options(run), door, args, {
      ...(justification === undefined ? {} : { agentJustification: justification }),
      ...(resultProjectionDigest === undefined ? {} : { resultProjectionDigest }),
    });
  }

  #projection(
    invocation: ActionInvocation,
    contract: ReadResultContract,
  ): NonNullable<Extract<ActionRunnerResponse, { type: "result" }>["projection"]> {
    const failure = (code: "projection_invalid" | "projection_limit") => ({
      ok: false as const,
      contractDigest: contract.digest,
      code,
      trust: "untrusted" as const,
    });
    if (!invocation.outcome.ok || invocation.traceId === null) return failure("projection_invalid");
    const envelope = invocation.outcome.projection;
    if (envelope === undefined || envelope.contractDigest !== contract.digest)
      return failure("projection_invalid");
    if (!envelope.ok) return failure(envelope.code);
    try {
      if (envelope.data === undefined) return failure("projection_invalid");
      // Bound and inspect the peer's complete sideband before selecting leaves again.
      this.#checkInput(envelope.data, 0, { nodes: 65_536 }, 16, contract.policy.maxArrayItems);
      if (Buffer.byteLength(JSON.stringify(envelope.data)) > contract.maxResultBytes)
        return failure("projection_limit");
      const data = projectJson(envelope.data, contract.projection, contract.policy.maxArrayItems);
      if (Buffer.byteLength(JSON.stringify(data)) > contract.maxResultBytes)
        return failure("projection_limit");
      return { ok: true, contractDigest: contract.digest, data, trust: "untrusted" };
    } catch (error) {
      return failure(
        (error instanceof JsonProjectionError && error.code === "limit") ||
          (error instanceof ActionRunnerError && error.code === "limit_exceeded")
          ? "projection_limit"
          : "projection_invalid",
      );
    }
  }

  #result(
    id: string | null,
    run: OwnedRun | null,
    door: string,
    target: string,
    invocation: ActionInvocation,
    extra: Pick<Extract<ActionRunnerResponse, { type: "result" }>, "expiresAt" | "cleanup"> = {},
    contract?: ReadResultContract,
  ): void {
    if (
      invocation.traceId === null &&
      (invocation.outcome.ok || invocation.outcome.denial.rule !== "unknown_action")
    ) {
      throw new ActionRunnerError("missing_trace");
    }
    // The raw result and free-form refusal message never cross stdio. A separately
    // requested and verified projection remains untrusted data, not a policy frame.
    this.#send({
      type: "result",
      id,
      runId: run?.run.id ?? null,
      door,
      target,
      traceId: invocation.traceId,
      outcome: invocation.outcome.ok
        ? { ok: true }
        : { ok: false, denial: { rule: invocation.outcome.denial.rule } },
      ...extra,
      ...(contract !== undefined && invocation.outcome.ok
        ? { projection: this.#projection(invocation, contract) }
        : {}),
    });
  }

  async #policy(id: string | null, run: OwnedRun): Promise<void> {
    const invocation = await this.#call(run, LIFECYCLE.policy, {});
    this.#result(id, run, LIFECYCLE.policy, run.run.target, invocation);
    if (!invocation.outcome.ok) throw new ActionRunnerError("invalid_state", invocation.traceId);
    const parsed = AgentPolicyChallengeSchema.safeParse(invocation.outcome.result);
    if (!parsed.success || parsed.data.runId !== run.run.id)
      throw new ActionRunnerError("invalid_response", invocation.traceId);
    for (const bundle of parsed.data.required) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundle.body));
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (hex !== bundle.digest)
        throw new ActionRunnerError("invalid_response", invocation.traceId);
    }
    run.policy = parsed.data;
    run.acknowledged = false;
    this.#send({
      type: "policy",
      id,
      runId: run.run.id,
      door: LIFECYCLE.policy,
      target: run.run.target,
      traceId: invocation.traceId,
      policy: parsed.data,
    });
  }

  #retain(run: OwnedRun["run"], token: string): OwnedRun {
    const owned: OwnedRun = { run, token, policy: null, acknowledged: false, finished: false };
    this.#secrets.add(token);
    this.#runs.set(run.id, owned);
    return owned;
  }

  /** Admission is launcher-owned and must finish before either input pipe is read. */
  async bind(): Promise<void> {
    if (this.#closed || this.#protocol !== null) throw new ActionRunnerError("invalid_state");
    this.#admissionUncertain = "runId" in this.#binding;
    const protocol = await this.#discover(null);
    for (const door of Object.values(LIFECYCLE)) {
      if (!protocol.actions.some((action) => action.name === door))
        throw new ActionRunnerError("unknown_action");
    }
    if ("runId" in this.#binding) {
      this.#admissionUncertain = true;
      const invocation = await this.#call(
        undefined,
        LIFECYCLE.inspect,
        { runId: this.#binding.runId },
        undefined,
        MANIFOLD_ROOT_URI,
        this.#binding.runId,
      );
      if (!invocation.outcome.ok) {
        this.#result(null, null, LIFECYCLE.inspect, MANIFOLD_ROOT_URI, invocation);
        throw new ActionRunnerError("invalid_state", invocation.traceId);
      }
      const parsed = InspectRunResultSchema.safeParse(invocation.outcome.result);
      if (
        !parsed.success ||
        parsed.data.availability !== "available" ||
        parsed.data.run.id !== this.#binding.runId
      )
        throw new ActionRunnerError("invalid_response", invocation.traceId);
      this.#root = this.#retain(parsed.data.run, this.#launcherToken);
      this.#admissionUncertain = false;
      this.#result(null, this.#root, LIFECYCLE.inspect, this.#root.run.target, invocation);
      await this.#policy(null, this.#root);
      return;
    }
    await this.#create(null, this.#binding);
  }

  async #create(
    id: string | null,
    declaration:
      | Exclude<ActionRunnerBind, { runId: string }>
      | Extract<ActionRunnerRequest, { type: "child" }>["declaration"],
    parent?: OwnedRun,
    justification?: string,
  ): Promise<void> {
    if (parent !== undefined && !parent.acknowledged) throw new ActionRunnerError("invalid_state");
    this.#admissionUncertain = parent === undefined;
    const door = parent === undefined ? LIFECYCLE.create : LIFECYCLE.child;
    const target =
      "target" in declaration && typeof declaration.target === "string"
        ? declaration.target
        : (parent?.run.target ?? MANIFOLD_ROOT_URI);
    const invocation = await this.#call(
      parent,
      door,
      parent === undefined ? declaration : { ...declaration, runId: parent.run.id },
      justification,
      target,
    );
    if (!invocation.outcome.ok) {
      this.#admissionUncertain = false;
      this.#result(id, parent ?? null, door, target, invocation);
      if (parent === undefined) await this.close("failed");
      else if (
        invocation.outcome.denial.rule === "policy_stale" ||
        invocation.outcome.denial.rule === "policy_required"
      )
        await this.#policy(id, parent);
      return;
    }
    const parsed = CreateRunCredentialResultSchema.safeParse(invocation.outcome.result);
    if (!parsed.success) throw new ActionRunnerError("invalid_response", invocation.traceId);
    const owned = this.#retain(parsed.data.run, parsed.data.credential.token);
    if (parent === undefined) {
      this.#root = owned;
      this.#admissionUncertain = false;
    }
    const expectedAgent =
      parent?.run.agentId ?? ("agentId" in this.#binding ? this.#binding.agentId : undefined);
    if (owned.run.agentId !== expectedAgent || owned.run.parentRunId !== (parent?.run.id ?? null))
      throw new ActionRunnerError("invalid_response", invocation.traceId);
    this.#result(id, owned, door, owned.run.target, invocation, { expiresAt: owned.run.expiresAt });
    await this.#policy(id, owned);
  }

  /** Only a trusted harness calls this API or writes the separate inherited activity pipe. */
  async reportActivity(input: unknown): Promise<void> {
    if (this.#closed || this.#root === null) throw new ActionRunnerError("invalid_state");
    const parsed = ActionRunnerActivitySchema.safeParse(input);
    if (!parsed.success) throw new ActionRunnerError("invalid_frame");
    this.#checkInput(parsed.data);
    if (++this.#activityFrames > ACTION_RUNNER_MAX_FRAMES)
      throw new ActionRunnerError("limit_exceeded");
    const run = this.#owned(parsed.data.runId);
    const invocation = await this.#call(run, LIFECYCLE.activity, parsed.data);
    this.#result(null, run, LIFECYCLE.activity, run.run.target, invocation);
  }

  /** Sequential frames only. A host must close on any thrown error (runActionStdio does). */
  async accept(input: unknown): Promise<void> {
    if (this.#closed) throw new ActionRunnerError("invalid_state");
    this.#attempt = null;
    const parsed = ActionRunnerRequestSchema.safeParse(input);
    if (!parsed.success) throw new ActionRunnerError("invalid_frame");
    const frame = parsed.data;
    this.#checkInput(frame);
    if (this.#ids.has(frame.id)) throw new ActionRunnerError("invalid_frame");
    if (this.#ids.size >= ACTION_RUNNER_MAX_FRAMES) throw new ActionRunnerError("limit_exceeded");
    this.#ids.add(frame.id);
    const run = this.#owned(frame.runId);
    switch (frame.type) {
      case "discover":
        await this.#discover(frame.id, run);
        return;
      case "policy":
        await this.#policy(frame.id, run);
        return;
      case "ack": {
        const challenge = run.policy;
        if (
          challenge === null ||
          frame.policy.revision !== challenge.revision ||
          frame.policy.acknowledgements.length !== challenge.required.length ||
          !challenge.required.every((bundle) =>
            frame.policy.acknowledgements.some(
              (ack) => ack.id === bundle.id && ack.digest === bundle.digest,
            ),
          )
        ) {
          throw new ActionRunnerError("policy_mismatch");
        }
        const invocation = await this.#call(run, LIFECYCLE.ack, frame.policy);
        this.#result(frame.id, run, LIFECYCLE.ack, run.run.target, invocation);
        if (invocation.outcome.ok) {
          const result = AcknowledgeAgentPolicyResultSchema.safeParse(invocation.outcome.result);
          if (
            !result.success ||
            result.data.run.id !== run.run.id ||
            result.data.run.state !== "active"
          )
            throw new ActionRunnerError("invalid_response", invocation.traceId);
          run.run = result.data.run;
          run.acknowledged = true;
        } else await this.#policy(frame.id, run);
        return;
      }
      case "child":
        await this.#create(frame.id, frame.declaration, run, frame.justification);
        return;
      case "renew": {
        if (!run.acknowledged) throw new ActionRunnerError("invalid_state");
        const parent = this.#sponsor(run);
        if (parent !== undefined && !parent.acknowledged)
          throw new ActionRunnerError("invalid_state");
        const invocation = await this.#call(
          parent,
          LIFECYCLE.renew,
          { runId: run.run.id, lifetimeMs: frame.lifetimeMs },
          frame.justification,
          run.run.target,
          run.run.id,
        );
        if (invocation.outcome.ok) {
          const result = RenewAgentRunResultSchema.safeParse(invocation.outcome.result);
          if (!result.success || result.data.run.id !== run.run.id)
            throw new ActionRunnerError("invalid_response", invocation.traceId);
          run.run = result.data.run;
          run.token = result.data.credential.token;
          this.#secrets.add(run.token);
          if (run === this.#root && "runId" in this.#binding) this.#launcherToken = run.token;
        }
        this.#result(frame.id, run, LIFECYCLE.renew, run.run.target, invocation, {
          expiresAt: run.run.expiresAt,
        });
        if (
          !invocation.outcome.ok &&
          (invocation.outcome.denial.rule === "policy_stale" ||
            invocation.outcome.denial.rule === "policy_required")
        )
          await this.#policy(frame.id, parent ?? run);
        return;
      }
      case "finish": {
        await this.#finish(frame.id, run, frame.outcome);
        if (run === this.#root) await this.close(frame.outcome);
        return;
      }
      case "invoke": {
        if (!run.acknowledged) throw new ActionRunnerError("invalid_state");
        this.#attempt = { door: frame.door, target: frame.target, runId: run.run.id };
        const contract = this.#readContracts.get(frame.door);
        const action = this.#protocol?.actions.find((action) => action.name === frame.door);
        if (action === undefined)
          throw new ActionRunnerError(
            contract === undefined ? "unknown_action" : "projection_unavailable",
          );
        if (
          action.runAccess !== undefined ||
          Object.values(LIFECYCLE).some((door) => door === frame.door)
        )
          throw new ActionRunnerError("invalid_state");
        if (typeof contract === "string") throw new ActionRunnerError(contract);
        // The discovered schema is delivered verbatim; the actual door remains its sole validator.
        const invocation = await this.#call(
          run,
          frame.door,
          frame.args,
          frame.justification,
          frame.target,
          run.run.id,
          contract?.digest,
        );
        this.#result(frame.id, run, frame.door, frame.target, invocation, {}, contract);
        if (
          !invocation.outcome.ok &&
          (invocation.outcome.denial.rule === "policy_stale" ||
            invocation.outcome.denial.rule === "policy_required")
        )
          await this.#policy(frame.id, run);
        return;
      }
      default: {
        const exhaustive: never = frame;
        throw new Error(String(exhaustive));
      }
    }
  }

  async #finish(id: string | null, run: OwnedRun, outcome: AgentRunTerminalOutcome): Promise<void> {
    const parent = this.#sponsor(run);
    const invocation = await this.#call(
      parent,
      LIFECYCLE.finish,
      { runId: run.run.id, outcome },
      undefined,
      run.run.target,
      run.run.id,
    );
    if (!invocation.outcome.ok) {
      this.#result(id, run, LIFECYCLE.finish, run.run.target, invocation);
      throw new ActionRunnerError("cleanup_failed", invocation.traceId);
    }
    const result = FinishAgentRunResultSchema.safeParse(invocation.outcome.result);
    if (
      !result.success ||
      result.data.run.id !== run.run.id ||
      result.data.run.state === "cleanup_failed" ||
      result.data.run.cleanup.finishedAt === undefined
    )
      throw new ActionRunnerError("cleanup_failed", invocation.traceId);
    run.run = result.data.run;
    for (const candidate of this.#runs.values()) {
      let ancestor: OwnedRun | undefined = candidate;
      while (ancestor !== undefined) {
        if (ancestor === run) {
          candidate.finished = true;
          candidate.token = "";
          break;
        }
        ancestor =
          ancestor.run.parentRunId === null ? undefined : this.#runs.get(ancestor.run.parentRunId);
      }
    }
    if (run === this.#root) this.#cleanupConfirmed = true;
    this.#result(id, run, LIFECYCLE.finish, run.run.target, invocation, {
      cleanup: {
        finishedRuns: result.data.finishedRuns,
        revokedCredentials: result.data.revokedCredentials,
        revokedGrants: result.data.revokedGrants,
      },
    });
  }

  /** Agent-mode teardown retains its runner credential even after the run bearer expires. */
  async close(outcome: AgentRunTerminalOutcome): Promise<boolean> {
    if (this.#closed)
      return this.#cleanupConfirmed || (this.#root === null && !this.#admissionUncertain);
    let failed = this.#root === null && this.#admissionUncertain;
    try {
      if (this.#root === null && "runId" in this.#binding) {
        // Adoption already knows the run handle, even when inspection loses its response.
        const invocation = await this.#call(
          undefined,
          LIFECYCLE.finish,
          { runId: this.#binding.runId, outcome },
          undefined,
          MANIFOLD_ROOT_URI,
          this.#binding.runId,
        );
        const result = invocation.outcome.ok
          ? FinishAgentRunResultSchema.safeParse(invocation.outcome.result)
          : null;
        if (
          result?.success !== true ||
          result.data.run.id !== this.#binding.runId ||
          result.data.run.state === "cleanup_failed" ||
          result.data.run.cleanup.finishedAt === undefined
        )
          throw new ActionRunnerError("cleanup_failed", invocation.traceId);
        this.#root = this.#retain(result.data.run, this.#launcherToken);
        this.#root.finished = true;
        this.#root.token = "";
        this.#cleanupConfirmed = true;
        failed = false;
        this.#result(null, this.#root, LIFECYCLE.finish, this.#root.run.target, invocation);
      }
      if (this.#root !== null && !this.#root.finished)
        await this.#finish(null, this.#root, outcome);
    } catch (error) {
      failed = true;
      this.report(error, "cleanup_failed");
    } finally {
      this.#closed = true;
      this.#terminalOutcome = failed ? "failed" : outcome;
      this.#send({
        type: "closed",
        outcome,
        cleanup: failed ? "failed" : this.#cleanupConfirmed ? "confirmed" : "not_started",
      });
      this.#launcherToken = "";
    }
    return !failed;
  }

  /** Error output is a closed code, never an exception message, input echo or server body. */
  report(error: unknown, fallback: RunnerErrorCode = "transport_failed"): void {
    this.#send({
      type: "error",
      id: null,
      door: this.#attempt?.door ?? null,
      target: this.#attempt?.target ?? null,
      runId: this.#attempt?.runId ?? null,
      code:
        error instanceof ActionRunnerError || error instanceof ActionProtocolError
          ? error.code
          : fallback,
      traceId:
        error instanceof ActionRunnerError || error instanceof ActionHttpError
          ? error.traceId
          : null,
    });
  }
}
