import "./vocabulary.css";
import type { UiListItem, UiNode, UiTone } from "@manifold/protocol";
import type { ReactElement } from "react";

/**
 * THE COMPONENT VOCABULARY, PAINTED (ADR 0016 §3, R2). An isolated plugin describes its panel
 * as a tree of the protocol's thirteen node kinds and the engine paints every one of them into
 * ONE css family it owns (`mf-vocab`, REGISTRY.md §Lexicon cssFamilies): no plugin CSS, no
 * plugin DOM, no plugin event handler — a gesture on a control becomes `onEvent(name, payload)`,
 * which the panel forwards to the worker as an `event` frame. Text reaches the DOM as
 * `textContent` only, so nothing a guest writes is ever markup.
 *
 * One component per node kind, hook-free on purpose: the tree is the state. The three controls
 * are CONTROLLED BY THE TREE — `select` and `toggle` show the tree's value and post a change for
 * the worker to render back — with one documented exception. An `input` posts every keystroke
 * but keeps the DOM as its buffer while focused: a controlled field would revert to the tree's
 * value until the worker's echo arrived, which drops characters typed inside the round trip and
 * breaks composition (IME) outright. So the field is uncontrolled, the tree's value is written
 * into it on every render it is NOT focused for, and on blur — the worker's answer wins the
 * moment the reader stops typing, never while they are.
 *
 * Tones are the shell's own colours read back (`vocabulary.css`); keyboard focus and hover follow
 * the shell's row conventions; nothing animates.
 */

export interface VocabularyRendererProps {
  readonly tree: UiNode;
  /** A named callback fired by a control: the event the node declared and what it carried. */
  readonly onEvent: (event: string, payload?: unknown) => void;
  /**
   * A tone for the WHOLE tree, the host's own knob: the panel paints its fault state as a
   * danger-toned `empty` this way, since the protocol's `empty` carries no tone of its own.
   */
  readonly tone?: UiTone | undefined;
}

export function VocabularyRenderer({ tree, onEvent, tone }: VocabularyRendererProps): ReactElement {
  return (
    <div className="mf-vocab" data-tone={tone} role={tone === "danger" ? "alert" : undefined}>
      <Node node={tree} onEvent={onEvent} />
    </div>
  );
}

interface NodeProps<N extends UiNode = UiNode> {
  readonly node: N;
  readonly onEvent: VocabularyRendererProps["onEvent"];
}

type NodeOf<T extends UiNode["type"]> = Extract<UiNode, { readonly type: T }>;

/** Dispatches one node to its component; the `never` guard is what keeps the vocabulary closed. */
function Node({ node, onEvent }: NodeProps): ReactElement {
  switch (node.type) {
    case "box":
      return <BoxNode node={node} onEvent={onEvent} />;
    case "heading":
      return <HeadingNode node={node} />;
    case "text":
      return <TextNode node={node} />;
    case "code":
      return <CodeNode node={node} />;
    case "badge":
      return <BadgeNode node={node} />;
    case "divider":
      return <DividerNode />;
    case "spinner":
      return <SpinnerNode node={node} />;
    case "button":
      return <ButtonNode node={node} onEvent={onEvent} />;
    case "select":
      return <SelectNode node={node} onEvent={onEvent} />;
    case "input":
      return <InputNode node={node} onEvent={onEvent} />;
    case "toggle":
      return <ToggleNode node={node} onEvent={onEvent} />;
    case "list":
      return <ListNode node={node} onEvent={onEvent} />;
    case "empty":
      return <EmptyNode node={node} />;
    default: {
      const unreachable: never = node;
      throw new Error(`unknown vocabulary node ${String(unreachable)}`);
    }
  }
}

/**
 * The anchor plus the shell's `is-<flag>` state class for every flag that is on
 * (`.sidebar-row.is-editing`): the anchor names the family for S13, a flag qualifies it and
 * registers nothing.
 */
function anchored(anchor: string, flags: Readonly<Record<string, boolean | undefined>>): string {
  let className = anchor;
  for (const flag in flags) if (flags[flag] === true) className += ` is-${flag}`;
  return className;
}

function BoxNode({ node, onEvent }: NodeProps<NodeOf<"box">>): ReactElement {
  return (
    <div
      className={anchored("mf-vocab-box", { grow: node.grow, wrap: node.wrap })}
      data-direction={node.direction ?? "column"}
      data-gap={node.gap ?? 1}
    >
      {node.children.map((child, index) => (
        <Node key={index} node={child} onEvent={onEvent} />
      ))}
    </div>
  );
}

function HeadingNode({ node }: { readonly node: NodeOf<"heading"> }): ReactElement {
  const level = node.level ?? 2;
  const Tag = `h${level}` as const;
  return (
    <Tag className="mf-vocab-heading" data-level={level}>
      {node.text}
    </Tag>
  );
}

function TextNode({ node }: { readonly node: NodeOf<"text"> }): ReactElement {
  return (
    <span
      className={anchored("mf-vocab-text", { mono: node.mono, wrap: node.wrap })}
      data-tone={node.tone}
    >
      {node.text}
    </span>
  );
}

