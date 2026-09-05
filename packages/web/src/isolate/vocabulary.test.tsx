import { describe, expect, test } from "bun:test";
import type { UiNode } from "@manifold/protocol";
import { Fragment, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VocabularyRenderer } from "./vocabulary.tsx";

/**
 * THE VOCABULARY'S CONTRACT (ADR 0016 §3): every one of the thirteen node kinds paints into the
 * one `mf-vocab` family, a button's `action` is painted as `data-action` (S4, invariant 12), the
 * three controls show the tree's value, and a gesture on any control becomes exactly one named
 * event carrying what the node said it would.
 */

const EVERYTHING: UiNode = {
  type: "box",
  direction: "row",
  gap: 2,
  grow: true,
  wrap: true,
  children: [
    { type: "heading", text: "Notes", level: 1 },
    { type: "text", text: "plain" },
    { type: "text", text: "mono", mono: true, wrap: true, tone: "muted" },
    { type: "code", text: "const x = 1;\nx;" },
    { type: "badge", text: "3 open", tone: "success" },
    { type: "divider" },
    { type: "spinner", label: "Syncing" },
    { type: "button", label: "Save", event: "save", action: "acme.notes.save", tone: "accent" },
    { type: "button", label: "Later", event: "later", disabled: true },
    {
      type: "select",
      event: "pick",
      value: "b",
      label: "Which",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    { type: "select", event: "pick", value: null, options: [{ value: "a", label: "A" }] },
    { type: "input", event: "typed", value: "draft", placeholder: "Say…", mono: true },
    { type: "toggle", event: "flip", value: true, label: "Pinned", disabled: true },
    {
      type: "list",
      items: [
        { key: "1", primary: "First", secondary: "one", event: "open", payload: { id: 1 } },
        { key: "2", primary: "Second", tone: "danger" },
      ],
    },
    { type: "empty", text: "Nothing yet" },
  ],
};

function markup(tree: UiNode, tone?: "danger"): string {
  return renderToStaticMarkup(<VocabularyRenderer tree={tree} onEvent={() => {}} tone={tone} />);
}

/** A host element as the walker sees it: tag, props minus children, and the evaluated children. */
interface Painted {
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly Painted[];
}

/**
 * Evaluates a React element tree WITHOUT a DOM: function components are called (the vocabulary's
 * are hook-free by design), host elements are kept with their handler props intact — which is
 * what lets a test press a button and read the event it posts.
 */
function paint(node: ReactNode): readonly Painted[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => paint(child));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const { type, props } = node;
  const { children, ...rest } = props;
  if (type === Fragment) return paint(children as ReactNode);
  if (typeof type === "function") {
    const component = type as (props: Record<string, unknown>) => ReactNode;
    return paint(component(props));
  }
  return [{ tag: String(type), props: rest, children: paint(children as ReactNode) }];
}

function find(painted: readonly Painted[], className: string): Painted | null {
  for (const element of painted) {
    const own = element.props["className"];
    if (typeof own === "string" && own.split(" ").includes(className)) return element;
    const inner = find(element.children, className);
    if (inner !== null) return inner;
  }
  return null;
}

function findAll(painted: readonly Painted[], className: string): Painted[] {
  const found: Painted[] = [];
  for (const element of painted) {
    const own = element.props["className"];
    if (typeof own === "string" && own.split(" ").includes(className)) found.push(element);
    found.push(...findAll(element.children, className));
  }
  return found;
}

/** Fires a handler prop with a minimal synthetic event; the handlers read only `currentTarget`. */
function fire(element: Painted | null, handler: string, currentTarget: unknown = {}): void {
  const fn = element?.props[handler];
  if (typeof fn !== "function") throw new Error(`${handler} is not wired`);
  fn({ currentTarget });
}

