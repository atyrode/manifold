import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode } from "react";

/**
 * THE LAYOUT ALGEBRA — six composable boxes that answer "how do things sit together?"
 * so a plugin body never answers it with bespoke flex soup.
 *
 * Every primitive is a thin `<div>` plus one CSS family (`layout-*` in `styles.css`); the
 * component's whole job is to name the pattern and carry its knobs as CSS custom properties.
 * The layout itself is INTRINSIC, in the Every-Layout sense: no primitive asks how wide its
 * container is — each one declares how it responds to whatever width it is given, so the
 * same composition holds at a 168px sidebar and a full-bleed panel without a breakpoint.
 *
 * The discipline the family enforces, so an adopter does not have to remember it:
 *
 *   min-width: 0     on every child. A flex/grid child's default `min-width: auto` is how a
 *                    60-character unbroken name blows a column open; the primitives reset it,
 *                    so a child that wants to refuse shrinking must SAY so (`flex-shrink: 0`).
 *   gap, never margin. Spacing belongs to the box that arranges, not to the things arranged;
 *                    a child dropped into a different primitive carries no stale margins with it.
 *   clamp() for defaults. The default gap breathes with the nearest `@container` (falling
 *                    back to the viewport) between fixed floors and ceilings, so dense chrome
 *                    tightens on its own in a narrow rail.
 *
 * EVERY text node inside a primitive still owes a declared overflow contract — either it
 * truncates (`text-overflow: ellipsis` + `overflow: hidden` + `white-space: nowrap`) or it
 * wraps (`overflow-wrap: anywhere`). The primitives make room honestly; they cannot decide
 * which of the two a label wants.
 *
 * SUPERSEDEABLE BY CONSTRUCTION: each primitive merges `className`/`style` and forwards the
 * rest of its div attributes, so an adopter can tighten, extend or entirely out-style one
 * without this module growing a prop. These are a baseline, never a prison.
 */

/** Joins the primitive's own class with the adopter's, dropping the blanks. */
export function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

/** Folds knob values into custom properties on the adopter's own `style`, skipping unset ones. */
function withVars(
  style: CSSProperties | undefined,
  vars: Readonly<Record<string, string | undefined>>,
): CSSProperties | undefined {
  const set = Object.entries(vars).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (set.length === 0) return style;
  // React's CSSProperties has no index for `--*` custom properties; the merged shape is one.
  const merged = { ...style, ...Object.fromEntries(set) } as CSSProperties;
  return merged;
}

/** The knobs every primitive shares: the adopter's div, plus the one spacing token. */
export interface LayoutProps extends HTMLAttributes<HTMLDivElement> {
  /** Any CSS length (`"0.4rem"`, `"clamp(0.2rem, 1cqi, 0.6rem)"`). Unset: the adaptive default. */
  readonly gap?: string;
}

export interface StackProps extends LayoutProps {
  /** `align-items` for the column; unset: `stretch`, so children fill the inline axis. */
  readonly align?: CSSProperties["alignItems"];
}

/**
 * `Stack` — vertical rhythm. Children read top-to-bottom with one gap between them; nothing
 * grows unless a child asks (`flex: 1 1 auto` on the child is the idiom, exactly as the
 * sidebar's own section stack does for its height absorber).
 *
 * ```tsx
 * <Stack gap="0.4rem">
 *   <header>…</header>
 *   <ScrollRegion style={{ flex: "1 1 auto" }}>…</ScrollRegion>
 * </Stack>
 * ```
 */
