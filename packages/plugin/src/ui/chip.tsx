import type { HTMLAttributes, ReactElement, Ref } from "react";
import { cx } from "./layout.tsx";

/**
 * THE one chip: a small bordered token — an address, a door name, a breadcrumb hop, a count.
 *
 * WHAT IT ACTS AS FOLLOWS FROM WHAT IT IS HANDED: an `onClick` makes it a real `<button>`
 * (keyboard activation and focus come standard), and without one it is an inert `<span>` —
 * but BOTH wear the same box, because the F10 inspector's hand-rolled hops proved the drift
 * this component exists to kill: its button hops inherited the browser's `1px 6px` while the
 * inert-span variant of the same row sat at zero, so prose tokens rendered with their glyphs
 * against the border. A vocabulary whose padding lives in one rule cannot split that way.
 *
 * The stdlib owns the BOX — border, radius, padding, type size, the hover cue on the button
 * form. The adopter owns the TINT: pass a class from your own family (`.inspector-hop` blue,
 * `.inspector-door` amber) and colour it in your own sheet, scoped under your family per S13.
 *
 * `ref` reaches the rendered element, and unknown DOM props are spread onto it, which is what
 * makes a chip legal as a {@link Popover} trigger: Radix's slot injects its handler and ARIA
 * wiring as props, the injected `onClick` flips the chip into its button form, and the ref
 * gives the positioner its anchor — composition, not a second chip.
 */
export interface ChipProps extends HTMLAttributes<HTMLElement> {
  readonly ref?: Ref<HTMLElement>;
}

export function Chip({ className, ref, ...rest }: ChipProps): ReactElement {
  const cls = cx("chip", className);
  /* `Ref<HTMLElement>` does not narrow through the RefObject member, so the two casts state
     what the branch already guarantees: this ref is handed exactly the element we render. */
  if (rest.onClick === undefined) {
    return <span {...rest} className={cls} ref={ref as Ref<HTMLSpanElement>} />;
  }
  return <button {...rest} type="button" className={cls} ref={ref as Ref<HTMLButtonElement>} />;
}
