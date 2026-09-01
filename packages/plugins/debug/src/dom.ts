import {
  DOOR_SELECTOR,
  IDENTITY_ATTRIBUTES,
  IDENTITY_SELECTOR,
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
