import { PrincipalSchema, type Principal } from "@manifold/protocol";
import { instanceOrigin } from "@manifold/plugin/instance";

/** The browser persists only the bearer and stable identity needed after admission. */
export interface StoredIdentity {
  readonly token: string;
  readonly principal: Principal;
  readonly expiresInMs?: number;
  readonly receivedAt?: number;
  readonly expiresAt?: number;
}

export const IDENTITY_STORAGE = "manifold.identity";

/** A credential belongs to its selected instance, not necessarily the serving origin. */
export function credentialKey(base: string, origin = instanceOrigin()): string {
  return origin === window.location.origin ? base : `${base}@${origin}`;
}

/** Shared by ordinary admission and the private document; never imports the app graph. */
export function loadIdentity(origin = instanceOrigin()): StoredIdentity | null {
  try {
    const serialized = window.localStorage.getItem(credentialKey(IDENTITY_STORAGE, origin));
    if (serialized === null) return null;
    const decoded: unknown = JSON.parse(serialized);
    if (decoded === null || typeof decoded !== "object") return null;
    const token = Reflect.get(decoded, "token");
    const expiresAt = Reflect.get(decoded, "expiresAt");
    const expiresInMs = Reflect.get(decoded, "expiresInMs");
    const receivedAt = Reflect.get(decoded, "receivedAt");
    const principal = PrincipalSchema.safeParse(Reflect.get(decoded, "principal"));
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) ||
      (expiresInMs !== undefined &&
        (typeof expiresInMs !== "number" || !Number.isFinite(expiresInMs))) ||
      (receivedAt !== undefined &&
        (typeof receivedAt !== "number" || !Number.isFinite(receivedAt))) ||
      (expiresInMs === undefined) !== (receivedAt === undefined) ||
      !principal.success
    ) {
      return null;
    }
    return {
      token,
      principal: principal.data,
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      ...(typeof expiresInMs === "number" ? { expiresInMs } : {}),
      ...(typeof receivedAt === "number" ? { receivedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Advisory local expiry only; authority is always rechecked by the selected hub. */
export function identityExpired(identity: StoredIdentity): boolean {
  return (
    identity.expiresInMs !== undefined &&
    identity.receivedAt !== undefined &&
    Date.now() - identity.receivedAt >= identity.expiresInMs
  );
}
