import { PrincipalSchema } from "@manifold/protocol";
import { useState, type FormEvent, type ReactNode } from "react";
import { createPrincipal, type StoredIdentity } from "./api.ts";

const OWNER_KEY_STORAGE = "manifold.ownerKey";
const IDENTITY_STORAGE = "manifold.identity";
const OWNER_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const OWNER_FRAGMENT_PATTERN = /^#key=([0-9a-f]{64})$/i;

/** The one color scheme: principals pick from it, machine dots hash into it. */
export const IDENTITY_COLORS = [
  "#e03131",
  "#f08c00",
  "#2f9e44",
  "#1971c2",
  "#6741d9",
  "#c2255c",
  "#0c8599",
  "#495057",
] as const;

/** Captures the one permitted URL-secret carrier before React renders, then cleans the URL. */
export function captureOwnerKeyFromFragment(): void {
  const match = OWNER_FRAGMENT_PATTERN.exec(window.location.hash);
  const ownerKey = match?.[1];
  if (ownerKey === undefined) return;
  window.localStorage.setItem(OWNER_KEY_STORAGE, ownerKey);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function loadOwnerKey(): string | null {
  const ownerKey = window.localStorage.getItem(OWNER_KEY_STORAGE);
  if (ownerKey !== null && OWNER_KEY_PATTERN.test(ownerKey)) return ownerKey;
  if (ownerKey !== null) window.localStorage.removeItem(OWNER_KEY_STORAGE);
  return null;
}

function loadIdentity(): StoredIdentity | null {
  const serialized = window.localStorage.getItem(IDENTITY_STORAGE);
  if (serialized === null) return null;
  try {
    const decoded: unknown = JSON.parse(serialized);
    if (decoded === null || typeof decoded !== "object") throw new Error("invalid identity");
    const token = Reflect.get(decoded, "token");
    const principal = PrincipalSchema.safeParse(Reflect.get(decoded, "principal"));
    if (typeof token !== "string" || token.length === 0 || !principal.success) {
      throw new Error("invalid identity");
    }
    return { token, principal: principal.data };
  } catch {
    window.localStorage.removeItem(IDENTITY_STORAGE);
    return null;
  }
}

interface IdentityGateProps {
  readonly children: (identity: StoredIdentity) => ReactNode;
}

/** Keeps every authenticated route behind the fragment bootstrap and first-person dialog. */
export function IdentityGate({ children }: IdentityGateProps) {
  const [identity, setIdentity] = useState<StoredIdentity | null>(() => loadIdentity());
  const [ownerKey] = useState<string | null>(() => loadOwnerKey());
  const [name, setName] = useState("");
  const [color, setColor] = useState<(typeof IDENTITY_COLORS)[number]>(IDENTITY_COLORS[3]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (identity !== null) return children(identity);

  if (ownerKey === null) {
    return (
      <main className="gate-screen">
        <section className="gate-card" aria-labelledby="owner-link-title">
          <p className="eyebrow">manifold</p>
          <h1 id="owner-link-title">Open the URL printed by the server</h1>
          <p>
            This browser has no owner key or identity token. Start manifold and open its full
            pre-authenticated URL to continue.
          </p>
        </section>
      </main>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const grant = await createPrincipal(ownerKey, { name: trimmedName, color });
      window.localStorage.setItem(IDENTITY_STORAGE, JSON.stringify(grant));
      setIdentity(grant);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create your identity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="gate-screen">
      <dialog className="identity-dialog" open aria-labelledby="identity-title">
        <form onSubmit={(event) => void submit(event)}>
          <p className="eyebrow">first visit</p>
          <h1 id="identity-title">Choose your identity</h1>
          <label className="field-label" htmlFor="identity-name">
            Name
          </label>
          <input
            id="identity-name"
            autoFocus
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="How should collaborators see you?"
          />
          <fieldset className="color-fieldset">
            <legend>Color</legend>
            <div className="color-grid">
              {IDENTITY_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  className={swatch === color ? "color-swatch selected" : "color-swatch"}
                  type="button"
                  aria-label={`Use color ${swatch}`}
                  aria-pressed={swatch === color}
                  style={{ backgroundColor: swatch }}
                  onClick={() => setColor(swatch)}
                />
              ))}
            </div>
          </fieldset>
          {/*
            Stays an inline form error rather than a toast, for two reasons that both
            hold. Structurally: the gate renders BEFORE the workspace, so there is no
            ToastProvider above it — the toast layer is mounted inside the authenticated
            application. Substantively: this is field-level validation feedback about the
            submission the user is looking at, and it belongs beside that submit button,
            not in a corner of a screen with nothing else on it.
          */}
          {error === null ? null : <p className="form-error">{error}</p>}
          <button
            className="primary-button"
            type="submit"
            disabled={submitting || name.trim() === ""}
          >
            {submitting ? "Creating identity…" : "Enter manifold"}
          </button>
        </form>
      </dialog>
    </main>
  );
}