export function Stack({
  gap,
  align,
  className,
  style,
  children,
  ...rest
}: StackProps): ReactElement {
  return (
    <div
      className={cx("layout-stack", className)}
      style={withVars(style, {
        "--layout-gap": gap,
        "--layout-align": typeof align === "string" ? align : undefined,
      })}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface ClusterProps extends LayoutProps {
  /** `justify-content` for the row; unset: `flex-start`. */
  readonly justify?: CSSProperties["justifyContent"];
  /** `align-items` for the row; unset: `center`, because clusters mostly hold controls and labels. */
  readonly align?: CSSProperties["alignItems"];
}

/**
 * `Cluster` — a row of things that WRAPS instead of overflowing: toolbars, tag lists, a
 * label beside its count. When the row runs out of inline room the tail wraps to a new
 * line, which is the resilient answer for peers of unknown width.
 *
 * ```tsx
 * <Cluster justify="space-between">
 *   <span>{count}</span>
 *   <button>…</button>
 * </Cluster>
 * ```
 */
export function Cluster({
  gap,
  justify,
  align,
  className,
  style,
  children,
  ...rest
}: ClusterProps): ReactElement {
  return (
    <div
      className={cx("layout-cluster", className)}
      style={withVars(style, {
        "--layout-gap": gap,
        "--layout-justify": typeof justify === "string" ? justify : undefined,
        "--layout-align": typeof align === "string" ? align : undefined,
      })}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface SidebarProps extends LayoutProps {
  /** Which of the two children is the aside; unset: `"start"` (the first child). */
  readonly side?: "start" | "end";
  /** The aside's preferred inline size (its flex basis). Unset: `15rem`. */
  readonly sideWidth?: string;
  /**
   * The content pane's minimum share of the row, as a percentage. Below it the pair stacks
   * vertically instead of squeezing. Unset: `50%`.
   */
  readonly contentMin?: string;
}

/**
 * `Sidebar` — the two-column content+aside pattern, self-collapsing. Give it EXACTLY two
 * children: the aside keeps its preferred width while the content pane takes the rest, and
 * when the content pane would drop under {@link SidebarProps.contentMin} the pair stacks
 * vertically — no media query, no breakpoint, just the algebra.
 *
 * (The pattern, not the product chrome: the workspace's own sidebar is a `core.shell` panel.
 * Use this wherever a body wants a rail beside a reading pane — settings beside a preview,
 * a legend beside a chart.)
 */
export function Sidebar({
  side = "start",
  sideWidth,
  contentMin,
  gap,
  className,
  style,
  children,
  ...rest
}: SidebarProps): ReactElement {
  return (
    <div
      className={cx("layout-sidebar", side === "end" && "layout-sidebar--end", className)}
      style={withVars(style, {
        "--layout-gap": gap,
        "--layout-side": sideWidth,
        "--layout-content-min": contentMin,
      })}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface SwitcherProps extends LayoutProps {
  /**
   * The container width at which the row becomes a column: wider than this, children share
   * one row equally; narrower, each takes a full row. Unset: `20rem`.
   */
  readonly threshold?: string;
}

/**
 * `Switcher` — a row that becomes a column past a threshold, all-or-nothing: children are
 * either all side-by-side or all stacked, never a ragged in-between. The classic use is a
 * pair of action buttons that must not shrink their labels into each other.
 */
export function Switcher({
  threshold,
  gap,
  className,
  style,
  children,
  ...rest
}: SwitcherProps): ReactElement {
  return (
    <div
      className={cx("layout-switcher", className)}
      style={withVars(style, { "--layout-gap": gap, "--layout-threshold": threshold })}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CoverProps extends LayoutProps {
  /** Chrome above the centered principal; optional. */
  readonly top?: ReactNode;
  /** Chrome below the centered principal; optional. */
  readonly bottom?: ReactNode;
  /** The cover's minimum block size; unset: `100%` of its container. */
  readonly minHeight?: string;
}

/**
 * `Cover` — a full-height box whose principal content (the children) is vertically centered
 * between optional top and bottom chrome: empty states, gates, "nothing here yet" screens.
 * The centering is honest flexbox (`margin-block: auto` on the principal), so a tall
 * principal simply uses the room instead of clipping.
 */
export function Cover({
  top,
  bottom,
  minHeight,
  gap,
  className,
  style,
  children,
  ...rest
}: CoverProps): ReactElement {
  return (
    <div
      className={cx("layout-cover", className)}
      style={withVars(style, { "--layout-gap": gap, "--layout-cover-min": minHeight })}
      {...rest}
    >
      {top}
      <div className="layout-cover__principal">{children}</div>
      {bottom}
    </div>
  );
}

export interface FrameProps extends LayoutProps {
  /** A CSS `aspect-ratio` value (`"16 / 9"`, `"1"`). Unset: `16 / 9`. */
  readonly ratio?: string;
}

/**
 * `Frame` — an aspect-boxed window for media. The box keeps its ratio at any width; a
 * direct `<img>`/`<video>` child fills it edge to edge (`object-fit: cover`), anything else
 * is centered. What does not fit is CLIPPED, and that clipping is the primitive's declared
 * contract — a Frame is a viewport onto its child, never a resizer of it.
 */
export function Frame({
  ratio,
  gap,
  className,
  style,
  children,
  ...rest
}: FrameProps): ReactElement {
  return (
    <div
      className={cx("layout-frame", className)}
      style={withVars(style, { "--layout-gap": gap, "--layout-ratio": ratio })}
      {...rest}
    >
      {children}
    </div>
  );
}
