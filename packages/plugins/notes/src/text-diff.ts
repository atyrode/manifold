/**
 * The character-level merge policy behind collaborative note editing.
 *
 * A `<textarea>` reports a whole new string; a `Y.Text` wants the smallest edit that produced
 * it. Turning one into the other is what keeps two people typing in the same note from
 * clobbering each other: replacing the whole text would delete and re-insert every character,
 * so a peer's concurrent insert would land inside a range that no longer exists.
 *
 * The cursor is the tie-breaker, not a hint. `abcabc` → `abcXabc` is ambiguous — the `X` could
 * have been typed at index 3 or at index 4 — and only the caret knows which; bounding the
 * common prefix by it is what makes the derived edit match what the human actually did.
 */
export interface TextDiff {
  readonly index: number;
  readonly remove: number;
  readonly insert: string;
}

export function diffText(before: string, after: string, cursor: number): TextDiff {
  const prefixLimit = Math.min(Math.max(0, cursor), before.length, after.length);
  let prefix = 0;
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  let suffix = 0;
  while (
    suffix < suffixLimit &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    index: prefix,
    remove: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
