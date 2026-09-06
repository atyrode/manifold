import { IDENTITY_COLORS, PrincipalSchema } from "@manifold/protocol";
import { instanceOrigin, isForeignInstance } from "@manifold/plugin/hooks";
import { Cover } from "@manifold/ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createPrincipal,
  getPreviewIdentityAuthority,
  issuePreviewIdentity,
  startPreviewIdentity,
  type StoredIdentity,
} from "./api.ts";

const OWNER_KEY_STORAGE = "manifold.ownerKey";
const IDENTITY_STORAGE = "manifold.identity";
const OWNER_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const OWNER_FRAGMENT_PATTERN = /^#key=([0-9a-f]{64})$/i;
const PREVIEW_NONCE_STORAGE = "manifold.previewNonce";

function previewHandoffRequest(): { audience: string; nonce: string } | null {
  if (window.location.pathname !== "/auth/preview") return null;
  const params = new URLSearchParams(window.location.search);
  const audience = params.get("audience");
  const nonce = params.get("nonce");
  if (audience === null || nonce === null) return null;
  return { audience, nonce };
}

function MissingIdentity({ message }: { readonly message: string }) {
  return (
    <main className="gate-screen">
      <Cover className="gate-cover">
        <section className="gate-card" aria-labelledby="owner-link-title">
          <p className="eyebrow">manifold</p>
          <h1 id="owner-link-title">Sign in required</h1>
          <p>{message}</p>
        </section>
      </Cover>
    </main>
  );
}

