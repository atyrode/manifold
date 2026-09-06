import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { HTMLAttributes, ReactElement } from "react";
import { cx } from "./layout.tsx";

/**
 * THE one scroll container: a region that scrolls VERTICALLY and only vertically, wearing
 * the product's slim overlay scrollbar instead of each platform's gutter. The sidebar's
 * section bodies are the first adopters.
 *
 * Built ON `@radix-ui/react-scroll-area`, an implementation detail by contract
 * (docs/decisions/2026-08-31-radix-behavior-primitives.md): nothing Radix crosses this
 * file's exports. What an adopter gets, and may rely on:
 *
 *   - vertical overflow scrolls; horizontal overflow is REFUSED (`overflow-x: hidden` is
 *     the region's declared contract), so a child that cannot shrink is a child that must
 *     declare ellipsis or wrap — the region will not grow a sideways scrollbar to excuse it;
 *   - the scrollbar overlays content and appears only while the content overflows, so a
 *     short list costs no gutter;
 *   - the region is a well-behaved flex child (`min-height: 0`); give it `flex: 1 1 auto`
 *     and it absorbs exactly the leftover height of its column.
 */
export type ScrollRegionProps = Omit<HTMLAttributes<HTMLDivElement>, "dir">;

export function ScrollRegion({ className, children, ...rest }: ScrollRegionProps): ReactElement {
  return (
    <ScrollAreaPrimitive.Root type="auto" className={cx("scroll-region", className)} {...rest}>
      <ScrollAreaPrimitive.Viewport className="scroll-region__viewport">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="scroll-region__bar">
        <ScrollAreaPrimitive.Thumb className="scroll-region__thumb" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}
