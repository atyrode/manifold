import type { AuthoredCap, ManifoldRef } from "@manifold/protocol";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
} from "./auth.ts";

/** Hub-only admission evidence. Context requirements use the dispatch's admitted scope. */
export interface ActionAuthorityRequirement {
  readonly cap: AuthoredCap;
  readonly ref?: ManifoldRef;
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

  constructor(
    private readonly authService: AuthService,
    auth: AuthContext,
    private readonly isCurrent: () => boolean,
    private readonly contextScope: string | null,
  ) {
    const credential = authService.credentialReference(auth);
    this.credential = {
      ...credential,
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
    this.requirements = requirements.map(({ cap, ref }) => ({
      cap,
      ...(ref === undefined ? {} : { ref: { ...ref } }),
    }));
  }

  checkCurrent(): AuthContext {
    if (!this.open || this.requirements === null || !this.isCurrent())
      this.refuse("action authority unavailable");
    const current = this.authService.restoreCredential(this.credential);
    if (current === null) this.refuse("caller authority unavailable");
    const graded =
      this.contextScope === null ? current : { ...current, containerScope: this.contextScope };
    for (const { cap, ref } of this.requirements) {
      const held =
        cap === "*"
          ? this.authService.holdsRoot(current)
          : ref === undefined
            ? this.authService.allows(graded, cap)
            : this.authService.allowsRef(current, cap, ref);
      if (!held) this.refuse(`${cap} capability required`);
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