function CodeNode({ node }: { readonly node: NodeOf<"code"> }): ReactElement {
  return <pre className="mf-vocab-code">{node.text}</pre>;
}

function BadgeNode({ node }: { readonly node: NodeOf<"badge"> }): ReactElement {
  return (
    <span className="mf-vocab-badge" data-tone={node.tone}>
      {node.text}
    </span>
  );
}

function DividerNode(): ReactElement {
  return <hr className="mf-vocab-divider" />;
}

function SpinnerNode({ node }: { readonly node: NodeOf<"spinner"> }): ReactElement {
  return (
    <div className="mf-vocab-spinner" role="status" aria-live="polite">
      <span className="mf-vocab-spinner__mark" aria-hidden="true" />
      <span className="mf-vocab-spinner__label">{node.label ?? "Loading"}</span>
    </div>
  );
}

/**
 * `data-action` is the FULL action name the button's event ultimately dispatches, painted so a
 * stranger's affordance names the door it opens exactly as a first-party one does (invariant
 * 12, S4); absent when the guest declared none.
 */
function ButtonNode({ node, onEvent }: NodeProps<NodeOf<"button">>): ReactElement {
  return (
    <button
      type="button"
      className="mf-vocab-button"
      data-tone={node.tone}
      data-action={node.action}
      disabled={node.disabled === true}
      onClick={() => onEvent(node.event, node.payload)}
    >
      {node.label}
    </button>
  );
}

/** `value: null` is "nothing chosen yet": an empty option holds the seat so the tree can say so. */
function SelectNode({ node, onEvent }: NodeProps<NodeOf<"select">>): ReactElement {
  const control = (
    <select
      className="mf-vocab-select"
      value={node.value ?? ""}
      disabled={node.disabled === true}
      onChange={(event) => onEvent(node.event, event.currentTarget.value)}
    >
      {node.value === null ? <option value="" /> : null}
      {node.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (node.label === undefined) return control;
  return (
    <label className="mf-vocab-select__field">
      <span className="mf-vocab-select__label">{node.label}</span>
      {control}
    </label>
  );
}

function InputNode({ node, onEvent }: NodeProps<NodeOf<"input">>): ReactElement {
  const { value } = node;
  const control = (
    <input
      type="text"
      className={anchored("mf-vocab-input", { mono: node.mono })}
      defaultValue={value}
      placeholder={node.placeholder}
      disabled={node.disabled === true}
      /*
        The buffer discipline described at the top of the file: this callback runs on every
        commit (it is a fresh closure each render), so a tree value that arrived while the field
        was not being typed into lands in the DOM; one that arrived mid-typing waits for the blur.
      */
      ref={(element) => {
        if (element !== null && element.ownerDocument.activeElement !== element) {
          element.value = value;
        }
      }}
      onChange={(event) => onEvent(node.event, event.currentTarget.value)}
      onBlur={(event) => {
        event.currentTarget.value = value;
      }}
    />
  );
  if (node.label === undefined) return control;
  return (
    <label className="mf-vocab-input__field">
      <span className="mf-vocab-input__label">{node.label}</span>
      {control}
    </label>
  );
}

function ToggleNode({ node, onEvent }: NodeProps<NodeOf<"toggle">>): ReactElement {
  return (
    <label className="mf-vocab-toggle">
      <input
        type="checkbox"
        className="mf-vocab-toggle__control"
        checked={node.value}
        disabled={node.disabled === true}
        onChange={(event) => onEvent(node.event, event.currentTarget.checked)}
      />
      <span className="mf-vocab-toggle__label">{node.label}</span>
    </label>
  );
}

interface ListItemProps {
  readonly item: UiListItem;
  readonly onEvent: VocabularyRendererProps["onEvent"];
}

/** A row with an `event` is a button; one without is a reading. One shape, so a list reads evenly. */
function ListItem({ item, onEvent }: ListItemProps): ReactElement {
  const body = (
    <>
      <span className="mf-vocab-list__primary">{item.primary}</span>
      {item.secondary === undefined ? null : (
        <span className="mf-vocab-list__secondary">{item.secondary}</span>
      )}
    </>
  );
  const { event } = item;
  return (
    <li className="mf-vocab-list__item" data-tone={item.tone}>
      {event === undefined ? (
        <div className="mf-vocab-list__row">{body}</div>
      ) : (
        <button
          type="button"
          className="mf-vocab-list__row is-pressable"
          onClick={() => onEvent(event, item.payload)}
        >
          {body}
        </button>
      )}
    </li>
  );
}

function ListNode({ node, onEvent }: NodeProps<NodeOf<"list">>): ReactElement {
  return (
    <ul className="mf-vocab-list">
      {node.items.map((item) => (
        <ListItem key={item.key} item={item} onEvent={onEvent} />
      ))}
    </ul>
  );
}

function EmptyNode({ node }: { readonly node: NodeOf<"empty"> }): ReactElement {
  return <p className="mf-vocab-empty">{node.text}</p>;
}
