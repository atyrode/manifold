import type { UiNodeType } from "@manifold/protocol";
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

/**
 * THE FRAME SEAM (ADR 0053): where one component source stops meaning DOM.
 *
 * A portable web contribution is ONE React implementation. In the page it renders the design
 * system's ordinary DOM; in a hardened Worker the same components render under
 * {@link FrameModeProvider}, and there each supported component emits exactly one closed
 * intrinsic — `manifold:box`, `manifold:button`, … one per `UI_NODE_TYPES` kind — whose props
 * are that kind's `UiNode` fields with named events replaced by the author's callbacks. Only
 * `manifold:box` has element children; every text a node shows is a prop. The Worker's
 * renderer turns those intrinsics into the bounded tree the host paints, and the host paints
 * it with these same components outside frame mode. Nothing here emulates a DOM.
 *
 * A frame carries data, never ink: a prop that only means something to a DOM — a class, an
 * inline style, a ref, an arbitrary attribute or handler — REFUSES by name instead of being
 * dropped, because a control that silently lost its handler or its label is worse than one
 * that never rendered.
 */

/** Every intrinsic a frame-mode component emits is this prefix plus its `UiNode` type. */
export const FRAME_ELEMENT_PREFIX = "manifold:";

const FrameMode = createContext(false);

export interface FrameModeProviderProps {
  readonly children?: ReactNode;
}

/** Wraps a Worker-mounted root: every design-system component under it emits frame intrinsics. */
export function FrameModeProvider({ children }: FrameModeProviderProps): ReactElement {
  return <FrameMode value={true}>{children}</FrameMode>;
}

/** Whether the calling component renders into a frame rather than into the page's DOM. */
export function useFrameMode(): boolean {
  return useContext(FrameMode);
}

/** The one refusal shape, naming the component and what it cannot carry across. */
export function refuseInFrame(component: string, what: string): never {
  throw new TypeError(
    `${component} cannot carry ${what} into a frame: only the closed component vocabulary crosses (ADR 0053)`,
  );
}

/**
 * The intrinsic for one vocabulary kind. Children are passed only by a box: a leaf's element
 * has no `children` prop at all, so the renderer never has to tell "none" from "empty".
 */
export function frameElement(
  type: UiNodeType,
  props: Readonly<Record<string, unknown>>,
  ...children: ReactNode[]
): ReactElement {
  return createElement(`${FRAME_ELEMENT_PREFIX}${type}`, props, ...children);
}

/** The explicit presentation metadata a frame node may carry (`UiNodeMeta`, minus `key`). */
export interface FrameMeta {
  readonly title?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly testId?: string | undefined;
  readonly role?: "status" | "alert" | undefined;
}

/** The DOM attribute each piece of metadata is authored as, and the `UiNodeMeta` field it becomes. */
const META_FIELDS: Readonly<Record<string, keyof FrameMeta>> = {
  title: "title",
  "aria-label": "ariaLabel",
  "data-testid": "testId",
  role: "role",
};

/**
 * Reads the standard attributes a component was handed as frame metadata and refuses every
 * other one. `extra` is what remains after the component took its own knobs, so anything
 * here is either metadata or something no frame can carry — a ref, a handler, an unknown
 * attribute. Undefined values are absent, exactly as React treats them.
 */
export function frameMeta(component: string, extra: object): FrameMeta {
  const meta: { -readonly [K in keyof FrameMeta]: FrameMeta[K] } = {};
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    const field = Object.hasOwn(META_FIELDS, name) ? META_FIELDS[name] : undefined;
    if (field === undefined) refuseInFrame(component, `\`${name}\``);
    if (typeof value !== "string") refuseInFrame(component, `a non-text \`${name}\``);
    if (field === "role") {
      if (value !== "status" && value !== "alert") refuseInFrame(component, `role "${value}"`);
      meta.role = value;
    } else {
      meta[field] = value;
    }
  }
  return meta;
}
