import type { Pad } from "@manifold/protocol";
import { useEffect, useState, type FormEvent } from "react";
import { createPad, deletePad, listPads, type StoredIdentity } from "./api.ts";

interface PadListProps {
  readonly identity: StoredIdentity;
  readonly navigate: (path: string) => void;
}

/** Lists and creates pads without introducing a second routing or data-client dependency. */
export function PadList({ identity, navigate }: PadListProps) {
  const [pads, setPads] = useState<Pad[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listPads(identity.token)
      .then((nextPads) => {
        if (active) setPads(nextPads);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load pads");
      });
    return () => {
      active = false;
    };
  }, [identity.token]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const pad = await createPad(identity.token, trimmedName);
      navigate(`/p/${encodeURIComponent(pad.id)}`);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create the pad");
      setCreating(false);
    }
  };

  const remove = async (pad: Pad): Promise<void> => {
    // Deletion is canonical and unrecoverable (scene + sessions); confirm by name.
    if (!window.confirm(`Delete pad "${pad.name}"? This cannot be undone.`)) return;
    setDeletingId(pad.id);
    setError(null);
    try {
      await deletePad(identity.token, pad.id);
      setPads(await listPads(identity.token));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not delete the pad");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="pad-list-screen">
      <header className="pad-list-header">
        <div>
          <p className="eyebrow">manifold</p>
          <h1>Pads</h1>
        </div>
        <div className="identity-chip">
          <span className="identity-dot" style={{ backgroundColor: identity.principal.color }} />
          <span>{identity.principal.name}</span>
        </div>
      </header>

      <form className="create-pad-form" onSubmit={(event) => void submit(event)}>
        <label className="field-label" htmlFor="new-pad-name">
          New pad
        </label>
        <div className="create-pad-row">
          <input
            id="new-pad-name"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Pad name"
          />
          <button
            className="primary-button"
            type="submit"
            disabled={creating || name.trim() === ""}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>

      {error === null ? null : <p className="form-error list-error">{error}</p>}
      {pads === null ? (
        <p className="muted-copy">Loading pads…</p>
      ) : pads.length === 0 ? (
        <section className="empty-pads">
          <h2>No pads yet</h2>
          <p>Create one above to open a shared canvas.</p>
        </section>
      ) : (
        <ul className="pad-grid">
          {pads.map((pad) => (
            <li key={pad.id} className="pad-card">
              <button type="button" onClick={() => navigate(`/p/${encodeURIComponent(pad.id)}`)}>
                <span className="pad-card-name">{pad.name}</span>
                <span className="pad-card-action">Open canvas</span>
              </button>
              <button
                type="button"
                className="pad-card-delete"
                title={`Delete pad ${pad.name}`}
                aria-label={`Delete pad ${pad.name}`}
                disabled={deletingId !== null}
                onClick={() => void remove(pad)}
              >
                {deletingId === pad.id ? "…" : "✕"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
