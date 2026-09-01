import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "./layout.tsx";

/**
 * THE key-value vocabulary: a reading of one thing, as labelled rows. A `<dl>`, because a
 * list of "is / at / owner" facts about one subject IS a definition list, and the semantics
 * should not depend on which plugin happened to write the markup.
 *
 * The list owns the rhythm (one grid, one gap); the row owns the two columns — a
 * right-aligned label and a value that WRAPS rather than earning a scrollbar, because an
 * address is long by nature and `overflow-wrap: anywhere` is part of the contract, not a
 * per-adopter fix. The label column's width is the one knob, and it is a CSS custom
 * property (`--kv-label`) on the list rather than a prop, so a card whose labels run long
 * re-declares one number in its own family's rule and every row follows.
 */
export type KeyValueListProps = HTMLAttributes<HTMLDListElement>;

export function KeyValueList({ className, ...rest }: KeyValueListProps): ReactElement {
  return <dl {...rest} className={cx("kv", className)} />;
}

export interface KeyValueRowProps extends HTMLAttributes<HTMLDivElement> {
  /** What the value is ABOUT — a word, not a sentence; it sits in the label column. */
  readonly label: ReactNode;
}

export function KeyValueRow({ label, className, children, ...rest }: KeyValueRowProps): ReactElement {
  return (
    <div {...rest} className={cx("kv__row", className)}>
      <dt className="kv__label">{label}</dt>
      <dd className="kv__value">{children}</dd>
    </div>
  );
}
