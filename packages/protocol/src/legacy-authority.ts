import { z } from "zod";
import { CAPS, CapSchema, type AskableCap, type Cap, type AuthoredCap } from "./capabilities.ts";
import { PluginCapSchema } from "./plugin.ts";
import {
  canonicalizeAuthorityScope,
  scopeWithin,
  type AuthorityScope,
  type GrantReach,
} from "./grants.ts";
import {
  AgentRunCapSchema,
  type AgentRunCap,
  type Agent,
  type AgentAuthority,
  type AgentV2,
} from "./agents.ts";
import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunV2,
  AgentRunAuthorizationCredentialAuthority,
} from "./agent-runs.ts";
import type { Credential, CredentialV2 } from "./http.ts";
import { MANIFOLD_ROOT_URI, formatManifoldUri } from "./uri.ts";

/** Released V1 vocabulary is closed even when the engine adds ordinary capabilities. */
export const LegacyCapSchema = CapSchema.exclude(["machines:shell"]);
export type LegacyCap = z.infer<typeof LegacyCapSchema>;
export const LegacyAuthoredCapSchema = z.union([LegacyCapSchema, z.lazy(() => PluginCapSchema)]);
export type LegacyAuthoredCap = z.infer<typeof LegacyAuthoredCapSchema>;

/** Compatibility discovery hint only; never an authority reconstruction. */
export function projectLegacyCaps(caps: readonly Cap[]): LegacyCap[] {
  return caps.filter((cap): cap is LegacyCap => cap !== "machines:shell");
}

function supportedCaps(caps: readonly AuthoredCap[]): AgentRunCap[] {
  const supported: AgentRunCap[] = [];
  for (const cap of caps) {
    if (cap === "machines:shell") return refusesLegacy();
    const parsed = AgentRunCapSchema.safeParse(cap);
    if (!parsed.success) return refusesLegacy();
    supported.push(parsed.data);
  }
  return supported;
}

function supportedScope(scope: AuthorityScope): AuthorityScope {
  if (scope.some((entry) => entry.caps.includes("machines:shell"))) return refusesLegacy();
  return canonicalizeAuthorityScope(scope);
}

function refusesLegacy(): never {
  throw new Error("scoped_authority_requires_v2");
}

function equivalentScope(left: AuthorityScope, right: AuthorityScope): boolean {
  return scopeWithin(left, right) && scopeWithin(right, left);
}

function legacyRectangle(scope: AuthorityScope): {
  caps: AgentRunCap[];
  targets: string[];
  reach: GrantReach;
} {
  const supported = supportedScope(scope);
  const caps = supportedCaps([...new Set(supported.flatMap((entry) => entry.caps))].sort());
  if (caps.length === 0 || caps.length > 64) return refusesLegacy();
  for (const reach of ["node", "subtree"] as const) {
    const targets = [
      ...new Set(supported.filter((entry) => entry.reach === reach).map((entry) => entry.target)),
    ];
    const rectangle = targets.map((target) => ({ target, reach, caps }));
    if (equivalentScope(supported, rectangle)) return { caps, targets, reach };
  }
  return refusesLegacy();
}

