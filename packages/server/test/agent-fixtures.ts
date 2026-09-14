import {
  AGENT_RUN_MAX_DEPTH,
  AGENT_RUN_MAX_DESCENDANTS,
  AGENT_RUN_MAX_LIFETIME_MS,
  CreateRunCredentialResultSchema,
  type CreateRunRequest,
  type GrantReach,
} from "@manifold/protocol";
import type { AuthContext, AuthService } from "../src/auth.ts";

export interface ExternalRunFixtureInput extends Omit<CreateRunRequest, "agentId" | "delegation" | "target"> {
  name: string;
  purpose: string;
  target: string;
  reach: GrantReach;
  caps: NonNullable<CreateRunRequest["caps"]>;
  maxDepth?: number;
  maxDescendants?: number;
}

interface ExternalRunFixture {
  readonly auth: AuthService;
  readonly runtime: { now(): number };
  readonly owner: AuthContext;
}

/** Register a durable external Agent, then admit its run with the matching runner credential. */
export function createExternalRun(
  fixture: ExternalRunFixture,
  input: ExternalRunFixtureInput,
  sponsor: AuthContext = fixture.owner,
) {
  const { name, purpose, maxDepth, maxDescendants, ...narrowing } = input;
  const delegation = {
    maxDepth: maxDepth ?? AGENT_RUN_MAX_DEPTH,
    maxDescendants: maxDescendants ?? AGENT_RUN_MAX_DESCENDANTS,
  };
  const registered = fixture.auth.registerAgent({
    name,
    purpose,
    harness: "external",
    grant: {
      caps: input.caps,
      targets: [input.target],
      reach: input.reach,
      maxRunLifetimeMs: AGENT_RUN_MAX_LIFETIME_MS,
      delegation,
      expiresAt: Math.min(
        fixture.runtime.now() + AGENT_RUN_MAX_LIFETIME_MS,
        sponsor.expiresAt ?? Number.POSITIVE_INFINITY,
      ),
    },
    context: { profile: {} },
  }, sponsor);
  if (registered.credential === undefined) throw new Error("fixture Agent must be newly registered");
  const runner = fixture.auth.authenticate(registered.credential.token);
  return CreateRunCredentialResultSchema.parse(fixture.auth.createRun({
    ...narrowing,
    agentId: registered.agent.agentId,
    delegation,
  }, runner));
}
