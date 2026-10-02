import type { AuthoredCap, GrantNode, GrantReach, ManifoldRef } from "@manifold/protocol";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
} from "./auth.ts";
import { requireActionEffects } from "./action-preparation-phase.ts";

/** The admitted retained owner, not its replaceable transport. Hub-private evidence only. */
export interface TerminalOwnerBinding {
  readonly machineId: string;
  readonly terminalHostId: string | null;
}

/** Hub-only admission evidence. Context requirements use the dispatch's admitted scope. */
export interface ActionAuthorityRequirement {
  readonly cap: AuthoredCap;
  readonly ref?: ManifoldRef;
  readonly node?: GrantNode;
  readonly reach?: GrantReach;
}

/** Exact server harness dependency; native artifact identity cannot stand in for this. */
export interface HarnessAuthoritySnapshotBinding {
  readonly pluginId: string;
  readonly harnessId: string;
  readonly fingerprint: string;
  readonly caps: readonly AuthoredCap[];
}

/** Serializable, hub-only effect evidence. Never put this on an owner or terminal frame. */
export interface ActionAuthoritySnapshotBinding {
  readonly requirements: readonly ActionAuthorityRequirement[];
  readonly contextScope: string | null;
  readonly actionName?: string;
  readonly fingerprint?: string;
  readonly originalArgsDigest?: string;
  readonly machineId?: string;
  readonly containerId?: string;
  readonly terminalOwners?: readonly TerminalOwnerBinding[];
  readonly harnesses?: readonly HarnessAuthoritySnapshotBinding[];
  readonly nativeDemand?: unknown;
}

/**
 * One dispatch's original credential and ordered admission requirements, never the native
 * bridge's attenuated hints. Every data use restores and evaluates them through AuthService.
 * Preparation has no data authority; settlement or any observed withdrawal retires it forever.
 */
export class ActionAuthorityFence {
  private readonly credential: CredentialReference;
  private requirements: readonly ActionAuthorityRequirement[] | null = null;
  private open = true;
  private binding: Omit<ActionAuthoritySnapshotBinding, "requirements" | "contextScope"> = {};
  private checks: readonly {
    readonly check: () => void;
    readonly admissionOnly: boolean;
    active: boolean;
  }[] = [];
  // A broker may retain its pending fence before entering a harness. Dependencies
  // discovered there stay conjunctive for every already-retained continuation.
  private harnessDependencies: {
    entries: readonly {
      readonly binding: HarnessAuthoritySnapshotBinding;
      readonly check: () => void;
    }[];
  } = { entries: [] };

  constructor(
    private readonly authService: AuthService,
    auth: AuthContext,
    private readonly isCurrent: () => boolean,
    private readonly contextScope: string | null,
    private readonly checkAuthority?: (current: AuthContext) => void,
    private readonly admitAdditional?: (
      current: AuthContext,
      requirements: readonly ActionAuthorityRequirement[],
    ) => void,
  ) {
    const credential = authService.credentialReference(auth);
    this.credential = {
      ...credential,
      ...(credential.authorityScope === undefined
        ? {}
        : {
            authorityScope: credential.authorityScope.map(({ target, reach, caps }) => ({
              target,
              reach,
              caps: [...caps],
            })),
          }),
      ...(credential.containerGrants === undefined
        ? {}
        : {
            containerGrants: credential.containerGrants.map((grant) => ({
              containerId: grant.containerId,
              caps: [...grant.caps],
            })),
          }),
    };
  }

  admit(requirements: readonly ActionAuthorityRequirement[]): void {
    if (this.requirements !== null) this.refuse("action already admitted");
    this.requirements = requirements.map(({ cap, ref, node, reach }) => ({
      cap,
      ...(ref === undefined ? {} : { ref: { ...ref } }),
      ...(node === undefined ? {} : { node }),
      ...(reach === undefined ? {} : { reach }),
    }));
  }

