/**
 * Engagement: how a container portal stops watching and starts working.
 *
 * A view embedded on a canvas paints from ONE room socket. Watching uses a
 * spectator socket — invisible in presence, refused every write, no vote in the
 * bubble rule — so a canvas full of portals never fakes occupancy and never pins a
 * transient view open. Working needs the opposite: a real occupant socket, whose
 * keystrokes the server accepts and whose principal shows up in the roster.
 *
 * The escalation is therefore a socket swap, and a swap must not blink: the portal
 * keeps painting the socket it has until the replacement has replayed its init, then
 * switches in a single commit (terminal snapshot replay closes the output gap, a
 * server invariant). React's effect ordering cannot express that — an effect keyed on
 * the discipline runs its cleanup, tearing the live socket down, BEFORE the effect
 * that would open the replacement — so the two sockets are owned here and React
 * subscribes to the result.
 */

/** The two disciplines a portal socket can wear. */
export type ChannelRole = "spectator" | "occupant";

/** The slice of `SessionClient` the switch needs; keeps this module React- and SDK-free. */
export interface EngageableSocket {
  connect: () => Promise<void>;
  close: () => void;
}

export interface PortalSlot<T extends EngageableSocket> {
  readonly client: T;
  readonly role: ChannelRole;
}

export interface PortalSocketSwitch {
  /**
   * Asks for a discipline. Idempotent: requesting the one already painted, or the one
   * already in flight, does nothing. Requesting the opposite opens a second socket and
   * promotes it once its init lands.
   */
  readonly request: (role: ChannelRole) => void;
  /** Closes both sockets and reports an empty slot. */
  readonly dispose: () => void;
}

/**
 * @param open  opens a socket in the given discipline (already `connect()`-able).
 * @param onSlot reports the socket the portal should paint; null before the first
 *               init and after `dispose`.
 * @param onFailure a requested discipline could not be reached. Reported rather than
 *               logged because engaging a portal is a direct user action: without it the
 *               viewer is left looking at a tile that silently refuses keystrokes. The
 *               consumer owns the notice ref — this module stays React-free.
 */
export function createPortalSocketSwitch<T extends EngageableSocket>(
  open: (role: ChannelRole) => T,
  onSlot: (slot: PortalSlot<T> | null) => void,
  onFailure: (role: ChannelRole, reason: unknown) => void,
): PortalSocketSwitch {
  let painted: PortalSlot<T> | null = null;
  let pending: PortalSlot<T> | null = null;
  let disposed = false;

  const request = (role: ChannelRole): void => {
    if (disposed) return;
    if (pending !== null) {
      if (pending.role === role) return;
      // A reversal mid-flight (engage, then click away before the occupant socket is
      // up) abandons the socket nobody has seen; the painted one keeps painting.
      pending.client.close();
      pending = null;
    }
    if (painted !== null && painted.role === role) return;
    const client = open(role);
    const inflight: PortalSlot<T> = { client, role };
    pending = inflight;
    void client.connect().then(
      () => {
        if (disposed || pending !== inflight) return;
        pending = null;
        const previous = painted;
        painted = inflight;
        onSlot(inflight);
        // Retiring the outgoing socket here — before React repaints — is safe: writes
        // on a closed client land in a dead outbox, and the tree that was painting it
        // unmounts in the commit this triggers.
        previous?.client.close();
      },
      (reason: unknown) => {
        if (disposed || pending !== inflight) return;
        pending = null;
        client.close();
        onFailure(role, reason);
      },
    );
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    pending?.client.close();
    pending = null;
    painted?.client.close();
    painted = null;
    onSlot(null);
  };

  return { request, dispose };
}