function agentObservation(agent: AgentAuthority | AgentV2) {
  return {
    agentId: agent.agentId,
    principalId: agent.principalId,
    sponsorPrincipalId: agent.sponsorPrincipalId,
    name: agent.name,
    purpose: agent.purpose,
    harness: agent.harness,
    context: agent.context,
    policyRevisionAcknowledged: agent.policyRevisionAcknowledged,
    state: agent.state,
    activeRuns: agent.activeRuns,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export function projectAgentV2(agent: AgentAuthority): AgentV2 {
  const grant = agent.grant;
  const scope =
    grant.authorityScope === undefined
      ? canonicalizeAuthorityScope(
          grant.targets.map((target) => ({ target, reach: grant.reach, caps: grant.caps })),
        )
      : canonicalizeAuthorityScope(grant.authorityScope);
  return {
    ...agentObservation(agent),
    grant: {
      scope,
      tools: grant.tools,
      maxRunLifetimeMs: grant.maxRunLifetimeMs,
      delegation: grant.delegation,
      expiresAt: grant.expiresAt,
    },
  };
}

export function projectLegacyAgent(agent: AgentAuthority | AgentV2): Agent {
  const grant = agent.grant;
  const rectangle =
    "scope" in grant
      ? legacyRectangle(grant.scope)
      : grant.authorityScope === undefined
        ? { caps: supportedCaps(grant.caps), targets: grant.targets, reach: grant.reach }
        : legacyRectangle(grant.authorityScope);
  if (rectangle.caps.length === 0 || rectangle.caps.length > 64) return refusesLegacy();
  return {
    ...agentObservation(agent),
    grant: {
      caps: rectangle.caps,
      targets: rectangle.targets,
      reach: rectangle.reach,
      tools: grant.tools,
      maxRunLifetimeMs: grant.maxRunLifetimeMs,
      delegation: grant.delegation,
      expiresAt: grant.expiresAt,
    },
  };
}

function runObservation(run: AgentRunAuthority | AgentRunV2) {
  return {
    id: run.id,
    agentId: run.agentId,
    session: run.session,
    model: run.model,
    activity: run.activity,
    principal: run.principal,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    authorizedByPrincipalId: run.authorizedByPrincipalId,
    authorizationPath: run.authorizationPath,
    purpose: run.purpose,
    taskRef: run.taskRef,
    target: run.target,
    reach: run.reach,
    tools: run.tools,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
    renewals: run.renewals,
    maxDepth: run.maxDepth,
    maxDescendants: run.maxDescendants,
    depth: run.depth,
    cleanupOwnerPrincipalId: run.cleanupOwnerPrincipalId,
    state: run.state,
    policyRevision: run.policyRevision,
    acknowledgedPolicyRevision: run.acknowledgedPolicyRevision,
    cleanup: run.cleanup,
  };
}

function credentialObservation(credential: AgentRunAuthorizationCredentialAuthority) {
  return {
    tokenId: credential.tokenId,
    grantId: credential.grantId,
    caps: credential.caps,
    containerScope: credential.containerScope,
    expiresAt: credential.expiresAt,
  };
}

export function projectRunV2(run: AgentRunAuthority): AgentRunV2 {
  return {
    ...runObservation(run),
    caps: run.caps,
    scope:
      run.authorityScope === undefined
        ? canonicalizeAuthorityScope([{ target: run.target, reach: run.reach, caps: run.caps }])
        : canonicalizeAuthorityScope(run.authorityScope),
    authorizationCredential: {
      ...credentialObservation(run.authorizationCredential),
      authorityScope:
        run.authorizationCredential.authorityScope === undefined
          ? undefined
          : canonicalizeAuthorityScope(run.authorizationCredential.authorityScope),
    },
  };
}

export function projectLegacyRun(run: AgentRunAuthority | AgentRunV2): AgentRun {
  const scope = "scope" in run ? run.scope : run.authorityScope;
  const supported = scope === undefined ? undefined : supportedScope(scope);
  const caps =
    supported === undefined
      ? supportedCaps(run.caps)
      : [...new Set(supported.flatMap((entry) => supportedCaps(entry.caps)))].sort();
  if (caps.length === 0 || caps.length > 64) return refusesLegacy();
  if (
    supported !== undefined &&
    !equivalentScope(supported, [
      { target: run.target, reach: run.reach, caps: caps as AskableCap[] },
    ])
  ) {
    return refusesLegacy();
  }
  const credential = run.authorizationCredential;
  if (credential.caps.includes("machines:shell")) return refusesLegacy();
  const credentialCaps = projectLegacyCaps(credential.caps);
  if (credential.authorityScope !== undefined) {
    const target =
      credential.containerScope === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId: credential.containerScope });
    const expandedCaps = credentialCaps.includes("*")
      ? CAPS.filter(
          (cap): cap is Exclude<LegacyCap, "*"> => cap !== "*" && cap !== "machines:shell",
        )
      : (credentialCaps as AskableCap[]);
    const rectangle: AuthorityScope =
      expandedCaps.length === 0 ? [] : [{ target, reach: "subtree", caps: expandedCaps }];
    if (!equivalentScope(supportedScope(credential.authorityScope), rectangle))
      return refusesLegacy();
  }
  return {
    ...runObservation(run),
    caps,
    authorizationCredential: {
      tokenId: credential.tokenId,
      grantId: credential.grantId,
      caps: credentialCaps,
      containerScope: credential.containerScope,
      expiresAt: credential.expiresAt,
    },
  };
}

/** A V1 inventory row is truthful only if its flat caps describe the entire anchored ceiling. */
export function projectLegacyCredential(credential: CredentialV2): Credential {
  if (credential.caps.includes("machines:shell")) return refusesLegacy();
  const caps = projectLegacyCaps(credential.caps);
  if (credential.authorityScope !== undefined) {
    const target =
      credential.containerId === undefined
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId: credential.containerId });
    const expandedCaps = caps.includes("*")
      ? CAPS.filter(
          (cap): cap is Exclude<LegacyCap, "*"> => cap !== "*" && cap !== "machines:shell",
        )
      : (caps as AskableCap[]);
    const rectangle: AuthorityScope =
      expandedCaps.length === 0 ? [] : [{ target, reach: "subtree", caps: expandedCaps }];
    if (!equivalentScope(supportedScope(credential.authorityScope), rectangle))
      return refusesLegacy();
  }
  return {
    id: credential.id,
    createdAt: credential.createdAt,
    mintedBy: credential.mintedBy,
    containerId: credential.containerId,
    caps,
    expiresAt: credential.expiresAt,
  };
}
