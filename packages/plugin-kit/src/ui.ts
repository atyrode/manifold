import type { UiListItem, UiNode, UiNodeType, UiSelectOption, UiTone } from "@manifold/protocol";

/**
 * BUILDERS FOR THE CLOSED COMPONENT VOCABULARY (ADR 0016 §3).
 *
 * An isolated panel never touches the DOM: it returns a tree of the thirteen node kinds the
 * engine publishes as `UiNodeSchema`, and the engine paints it. These builders are the
 * vocabulary as functions — one per kind, typed against the protocol's own union, so a tree
 * that typechecks here is one the host's schema accepts, and a kind the vocabulary lacks has
 * no builder to reach for. Nothing here validates: the worker runtime parses every tree it
 * posts, and a builder that cannot produce a bad shape needs no second check.
 */

/** The union member for one kind, so each builder returns exactly the node it names. */
export type UiNodeOf<T extends UiNodeType> = Extract<UiNode, { readonly type: T }>;

/** A flex box. `direction` defaults to `column`; `gap` (0–3, a step of the shell's spacing scale) to 1. */
export interface BoxOptions {
  readonly direction?: "row" | "column" | undefined;
  readonly gap?: 0 | 1 | 2 | 3 | undefined;
  readonly grow?: boolean | undefined;
  readonly wrap?: boolean | undefined;
}

/** Prose: ONE line, truncated with an ellipsis, unless `wrap`; `mono` is the shell's monospace family. */
export interface TextOptions {
  readonly tone?: UiTone | undefined;
  readonly mono?: boolean | undefined;
  readonly wrap?: boolean | undefined;
}

export interface ButtonOptions {
  readonly payload?: unknown;
  readonly tone?: UiTone | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * The FULL name of the action this button's event ultimately dispatches. The engine paints
   * it as `data-action`, so a stranger's affordance names its door exactly as a first-party
   * one does (invariant 12). Set it on every button whose event ends in `host.action(...)`.
   */
  readonly action?: string | undefined;
}

export interface SelectOptions {
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
}

export interface InputOptions {
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly mono?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

export interface ToggleOptions {
  readonly disabled?: boolean | undefined;
}

export const ui = {
  box(options: BoxOptions, children: readonly UiNode[]): UiNodeOf<"box"> {
    return { type: "box", ...options, children };
  },
  heading(text: string, level?: 1 | 2 | 3): UiNodeOf<"heading"> {
    return level === undefined ? { type: "heading", text } : { type: "heading", text, level };
  },
  text(text: string, options: TextOptions = {}): UiNodeOf<"text"> {
    return { type: "text", text, ...options };
  },
  code(text: string): UiNodeOf<"code"> {
    return { type: "code", text };
  },
  badge(text: string, tone?: UiTone): UiNodeOf<"badge"> {
    return tone === undefined ? { type: "badge", text } : { type: "badge", text, tone };
  },
  divider(): UiNodeOf<"divider"> {
    return { type: "divider" };
  },
  spinner(label?: string): UiNodeOf<"spinner"> {
    return label === undefined ? { type: "spinner" } : { type: "spinner", label };
  },
  button(label: string, event: string, options: ButtonOptions = {}): UiNodeOf<"button"> {
    return { type: "button", label, event, ...options };
  },
  select(
    event: string,
    value: string | null,
    options: readonly UiSelectOption[],
    extra: SelectOptions = {},
  ): UiNodeOf<"select"> {
    return { type: "select", event, value, options, ...extra };
  },
  input(event: string, value: string, options: InputOptions = {}): UiNodeOf<"input"> {
    return { type: "input", event, value, ...options };
  },
  toggle(
    event: string,
    value: boolean,
    label: string,
    options: ToggleOptions = {},
  ): UiNodeOf<"toggle"> {
    return { type: "toggle", event, value, label, ...options };
  },
  list(items: readonly UiListItem[]): UiNodeOf<"list"> {
    return { type: "list", items };
  },
  empty(text: string): UiNodeOf<"empty"> {
    return { type: "empty", text };
  },
} as const;

/*
  Every kind has exactly one builder: a kind added to the protocol's inventory with no
  builder here fails to compile, and a builder for a kind the inventory lacks cannot exist
  because its return type would be `never`.
 */
type MissingBuilder = Exclude<UiNodeType, keyof typeof ui>;
const everyKindHasABuilder: MissingBuilder extends never ? true : never = true;
void everyKindHasABuilder;
