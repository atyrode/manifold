import { z } from "zod";
import {
  AuthorityScopeSchema,
  AskableCapSchema,
  AuthoredCapSchema,
  CapSchema,
  GrantNodeSchema,
  GrantReachSchema,
  ManifoldRefSchema,
  JobInputBindingSchema,
  GOVERNED_CAPS,
  isEngineCap,
  parseManifoldUri,
  projectLegacyCaps,
  type PreparedRequirement,
  type JobRequest,
  type JobInputBinding,
} from "@manifold/protocol";
import {
  ContainerGrantsSchema,
  type AuthContext,
  type AuthService,
  type CredentialReference,
  type AuthorityRequirement,
} from "./auth.ts";
import type { ActionAuthoritySnapshotBinding } from "./action-authority-fence.ts";
import type { ServerStore } from "./stores.ts";

/** Nonsecret facts captured by the hub's native resolver, never an owner-wire credential. */
export interface NativeDemandBinding {
  readonly machineId: string;
  readonly containerId: string;
  readonly pluginId: string;
  readonly operationId: string;
  readonly installationRevision: string;
  readonly artifactSha256: string;
  readonly resourceBindingDigest: string;
  readonly runtimeDigest: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly terminalHostId: string;
  readonly inputs?: readonly JobInputBinding[] | undefined;
  readonly requirements: readonly PreparedRequirement[];
}

/** Hub-only delayed authority. It is never spread into a signed request or public DTO. */
export interface AuthoritySnapshot {
  readonly credential: CredentialReference;
  readonly actionCredential?: CredentialReference;
  readonly action?: ActionAuthoritySnapshotBinding;
  readonly native?: NativeDemandBinding;
  readonly terminal?: JobRequest["terminal"];
}

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const preparedRequirement = z.strictObject({
  cap: AskableCapSchema,
  node: GrantNodeSchema,
  reach: GrantReachSchema,
});
export const CredentialReferenceSchema = z.strictObject({
  principalId: id,
  tokenId: id.nullable(),
  grantId: id.nullable(),
  caps: z.array(CapSchema).max(128),
  containerScope: id.nullable(),
  expiresAt: z.number().int().nonnegative().optional(),
  containerGrants: z.lazy(() => ContainerGrantsSchema).optional(),
  authorityScope: AuthorityScopeSchema.optional(),
});
export const AuthoritySnapshotSchema = z.strictObject({
  credential: CredentialReferenceSchema,
  actionCredential: CredentialReferenceSchema.optional(),
  action: z
    .strictObject({
      requirements: z
        .array(
          z.strictObject({
            cap: AuthoredCapSchema,
            ref: ManifoldRefSchema.optional(),
            node: GrantNodeSchema.optional(),
            reach: GrantReachSchema.optional(),
          }),
        )
        .max(256),
      contextScope: id.nullable(),
      fingerprint: z.string().min(1).max(4096).optional(),
      originalArgsDigest: hash.optional(),
      actionName: id.optional(),
      pluginId: id.optional(),
      machineId: id.optional(),
      containerId: id.optional(),
      nativeDemand: z.unknown().optional(),
    })
    .optional(),
  native: z
    .strictObject({
      machineId: id,
      containerId: id,
      pluginId: id,
      operationId: id,
      installationRevision: id,
      artifactSha256: hash,
      resourceBindingDigest: hash,
      runtimeDigest: hash,
      ownerId: id,
      ownerGeneration: z.number().int().nonnegative(),
      terminalHostId: id,
      inputs: z.array(JobInputBindingSchema).max(16).optional(),
      requirements: z.array(preparedRequirement).max(256),
    })
    .optional(),
  terminal: z
    .strictObject({
      terminalId: id,
      terminalHostId: id,
      containerId: id,
      runId: id.optional(),
    })
    .optional(),
});

