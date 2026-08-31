import { recordSpotlight, type PadViewportHandle } from "@manifold/plugin";
import type { SessionClient } from "@manifold/sdk";
import { useCallback, useEffect, useState } from "react";

/**
 * "Look at this", received — `core.presence`'s receiving half (AXIOMS.md A2).
 *
 * `core.presence.focus` is the door: the server checked that the asker shares this room and
 * holds `scene:write` there, throttled the pair, and wrote `spotlight {uri, from}` into this
 * principal's presence. Everything here is the RECEIVING half — move the camera, say who
 * asked, and let the viewer switch the whole affordance off. Being pointed somewhere is an
 * interruption, so it is dismissible and refusable by construction.
 */

/** Device kill-switch (register: `manifold:ignore-spotlight`). */
const IGNORE_SPOTLIGHT_KEY = "manifold:ignore-spotlight";

export interface SpotlightState {
  /** The `manifold://` node the asker named. */
  readonly uri: string;
  /** Who asked: their display name when this client knows it, their principal id otherwise. */
  readonly from: string;
  /** Retires the chip; the camera stays where the spotlight put it. */
  readonly dismiss: () => void;
  /** Retires the chip AND stops applying spotlights on this device. */
  readonly ignore: () => void;
}

function spotlightIgnored(): boolean {
  try {
    return window.localStorage.getItem(IGNORE_SPOTLIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Applies spotlights addressed to this principal. The check is read at DELIVERY rather than
 * subscribed: flipping the switch takes effect on the next ask, and nothing is remembered
 * about asks that were never applied.
 *
 * `active` is whether this view SPEAKS for the viewer — the routed one does. An embedded board
 * inside a composition tile is a second mount of the same renderer, and two of them would
 * center twice and stack two chips for one ask.
 */
export function useSpotlight(
  client: SessionClient,
  viewport: PadViewportHandle,
  active: boolean,
): SpotlightState | null {
  const [state, setState] = useState<{ readonly uri: string; readonly from: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    return client.on("presence", (message) => {
      // Presence is principal-level state, so the server attributes its own write to the
      // target's first connection: the id that matters is WHOSE presence changed.
      if (message.principalId !== client.self?.id) return;
      const incoming = message.payload.spotlight;
      if (incoming === undefined || incoming === null || spotlightIgnored()) return;
      viewport.centerOn(incoming.uri);
      recordSpotlight(incoming.uri);
      setState({
        uri: incoming.uri,
        from: client.roster.get(incoming.from)?.principal.name ?? incoming.from,
      });
    });
  }, [active, client, viewport]);

  const dismiss = useCallback((): void => setState(null), []);
  const ignore = useCallback((): void => {
    try {
      window.localStorage.setItem(IGNORE_SPOTLIGHT_KEY, "1");
    } catch {
      // A device that refuses storage still gets the dismissal; the switch simply does not
      // persist, which is strictly better than failing the click.
    }
    setState(null);
  }, []);

  return state === null ? null : { ...state, dismiss, ignore };
}

/** Names the asker, offers out, and offers "never again" — the consent surface, not chrome. */
export function SpotlightChip({
  spotlight,
}: {
  readonly spotlight: SpotlightState;
}): React.ReactElement {
  return (
    <div className="spotlight-chip" data-spotlight-uri={spotlight.uri}>
      <span className="spotlight-chip__label">{spotlight.from} pointed you here</span>
      <button type="button" className="spotlight-chip__control" onClick={spotlight.dismiss}>
        Dismiss
      </button>
      <button type="button" className="spotlight-chip__control" onClick={spotlight.ignore}>
        Ignore spotlights
      </button>
    </div>
  );
}
