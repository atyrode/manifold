import type {
  Agent,
  AgentRun,
  HarnessTarget,
  SessionRef,
  TerminalRuntime,
} from "@manifold/protocol";
import type { z } from "zod";

/** A harness prepares descriptors; native terminal admission alone authorizes execution. */
export interface ServerHarness<Ctx> {
  readonly profileSchema: z.ZodType;
  launch(
    ctx: Ctx,
    run: AgentRun,
    agent: Agent,
    target: HarnessTarget,
  ): Promise<{
    runtime: TerminalRuntime;
    session: SessionRef;
    reviewDigest: string;
  }>;
  sessions(ctx: Ctx, target: HarnessTarget): Promise<SessionRef[]>;
  resolveSession(ctx: Ctx, ref: SessionRef): Promise<SessionRef | null>;
  send(ctx: Ctx, run: AgentRun, input: string): Promise<void>;
}

export type {
  Agent,
  AgentRun,
  HarnessTarget,
  SessionRef,
  TerminalRuntime,
} from "@manifold/protocol";
