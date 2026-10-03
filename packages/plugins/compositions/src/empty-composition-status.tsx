import type { ConnectionStatus, SessionConnectionError } from "@manifold/sdk";
import { Chip } from "@manifold/ui";

/**
 * What an EMPTY composition's cover says about its session (issue #870). Only an `open` room
 * takes a drop. `idle`, `connecting` and `reconnecting` are progress the SDK is still making on
 * its own, so they keep an ellipsis. `closed` is final — no automatic attempt follows it — so it
 * reads as stopped: it names the session's reason when the close carried one (the same reason
 * the sticky connection notice reports) and offers the reload that dials a fresh connection,
 * the path the canvas names for its own closed state.
 */
export function EmptyCompositionStatus({
  status,
  connectionError,
  onReload,
}: {
  readonly status: ConnectionStatus;
  readonly connectionError: SessionConnectionError | null;
  readonly onReload: () => void;
}) {
  switch (status) {
    case "open":
      return <span>Drop an item here</span>;
    case "idle":
    case "connecting":
      return <span>Connecting to this view…</span>;
    case "reconnecting":
      return <span>Reconnecting to this view…</span>;
    case "closed":
      return (
        <>
          <strong className="composition-placeholder__status">Disconnected from this view</strong>
          {connectionError === null ? null : (
            <p className="composition-placeholder__reason">{connectionError.reason}</p>
          )}
          <Chip className="composition-placeholder__action" onClick={onReload}>
            Reload to connect again
          </Chip>
        </>
      );
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
