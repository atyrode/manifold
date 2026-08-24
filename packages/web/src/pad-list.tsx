import type { Pad } from "@manifold/protocol";
import { useEffect, useState, type FormEvent } from "react";
import { createPad, listPads, type StoredIdentity } from "./api.ts";

interface PadListProps {
  readonly identity: StoredIdentity;
  readonly navigate: (path: string) => void;
}

/** Lists and creates pads without introducing a second routing or data-client dependency. */
export function PadList({ identity, navigate }: PadListProps) {
  const [pads, setPads] = useState<Pad[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
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
            <li key={pad.id}>
              <button type="button" onClick={() => navigate(`/p/${encodeURIComponent(pad.id)}`)}>
                <span className="pad-card-name">{pad.name}</span>
                <span className="pad-card-action">Open canvas</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