describe("VocabularyRenderer paints every kind into the one family", () => {
  const html = markup(EVERYTHING);

  test("every node kind renders under its own `mf-vocab-<type>` anchor", () => {
    for (const kind of [
      "box",
      "heading",
      "text",
      "code",
      "badge",
      "divider",
      "spinner",
      "button",
      "select",
      "input",
      "toggle",
      "list",
      "empty",
    ]) {
      expect(html).toContain(`class="mf-vocab-${kind}`);
    }
    expect(html).toStartWith('<div class="mf-vocab">');
  });

  test("a button with an action names the door it opens; one without carries no marker", () => {
    expect(html).toContain('data-action="acme.notes.save"');
    expect(html).toContain('data-tone="accent"');
    expect(html.match(/data-action=/g)).toHaveLength(1);
    expect(html).toContain('class="mf-vocab-button" disabled="">Later</button>');
  });

  test("box, heading, text and code carry their declared shape", () => {
    expect(html).toContain(
      '<div class="mf-vocab-box is-grow is-wrap" data-direction="row" data-gap="2">',
    );
    expect(html).toContain('<h1 class="mf-vocab-heading" data-level="1">Notes</h1>');
    expect(html).toContain('<span class="mf-vocab-text">plain</span>');
    expect(html).toContain(
      '<span class="mf-vocab-text is-mono is-wrap" data-tone="muted">mono</span>',
    );
    expect(html).toContain('<pre class="mf-vocab-code">const x = 1;\nx;</pre>');
    expect(html).toContain('<span class="mf-vocab-badge" data-tone="success">3 open</span>');
    expect(html).toContain('<hr class="mf-vocab-divider"/>');
    expect(html).toContain("Syncing");
  });

  test("the controls show the tree's value: selected option, field value, checked toggle", () => {
    expect(html).toContain('<option value="b" selected="">B</option>');
    expect(html).toContain('<option value="" selected=""></option><option value="a">A</option>');
    expect(html).toContain('class="mf-vocab-input is-mono" placeholder="Say…" value="draft"/>');
    expect(html).toContain(
      'type="checkbox" class="mf-vocab-toggle__control" disabled="" checked=""/>',
    );
    expect(html).toContain('<span class="mf-vocab-toggle__label">Pinned</span>');
  });

  test("a list row with an event is a button, one without is a reading", () => {
    expect(html).toContain('<button type="button" class="mf-vocab-list__row is-pressable">');
    expect(html).toContain(
      '<li class="mf-vocab-list__item" data-tone="danger"><div class="mf-vocab-list__row">',
    );
    expect(html).toContain('<span class="mf-vocab-list__secondary">one</span>');
  });

  test("text reaches the DOM as text, never as markup", () => {
    const hostile = markup({ type: "text", text: '<img src=x onerror="alert(1)">' });
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img");
  });

  test("the host's tone paints the whole tree and makes it an alert", () => {
    expect(markup({ type: "empty", text: "worker gone" }, "danger")).toBe(
      '<div class="mf-vocab" data-tone="danger" role="alert">' +
        '<p class="mf-vocab-empty">worker gone</p></div>',
    );
  });
});

describe("VocabularyRenderer posts one named event per gesture", () => {
  interface Pressed {
    readonly events: [string, unknown][];
    readonly painted: readonly Painted[];
  }

  function pressed(): Pressed {
    const events: [string, unknown][] = [];
    const painted = paint(
      <VocabularyRenderer
        tree={EVERYTHING}
        onEvent={(event, payload) => events.push([event, payload])}
      />,
    );
    return { events, painted };
  }

  test("button → its event and payload", () => {
    const { events, painted } = pressed();
    const buttons = findAll(painted, "mf-vocab-button");
    fire(buttons[0] ?? null, "onClick");
    expect(events).toEqual([["save", undefined]]);
    expect(buttons[1]?.props["disabled"]).toBe(true);
  });

  test("select → its event with the chosen value", () => {
    const { events, painted } = pressed();
    fire(find(painted, "mf-vocab-select"), "onChange", { value: "a" });
    expect(events).toEqual([["pick", "a"]]);
  });

  test("input → its event with the typed text, on every change", () => {
    const { events, painted } = pressed();
    fire(find(painted, "mf-vocab-input"), "onChange", { value: "draft!" });
    fire(find(painted, "mf-vocab-input"), "onChange", { value: "draft!?" });
    expect(events).toEqual([
      ["typed", "draft!"],
      ["typed", "draft!?"],
    ]);
  });

  test("input: the tree's value lands on blur, and on a render only while unfocused", () => {
    const { painted } = pressed();
    const input = find(painted, "mf-vocab-input");
    const field = { value: "typed", ownerDocument: { activeElement: null as unknown } };
    fire(input, "onBlur", field);
    expect(field.value).toBe("draft");

    field.value = "typing";
    field.ownerDocument.activeElement = field;
    const ref = input?.props["ref"];
    if (typeof ref !== "function") throw new Error("ref is not wired");
    ref(field);
    expect(field.value).toBe("typing");
    field.ownerDocument.activeElement = null;
    ref(field);
    expect(field.value).toBe("draft");
  });

  test("toggle → its event with the new boolean", () => {
    const { events, painted } = pressed();
    fire(find(painted, "mf-vocab-toggle__control"), "onChange", { checked: false });
    expect(events).toEqual([["flip", false]]);
  });

  test("list row → its event with its payload; a row without one has nothing to press", () => {
    const { events, painted } = pressed();
    const rows = findAll(painted, "mf-vocab-list__row");
    fire(rows[0] ?? null, "onClick");
    expect(events).toEqual([["open", { id: 1 }]]);
    expect(rows[1]?.tag).toBe("div");
    expect(rows[1]?.props["onClick"]).toBeUndefined();
  });
});
