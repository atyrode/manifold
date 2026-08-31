import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

import type { ElementHost } from "./host.ts";

/**
 * How a contributed element renderer reaches its mount site.
 *
 * A CONTEXT rather than props because the engine paints contributed elements through two
 * different frames — a React Flow node type on a canvas, a tile leaf in a composition — and
 * each of them already owns a wrapper. Threading the host through those wrappers' prop types
 * would make React Flow's node-props shape part of the element contract, which is exactly the
 * host internal a plugin must not learn (ADR 0010). The surface provides; the renderer asks.
 *
 * Its own module, not a member of `hooks.ts`, because the projection registry mounts elements
 * through it: a barrel that re-exports both cannot also be what one of them imports.
 */
const ElementHostContext = createContext<ElementHost | null>(null);

export function ElementHostProvider({
  value,
  children,
}: {
  readonly value: ElementHost;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ElementHostContext.Provider, { value }, children);
}

/** Throws rather than degrading: an element with no mount site has nowhere to commit an edit. */
export function useElementHost(): ElementHost {
  const host = useContext(ElementHostContext);
  if (host === null) {
    throw new Error("useElementHost requires an <ElementHostProvider> ancestor");
  }
  return host;
}
