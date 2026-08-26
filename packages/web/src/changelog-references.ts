const REPOSITORY_DISCUSSION_URL = "https://github.com/atyrode/manifold/issues/";
const REFERENCE_PATTERN = /#([1-9]\d*)/g;

export type ChangelogPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly text: string; readonly href: string };

export function parseChangelogReferences(change: string): readonly ChangelogPart[] {
  const parts: ChangelogPart[] = [];
  let offset = 0;

  for (const match of change.matchAll(REFERENCE_PATTERN)) {
    const index = match.index;
    const number = match[1];
    if (index > offset) parts.push({ kind: "text", text: change.slice(offset, index) });
    parts.push({
      kind: "reference",
      text: match[0],
      href: `${REPOSITORY_DISCUSSION_URL}${number}`,
    });
    offset = index + match[0].length;
  }

  if (offset < change.length) parts.push({ kind: "text", text: change.slice(offset) });
  return parts;
}
