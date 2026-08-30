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
