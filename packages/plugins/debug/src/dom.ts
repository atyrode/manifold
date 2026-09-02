import {
  DOOR_SELECTOR,
  IDENTITY_ATTRIBUTES,
  IDENTITY_SELECTOR,
  declarationOf,
  distinctDoors,
  type Declared,
} from "./identity.ts";

/**
 * The DOM half of the inspector's lookup, and deliberately the whole of it: a walk up
 * `parentElement`, two `querySelectorAll` counts, and nothing that decides anything. Every rule
 * about precedence, addresses and nouns lives in `identity.ts`, where it is unit-tested without
 * a document.
 */

const ATTRIBUTE_NAMES: readonly string[] = Object.values(IDENTITY_ATTRIBUTES);

/**
 * One element as the pure layer reads it. Only the attributes that layer understands are copied
 * — a whole `NamedNodeMap` per ancestor per pointer frame is work nobody asked for, and the
 * closed list is what makes the copy cheap enough to do on a move.
 */
function declared(element: Element): Declared {
  const attributes: Record<string, string> = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value;
  }
  return { attributes, classes: [...element.classList] };
}

/** The ancestor chain INNERMOST FIRST — the direction `parentElement` walks. */
export function ancestryOf(element: Element): readonly Declared[] {
  const chain: Declared[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    chain.push(declared(node));
  }
  return chain;
}

/**
 * THE ELEMENTS THAT DECLARE, outermost first — the same filter and the same order `chainOf`
 * applies to the same walk, so hop `i` of an identity's chain is painted by element `i` of this
 * one and a highlight can be zipped on by POSITION.
 *
 * Position rather than a match on attribute and id, because two ancestors may declare the
 * identical pair (a tile nested in a tile of the same id in another tree) and only where they
 * sit tells them apart. `declarationOf` decides membership rather than {@link IDENTITY_SELECTOR}
 * because the two genuinely disagree: React Flow puts `data-id` on its handles as well as its
 * nodes, the selector matches both and the rule accepts only the node — and a chain that
 * included a box the chip would never name is a highlight pointing at a lie.
 *
 * Walked only when a reading is PINNED. The hovered box is the aim's own ancestor and costs
 * nothing to find; this second walk buys the pinned card's breadcrumb its boxes, once.
 */
export function declaringChainOf(element: Element): readonly Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (declarationOf(declared(node)) !== null) chain.push(node);
  }
  return chain.reverse();
}

/** What sits UNDER a pinned element: how many declared things, and which doors. */
export interface Subtree {
  readonly children: number;
  readonly doors: readonly string[];
}

export function subtreeOf(element: Element): Subtree {
  const doors: string[] = [];
  for (const door of element.querySelectorAll(DOOR_SELECTOR)) {
    doors.push(door.getAttribute(IDENTITY_ATTRIBUTES.door) ?? "");
  }
  return {
    children: element.querySelectorAll(IDENTITY_SELECTOR).length,
    doors: distinctDoors(doors),
  };
}
