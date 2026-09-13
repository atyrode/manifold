import {
  ACTION_RUNNER_MAX_FRAMES,
  AcknowledgeAgentPolicyResultSchema,
  ActionRunnerRequestSchema,
  ActionRunnerResponseSchema,
  AgentPolicyChallengeSchema,
  CreateAgentRunResultSchema,
  FinishAgentRunResultSchema,
  MANIFOLD_ROOT_URI,
  RenewAgentRunResultSchema,
  type ActionProtocol,
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
  run: AgentRun;
  token: string;
  policy: AgentPolicyChallenge | null;
  acknowledged: boolean;
  finished: boolean;
}

const LIFECYCLE = {
  create: "core.access.createAgentRun",
  policy: "core.access.getAgentPolicy",
  ack: "core.access.acknowledgeAgentPolicy",
  renew: "core.access.renewAgentRun",
  finish: "core.access.finishAgentRun",
} as const;

/** The sole sequence executor. No bearer-bearing value is returned by its public methods. */
export class ActionRunner {
  readonly #origin: string;
  readonly #sponsorToken: string;
  readonly #emit: (frame: ActionRunnerResponse) => void;
  readonly #runs = new Map<string, OwnedRun>();
  readonly #ids = new Set<string>();
  readonly #secrets = new Set<string>();
  #protocol: ActionProtocol | null = null;
  #root: OwnedRun | null = null;
  #admissionUncertain = false;
  #closed = false;
  #cleanupConfirmed = false;
  #terminalOutcome: AgentRunTerminalOutcome | null = null;
  #attempt: { door: string; target: string; runId: string | null } | null = null;

  constructor(options: {
    origin: string;
    sponsorToken: string;
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
      !/^[a-f0-9]{64}$/i.test(options.sponsorToken)
    )
      throw new ActionRunnerError("credential_input");
    this.#origin = url.origin;
    this.#sponsorToken = options.sponsorToken;
    this.#secrets.add(options.sponsorToken);
    this.#emit = options.emit;
  }

  get closed(): boolean {
    return this.#closed;
  }
  get successful(): boolean {
    return this.#closed && this.#cleanupConfirmed && this.#terminalOutcome === "completed";
  }