  bind(binding: Omit<ActionAuthoritySnapshotBinding, "requirements" | "contextScope">): void {
    if (!this.open) this.refuse("action authority unavailable");
    this.binding = structuredClone(binding);
  }

  /** A pending effect owns its lease independently of the dispatch which prepared it. */
  retain(): ActionAuthorityFence {
    const current = this.checkCurrent();
    const retained = new ActionAuthorityFence(
      this.authService,
      current,
      this.isCurrent,
      this.contextScope,
      this.checkAuthority,
      this.admitAdditional,
    );
    retained.admit(this.requirements!);
    retained.bind(this.binding);
    retained.checks = this.checks;
    retained.harnessDependencies = this.harnessDependencies;
    return retained;
  }

  guard(check: () => void, lifetime: "continuation" | "admission" = "continuation"): void {
    this.checks = [
      ...this.checks,
      { check, admissionOnly: lifetime === "admission", active: true },
    ];
    this.checkCurrent();
  }

  dependOnHarness(binding: HarnessAuthoritySnapshotBinding, check: () => void): void {
    this.checkCurrent();
    if (this.harnessDependencies.entries.length >= 64)
      this.refuse("harness dependency capacity exceeded");
    this.harnessDependencies.entries = [
      ...this.harnessDependencies.entries,
      { binding: structuredClone(binding), check },
    ];
    this.checkCurrent();
  }

  /** A committed effect retires only admission guards, including in its retained leases. */
  commit(): void {
    for (const guard of this.checks) if (guard.admissionOnly) guard.active = false;
  }

  extend(requirements: readonly ActionAuthorityRequirement[]): void {
    this.checkCurrent();
    this.requirements = [
      ...this.requirements!,
      ...requirements.map((value) => structuredClone(value)),
    ];
    this.checkCurrent();
  }

  /** Fresh host-resolved demand remains conjunctive and inside the sealed preparer ceiling. */
  extendPrepared(requirements: readonly ActionAuthorityRequirement[]): void {
    const current = this.checkCurrent();
    if (this.admitAdditional === undefined) this.refuse("action preparation unavailable");
    const additions = requirements.map((value) => structuredClone(value));
    try {
      this.admitAdditional(current, additions);
      this.requirements = [...this.requirements!, ...additions];
      this.checkCurrent();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  snapshot(): ActionAuthoritySnapshotBinding {
    if (this.requirements === null) this.refuse("action not admitted");
    return structuredClone({
      ...this.binding,
      ...(this.harnessDependencies.entries.length === 0
        ? {}
        : { harnesses: this.harnessDependencies.entries.map(({ binding }) => binding) }),
      requirements: this.requirements,
      contextScope: this.contextScope,
    });
  }

  credentialReference(): CredentialReference {
    return structuredClone(this.credential);
  }

  checkCurrent(): AuthContext {
    requireActionEffects();
    if (!this.open || this.requirements === null || !this.isCurrent())
      this.refuse("action authority unavailable");
    const current = this.authService.restoreCredential(this.credential);
    if (current === null) this.refuse("caller authority unavailable");
    const graded =
      this.contextScope === null ? current : { ...current, containerScope: this.contextScope };
    for (const { cap, ref, node, reach } of this.requirements) {
      const held =
        cap === "*"
          ? this.authService.holdsRoot(current)
          : node !== undefined
            ? this.authService.allowsNode(current, cap, node, reach ?? "node")
            : ref === undefined
              ? this.authService.allows(graded, cap)
              : this.authService.allowsRef(current, cap, ref);
      if (!held) this.refuse(`${cap} capability required`);
    }
    try {
      this.checkAuthority?.(current);
      for (const guard of this.checks) if (guard.active) guard.check();
      for (const dependency of this.harnessDependencies.entries) dependency.check();
    } catch (error) {
      this.close();
      throw error;
    }
    return current;
  }

  close(): void {
    this.open = false;
  }

  private refuse(message: string): never {
    this.close();
    throw new ServiceError("forbidden", message);
  }
}
