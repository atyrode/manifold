import type {
  Agent,
  AgentRun,
  HarnessTarget,
  RunModel,
  SessionRef,
  TerminalRuntime,
} from "@manifold/protocol";
import type { z } from "zod";

/** A harness prepares descriptors; native terminal admission alone authorizes execution. */
export interface ServerHarness<Ctx, Run = AgentRun, StandingAgent = Agent> {
  readonly profileSchema: z.ZodType;
  launch(
    ctx: Ctx,
    run: Run,
    agent: StandingAgent,
    target: HarnessTarget,
  ): Promise<{
    runtime: TerminalRuntime;
    session: SessionRef;
    reviewDigest: string;
  }>;
  sessions(ctx: Ctx, target: HarnessTarget): Promise<SessionRef[]>;
  resolveSession(ctx: Ctx, ref: SessionRef): Promise<SessionRef | null>;
  send(ctx: Ctx, run: Run, input: string): Promise<void>;
  /**
   * Answer the exact model when this Run's reviewed launch may use it, otherwise `null`. It
   * must be deterministic and read-only, and refuse every model it does not know. Without it,
   * the host refuses every model the Run's harness reports.
   */
  resolveModel?(ctx: Ctx, run: Run, model: RunModel): Promise<RunModel | null>;
}

export type {
  Agent,
  AgentRun,
  HarnessTarget,
  RunModel,
  SessionRef,
  TerminalRuntime,
} from "@manifold/protocol";