  /** Reject secret carriers recursively, including inside opaque action arguments. */
  #checkInput(value: unknown, depth = 0): void {
    if (depth > 32) throw new ActionRunnerError("limit_exceeded");
    if (typeof value === "string") {
      for (const secret of this.#secrets) {
        if (value.includes(secret)) throw new ActionRunnerError("credential_input");
      }
      if (/(?:bearer\s|#key=)/i.test(value)) {
        throw new ActionRunnerError("credential_input");
      }
    } else if (Array.isArray(value)) {
      for (const item of value) this.#checkInput(item, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          /^(?:token|bearer|password|secret|credentials?|authorization|cookies?|privatekey|ownerkey|apikey|accesstoken|refreshtoken|sponsortoken)$/i.test(
            key.replace(/[_-]/g, ""),
          )
        ) {
          throw new ActionRunnerError("credential_input");
        }
        this.#checkInput(child, depth + 1);
      }
    }
  }

  #send(frame: ActionRunnerResponse): void {
    const parsed = ActionRunnerResponseSchema.safeParse(frame);
    if (!parsed.success) throw new ActionRunnerError("invalid_response");
    const encoded = JSON.stringify(parsed.data);
    // Do not redact policy bytes: fail closed rather than deliver a different challenge.
    for (const secret of this.#secrets) {
      if (encoded.includes(secret)) throw new ActionRunnerError("invalid_response");
    }
    this.#emit(parsed.data);
  }

  #options(run?: OwnedRun): ActionHttpOptions {
    return {
      origin: this.#origin,
      token: run?.token ?? this.#sponsorToken,
      timeoutMs: 30_000,
      maxResponseBytes: 16 * 1_048_576,
    };
  }

  #owned(runId: string): OwnedRun {
    const run = this.#runs.get(runId);
    if (run === undefined || run.finished) throw new ActionRunnerError("invalid_state");
    return run;
  }

  #sponsor(run: OwnedRun): OwnedRun | undefined {
    // The owned root may itself be a server child of an external accountable launcher.
    if (run === this.#root) return undefined;
    if (run.run.parentRunId === null) throw new ActionRunnerError("invalid_state");
    return this.#owned(run.run.parentRunId);
  }

  async #discover(id: string, run?: OwnedRun): Promise<ActionProtocol> {
    this.#protocol = await discoverActions(this.#options(run));
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
  ): Promise<ActionInvocation> {
    this.#attempt = { door, target, runId: attemptRunId };
    if (this.#protocol === null || !this.#protocol.actions.some((action) => action.name === door)) {
      throw new ActionRunnerError("unknown_action");
    }
    return invokeAction(
      this.#options(run),
      door,
      args,
      justification === undefined ? {} : { agentJustification: justification },
    );
  }

  #result(
    id: string | null,
    run: OwnedRun | null,
    door: string,
    target: string,
    invocation: ActionInvocation,
    extra: Pick<Extract<ActionRunnerResponse, { type: "result" }>, "expiresAt" | "cleanup"> = {},
  ): void {
    if (
      invocation.traceId === null &&
      (invocation.outcome.ok || invocation.outcome.denial.rule !== "unknown_action")
    ) {
      throw new ActionRunnerError("missing_trace");
    }
    // The action result and free-form refusal message can contain output or arguments.
    // Only the mechanical outcome crosses stdio; the shared SDK retains the complete outcome.
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
    });
  }

  async #policy(id: string, run: OwnedRun): Promise<void> {
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

  async #create(
    frame: Extract<ActionRunnerRequest, { type: "start" | "child" }>,
    parent?: OwnedRun,
  ): Promise<void> {
    if (parent !== undefined && !parent.acknowledged) throw new ActionRunnerError("invalid_state");
    this.#admissionUncertain = parent === undefined;
    const invocation = await this.#call(
      parent,
      LIFECYCLE.create,
      frame.declaration,
      frame.justification,
      frame.declaration.target,
    );
    if (!invocation.outcome.ok) {
      this.#admissionUncertain = false;
      this.#result(
        frame.id,
        parent ?? null,
        LIFECYCLE.create,
        frame.declaration.target,
        invocation,
      );
      if (parent === undefined) await this.close("failed");
      else if (
        invocation.outcome.denial.rule === "policy_stale" ||
        invocation.outcome.denial.rule === "policy_required"
      )
        await this.#policy(frame.id, parent);
      return;
    }
    const parsed = CreateAgentRunResultSchema.safeParse(invocation.outcome.result);
    if (!parsed.success) throw new ActionRunnerError("invalid_response", invocation.traceId);
    const owned: OwnedRun = {
      run: parsed.data.run,
      token: parsed.data.credential.token,
      policy: null,
      acknowledged: false,
      finished: false,
    };
    this.#secrets.add(owned.token);
    this.#runs.set(owned.run.id, owned);
    if (parent === undefined) {
      this.#root = owned;
      this.#admissionUncertain = false;
    }
    this.#result(frame.id, owned, LIFECYCLE.create, owned.run.target, invocation, {
      expiresAt: owned.run.expiresAt,
    });
    await this.#policy(frame.id, owned);
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
    if (frame.type === "start") {
      if (this.#root !== null || this.#protocol !== null)
        throw new ActionRunnerError("invalid_state");
      const protocol = await this.#discover(frame.id);
      for (const door of Object.values(LIFECYCLE)) {
        if (!protocol.actions.some((action) => action.name === door))
          throw new ActionRunnerError("unknown_action");
      }
      await this.#create(frame);
      return;
    }
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
        await this.#create(frame, run);
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
        const action = this.#protocol?.actions.find((action) => action.name === frame.door);
        if (action === undefined) throw new ActionRunnerError("unknown_action");
        if (
          action.runAccess !== undefined ||
          Object.values(LIFECYCLE).some((door) => door === frame.door)
        )
          throw new ActionRunnerError("invalid_state");
        // The discovered schema is delivered verbatim; the actual door remains its sole validator.
        const invocation = await this.#call(
          run,
          frame.door,
          frame.args,
          frame.justification,
          frame.target,
        );
        this.#result(frame.id, run, frame.door, frame.target, invocation);
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

  /** Teardown uses the retained direct sponsor, including when the run bearer has expired. */
  async close(outcome: AgentRunTerminalOutcome): Promise<boolean> {
    if (this.#closed)
      return this.#cleanupConfirmed || (this.#root === null && !this.#admissionUncertain);
    let failed = this.#admissionUncertain;
    try {
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
