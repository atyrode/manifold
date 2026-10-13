import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./layout.tsx";

/**
 * THE one popover: anchored, dismissable chrome that floats over the page — a door's
 * argument form, a hop's detail. Anything that needs "a small layer beside this trigger"
 * should be this component rather than a second positioner.
 *
 * Built ON `@radix-ui/react-popover`, and that sentence is an implementation detail on
 * purpose (docs/decisions/2026-09-01-radix-popover.md, extending the 2026-08-31 contract):
 * nothing Radix crosses this signature. What an adopter gets, and may rely on:
 *
 *   - the TRIGGER is the adopter's own element, taken as-is — it must accept unknown DOM
 *     props and a `ref` (the stdlib's own {@link Chip} qualifies), and the injected `ref`
 *     is the positioner's anchor. No wrapper box appears around it;
 *   - the content is PORTALED to the document body wearing `popover__content` — it escapes
 *     any `overflow` clip and any `pointer-events: none` layer between it and the page, and
 *     a capture-phase listener that wants to leave it alone tests
 *     `target.closest(".popover__content")`;
 *   - dismissal is standard: Escape and outside-press call `onOpenChange(false)`, and both
 *     the trigger and the content repeat `data-state="open" | "closed"` for styling;
 *   - collision handling comes with the positioner — the layer flips and shifts to stay
 *     10px inside the viewport, so an adopter never writes edge math.
 *
 * Controlled only, exactly as the disclosure is: every current holder of "which layer is
 * open" already had an owner, and an uncontrolled variant is a prop we can add the day
 * something wants it.
 */
export interface PopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The anchor element; it receives the toggle handler, ARIA wiring and the anchor ref. */
  readonly trigger: ReactElement;
  /** Which side of the trigger the layer prefers; it flips when the viewport disagrees. */
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  /** Extra classes for the floating layer (`.popover__content`). */
  readonly contentClassName?: string;
  readonly children: ReactNode;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  side,
  align,
  contentClassName,
  children,
}: PopoverProps): ReactElement {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={cx("popover__content", contentClassName)}
          {...(side === undefined ? {} : { side })}
          {...(align === undefined ? {} : { align })}
          sideOffset={6}
          collisionPadding={10}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