/** Keep schema-accepted optional undefined values absent in the durable authority contract. */
export function normalizeAuthoritySnapshot(
  snapshot: z.output<typeof AuthoritySnapshotSchema>,
): AuthoritySnapshot {
  const { credential, actionCredential, action, native, terminal } = snapshot;
  return {
    credential,
    ...(actionCredential === undefined ? {} : { actionCredential }),
    ...(action === undefined
      ? {}
      : {
          action: {
            contextScope: action.contextScope,
            requirements: action.requirements.map(({ cap, ref, node, reach }) => ({
              cap,
              ...(ref === undefined ? {} : { ref }),
              ...(node === undefined ? {} : { node }),
              ...(reach === undefined ? {} : { reach }),
            })),
            ...(action.fingerprint === undefined ? {} : { fingerprint: action.fingerprint }),
            ...(action.originalArgsDigest === undefined
              ? {}
              : { originalArgsDigest: action.originalArgsDigest }),
            ...(action.actionName === undefined ? {} : { actionName: action.actionName }),
            ...(action.pluginId === undefined ? {} : { pluginId: action.pluginId }),
            ...(action.machineId === undefined ? {} : { machineId: action.machineId }),
            ...(action.containerId === undefined ? {} : { containerId: action.containerId }),
            ...(action.nativeDemand === undefined ? {} : { nativeDemand: action.nativeDemand }),
          },
        }),
    ...(native === undefined
      ? {}
      : {
          native: (() => {
            const { inputs, ...binding } = native;
            return { ...binding, ...(inputs === undefined ? {} : { inputs }) };
          })(),
        }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

export function cloneAuthoritySnapshot(snapshot: AuthoritySnapshot): AuthoritySnapshot {
  return normalizeAuthoritySnapshot(AuthoritySnapshotSchema.parse(structuredClone(snapshot)));
}

export function captureAuthoritySnapshot(
  auth: AuthService,
  context: AuthContext,
  bindings: Omit<AuthoritySnapshot, "credential"> = {},
): AuthoritySnapshot {
  return cloneAuthoritySnapshot({ credential: auth.credentialReference(context), ...bindings });
}

/** Deliberate compatibility projection: it is for the closed native wire, never for restore. */
export function projectJobCredential(reference: CredentialReference): JobRequest["credential"] {
  return {
    principalId: reference.principalId,
    tokenId: reference.tokenId,
    grantId: reference.grantId,
    caps: projectLegacyCaps(reference.caps),
    containerScope: reference.containerScope,
    ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
  };
}

export function restoreAuthoritySnapshot(
  auth: AuthService,
  snapshot: AuthoritySnapshot,
  actionCurrent?: (binding: ActionAuthoritySnapshotBinding) => boolean,
  nativeCurrent?: (current: AuthContext, requirements: readonly AuthorityRequirement[]) => boolean,
): AuthContext | null {
  const current = auth.restoreCredential(snapshot.credential);
  if (current === null) return null;
  const nativeRequirements: AuthorityRequirement[] = [];
  const binding = snapshot.action;
  if (binding !== undefined) {
    if (binding.fingerprint !== undefined && actionCurrent?.(binding) !== true) return null;
    const actionContext =
      snapshot.actionCredential === undefined
        ? current
        : auth.restoreCredential(snapshot.actionCredential);
    if (actionContext === null) return null;
    const graded =
      binding.contextScope === null
        ? actionContext
        : { ...actionContext, containerScope: binding.contextScope };
    for (const requirement of binding.requirements) {
      const allowed =
        requirement.cap === "*"
          ? auth.holdsRoot(actionContext)
          : requirement.node !== undefined
            ? auth.allowsNode(
                actionContext,
                requirement.cap,
                requirement.node,
                requirement.reach ?? "node",
              )
            : requirement.ref !== undefined
              ? auth.allowsRef(actionContext, requirement.cap, requirement.ref)
              : auth.allows(graded, requirement.cap);
      if (!allowed) return null;
      if (requirement.cap !== "*" && GOVERNED_CAPS.includes(requirement.cap)) {
        const ref =
          requirement.ref ??
          (requirement.node === undefined ? null : parseManifoldUri(requirement.node));
        if (ref === null || !isEngineCap(requirement.cap)) return null;
        nativeRequirements.push({ cap: requirement.cap, ref });
      }
    }
    if (
      nativeRequirements.length > 0 &&
      nativeCurrent?.(actionContext, nativeRequirements) !== true
    )
      return null;
  }
  nativeRequirements.length = 0;
  for (const { cap, node, reach } of snapshot.native?.requirements ?? []) {
    if (!auth.allowsNode(current, cap, node, reach)) return null;
    if (GOVERNED_CAPS.includes(cap)) {
      const ref = parseManifoldUri(node);
      if (ref === null || !isEngineCap(cap)) return null;
      nativeRequirements.push({ cap, ref });
    }
  }
  // A capability grant is not native consent. Keep both captured credential walks
  // conjunctive, while ordinary scene/container/terminal rights remain caller-only.
  if (nativeRequirements.length > 0 && nativeCurrent?.(current, nativeRequirements) !== true)
    return null;
  return current;
}

/** Companion hub table leaves released signed requests and snapshot-less records untouched. */
export function initializeAuthoritySnapshots(store: ServerStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS native_authority_snapshots (
    kind TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(kind,id)
  )`);
}

export function storeAuthoritySnapshot(
  store: ServerStore,
  kind: "job" | "input" | "invocation",
  id: string,
  snapshot: AuthoritySnapshot | undefined,
): void {
  if (snapshot === undefined) return;
  store.db
    .query("INSERT INTO native_authority_snapshots(kind,id,snapshot) VALUES(?,?,?)")
    .run(kind, id, JSON.stringify(cloneAuthoritySnapshot(snapshot)));
}

export function readAuthoritySnapshot(
  store: ServerStore,
  kind: "job" | "input" | "invocation",
  id: string,
): AuthoritySnapshot | undefined {
  const row = store.db
    .query<{ snapshot: string }, [string, string]>(
      "SELECT snapshot FROM native_authority_snapshots WHERE kind=? AND id=?",
    )
    .get(kind, id);
  return row === null
    ? undefined
    : normalizeAuthoritySnapshot(AuthoritySnapshotSchema.parse(JSON.parse(row.snapshot)));
}
