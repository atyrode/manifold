import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "./layout.tsx";

/**
 * THE one disclosure: a header that opens and closes the body under it. The sidebar's
 * section shell is the first adopter; anything in the product that folds should be this
 * component rather than a second `<details>`/`aria-expanded` wiring.
 *
 * Built ON `@radix-ui/react-collapsible`, and that sentence is an implementation detail on
 * purpose (docs/decisions/2026-08-31-radix-behavior-primitives.md): no Radix type or
 * component appears in this file's exports, so swapping the behavior engine out is a change
 * to this one file and no call site. What an adopter gets, and may rely on:
 *
 *   - the whole HEADER is the toggle — a real `<button>` carrying `aria-expanded` and
 *     `data-state="open" | "closed"`, so keyboard and screen-reader behavior come standard;
 *   - the root div repeats `data-state`, which is the styling hook for chevrons and borders
 *     (`.my-thing[data-state="open"] > …`);
 *   - the BODY STAYS MOUNTED while closed (hidden by this module's own CSS), exactly as the
 *     `<details>` element it replaced kept its content in the DOM — a section's pollers and
 *     subscriptions survive a fold.
 *
 * Controlled only: the adopter owns `open`, because every current holder of disclosure
 * state (the sidebar's per-tab fold memory) already had an owner. An uncontrolled variant
 * is a prop we can add the day something wants it.
 */
export interface DisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, "onToggle"> {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What the toggle button shows: a title, a chevron, a count — the adopter's nodes. */
  readonly header: ReactNode;
  /** Extra classes for the header button (`.disclosure__header`). */
  readonly headerClassName?: string;
  /** Extra classes for the body wrapper (`.disclosure__body`). */
  readonly bodyClassName?: string;
}

export function Disclosure({
  open,
  onOpenChange,
  header,
  headerClassName,
  bodyClassName,
  className,
  children,
  ...rest
}: DisclosureProps): ReactElement {
  return (
    <CollapsiblePrimitive.Root
      className={cx("disclosure", className)}
      open={open}
      onOpenChange={onOpenChange}
      {...rest}
    >
      <CollapsiblePrimitive.Trigger className={cx("disclosure__header", headerClassName)}>
        {header}
      </CollapsiblePrimitive.Trigger>
      {/* forceMount + CSS hide: the closed body keeps its DOM, like `<details>` did. */}
      <CollapsiblePrimitive.Content className={cx("disclosure__body", bodyClassName)} forceMount>
        {children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