function PreviewAdmission() {
  const [message, setMessage] = useState("Checking production identity…");
  useEffect(() => {
    let active = true;
    void getPreviewIdentityAuthority()
      .then(async (authority) => {
        if (!active) return;
        if (authority === null) {
          setMessage(
            "This browser has no owner key or identity token. Start manifold and open its full pre-authenticated URL to continue.",
          );
          return;
        }
        const nonce = await startPreviewIdentity();
        if (!active) return;
        sessionStorage.setItem(PREVIEW_NONCE_STORAGE, nonce);
        const target = new URL("/auth/preview", authority);
        target.searchParams.set("audience", window.location.origin);
        target.searchParams.set("nonce", nonce);
        window.location.assign(target);
      })
      .catch((reason: unknown) => {
        if (active) {
          setMessage(
            reason instanceof Error
              ? reason.message
              : "Production identity could not be reached. Try again.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);
  return <MissingIdentity message={message} />;
}

function PreviewHandoff({
  identity,
  request,
}: {
  readonly identity: StoredIdentity;
  readonly request: { audience: string; nonce: string };
}) {
  const [message, setMessage] = useState("Authorizing preview…");
  useEffect(() => {
    let active = true;
    void issuePreviewIdentity(identity.token, request.audience, request.nonce)
      .then((assertion) => {
        if (!active) return;
        const form = document.createElement("form");
        form.method = "POST";
        form.action = `${request.audience}/auth/preview/callback`;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "assertion";
        input.value = assertion;
        form.append(input);
        document.body.append(form);
        form.submit();
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const detail =
          reason instanceof Error
            ? reason.message
            : "This production identity cannot open the preview.";
        if (detail === "expired" || detail === "revoked") {
          window.localStorage.removeItem(credentialKey(IDENTITY_STORAGE));
          window.location.reload();
          return;
        }
        setMessage(detail);
      });
    return () => {
      active = false;
    };
  }, [identity.token, request.audience, request.nonce]);
  return <MissingIdentity message={message} />;
}

/**
 * A CREDENTIAL BELONGS TO ONE INSTANCE. A token is minted by the server that will be asked to
 * honour it, and an owner key authenticates as root at exactly one origin — so a lens pointed
 * at a second instance may not read, and must never overwrite, the grant it holds for the
 * first. The key therefore carries the instance whenever the lens is looking somewhere other
 * than its birthplace (`manifold.identity@https://other.example`), and stays bare in the
 * ordinary case where those are the same place.
 *
 * Bare is not a special case dressed up: the served instance is the one every deployment has,
 * so its key is the one every reader — a human in devtools, a browser gate — already knows.
 * `REGISTRY.md` §Device-local register carries both spellings under one prefixed row.
 */
function credentialKey(base: string): string {
  return isForeignInstance() ? `${base}@${instanceOrigin()}` : base;
}

/**
 * The one color scheme: principals pick from it, machine dots hash into it. It lives in the
 * protocol now, because the server derives `MachineSummary.color` from the same palette and
 * two ends agreeing on a list of colors makes it vocabulary rather than styling.
 */
export { IDENTITY_COLORS };

/** Captures the one permitted URL-secret carrier before React renders, then cleans the URL. */
export function captureOwnerKeyFromFragment(): void {
  const match = OWNER_FRAGMENT_PATTERN.exec(window.location.hash);
  const ownerKey = match?.[1];
  if (ownerKey === undefined) return;
  window.localStorage.setItem(credentialKey(OWNER_KEY_STORAGE), ownerKey);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function loadOwnerKey(): string | null {
  const key = credentialKey(OWNER_KEY_STORAGE);
  const ownerKey = window.localStorage.getItem(key);
  if (ownerKey !== null && OWNER_KEY_PATTERN.test(ownerKey)) return ownerKey;
  if (ownerKey !== null) window.localStorage.removeItem(key);
  return null;
}

function loadIdentity(): StoredIdentity | null {
  const serialized = window.localStorage.getItem(credentialKey(IDENTITY_STORAGE));
  if (serialized === null) return null;
  try {
    const decoded: unknown = JSON.parse(serialized);
    if (decoded === null || typeof decoded !== "object") throw new Error("invalid identity");
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
      throw new Error("invalid identity");
    }
    if (
      typeof expiresInMs === "number" &&
      typeof receivedAt === "number" &&
      Date.now() - receivedAt >= expiresInMs
    ) {
      throw new Error("expired identity");
    }
    return {
      token,
      principal: principal.data,
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      ...(typeof expiresInMs === "number" ? { expiresInMs } : {}),
      ...(typeof receivedAt === "number" ? { receivedAt } : {}),
    };
  } catch {
    window.localStorage.removeItem(credentialKey(IDENTITY_STORAGE));
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
  const handoff = previewHandoffRequest();
  useEffect(() => {
    if (identity?.expiresInMs === undefined || identity.receivedAt === undefined) return;
    const timer = window.setTimeout(
      () => {
        window.localStorage.removeItem(credentialKey(IDENTITY_STORAGE));
        setIdentity(null);
      },
      Math.max(0, identity.expiresInMs - (Date.now() - identity.receivedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [identity]);

  if (identity !== null && handoff !== null) {
    return <PreviewHandoff identity={identity} request={handoff} />;
  }
  if (identity !== null) return children(identity);

  if (ownerKey === null) return <PreviewAdmission />;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const grant = await createPrincipal(ownerKey, { name: trimmedName, color });
      window.localStorage.setItem(credentialKey(IDENTITY_STORAGE), JSON.stringify(grant));
      setIdentity(grant);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create your identity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="gate-screen">
      <Cover className="gate-cover">
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
              Stays an inline form error rather than a notice, for two reasons that both
              hold. Structurally: the gate renders BEFORE the workspace, so there is no
              NoticeProvider above it — the notice layer is mounted inside the authenticated
              application. Substantively: this is field-level validation feedback about the
              submission the user is looking at, and it belongs beside that submit button,
              not in a corner of a screen with nothing else on it.
            */}
            {error === null ? null : <p className="form-error">{error}</p>}
            <button
              className="primary-button"
              data-testid="identity-enter"
              type="submit"
              disabled={submitting || name.trim() === ""}
            >
              {submitting ? "Creating identity…" : "Enter manifold"}
            </button>
          </form>
        </dialog>
      </Cover>
    </main>
  );
}
