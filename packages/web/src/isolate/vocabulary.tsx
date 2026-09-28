import type { UiIcon, UiNode, UiTone } from "@manifold/protocol";
import {
  Badge,
  Button,
  Cluster,
  Code,
  ControlIcon,
  Divider,
  Empty,
  Heading,
  Input,
  ItemIcon,
  List,
  Select,
  Spinner,
  Stack,
  Text,
  Toggle,
  type VocabularyMeta,
} from "@manifold/ui";
import type { ReactElement } from "react";

/**
 * THE COMPONENT VOCABULARY, PAINTED (ADR 0016 §3, R2; ADR 0053). A hardened plugin's Worker
 * describes its panel or section as a tree of the protocol's node kinds, and the engine
 * paints every one of them with the design system's own vocabulary components
 * (`@manifold/ui`, the `mf-vocab` family) — the SAME components a portable plugin rendered in
 * the page uses, so the two modes cannot drift and no control's semantics are written twice.
 * No plugin CSS, no plugin DOM, no plugin event handler: a gesture on a control becomes
 * `onEvent(name, payload)`, which the host forwards to the Worker as an `event` frame. Text
 * reaches the DOM as `textContent` only, so nothing a guest writes is ever markup.
 *
 * What this module still owns is the part no component does: the host's frame around the
 * tree, the box node's legacy spacing steps and flags, and turning each node's named events
 * back into callbacks. Every node's `key` — the Worker renderer's stable identity for it — is
 * the React key its DOM is reconciled under, so a field keeps focus when siblings arrive.
 * The `input` kind keeps its focused-buffer discipline inside `Input`, where the page's own
 * fields get it too.
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
  /**
   * Where the tree is mounted. A `section` sits in the rail's own body, which already insets
   * and scrolls it; a `panel` (unset) gets the frame's own inset and scroll.
   */
  readonly kind?: "panel" | "section" | undefined;
}

export function VocabularyRenderer({
  tree,
  onEvent,
  tone,
  kind,
}: VocabularyRendererProps): ReactElement {
  return (
    <div
      className={kind === "section" ? "mf-vocab is-section" : "mf-vocab"}
      data-tone={tone}
      role={tone === "danger" ? "alert" : undefined}
    >
      <Node node={tree} onEvent={onEvent} />
    </div>
  );
}

interface NodeProps<N extends UiNode = UiNode> {
  readonly node: N;
  readonly onEvent: VocabularyRendererProps["onEvent"];
}

type NodeOf<T extends UiNode["type"]> = Extract<UiNode, { readonly type: T }>;

/** A node's presentation metadata, as the attributes the vocabulary components take. */
function metaOf(node: UiNode): VocabularyMeta {
  return {
    title: node.title,
    "aria-label": node.ariaLabel,
    "data-testid": node.testId,
    role: node.role,
  };
}

/** A blur listener only where the node asked for one, so an unwatched blur posts nothing. */
function blurOf(
  blurEvent: string | undefined,
  onEvent: VocabularyRendererProps["onEvent"],
): (() => void) | undefined {
  return blurEvent === undefined ? undefined : () => onEvent(blurEvent);
}

/** Dispatches one node to its component; the `never` guard is what keeps the vocabulary closed. */
function Node({ node, onEvent }: NodeProps): ReactElement {
  switch (node.type) {
    case "box":
      return <BoxNode node={node} onEvent={onEvent} />;
    case "heading":
      return (
        <Heading level={node.level} {...metaOf(node)}>
          {node.text}
        </Heading>
      );
    case "text":
      return (
        <Text
          tone={node.tone}
          mono={node.mono}
          wrap={node.wrap}
          strong={node.strong}
          grow={node.grow}
          {...metaOf(node)}
        >
          {node.text}
        </Text>
      );
    case "code":
      return <Code {...metaOf(node)}>{node.text}</Code>;
    case "badge":
      return (
        <Badge tone={node.tone} {...metaOf(node)}>
          {node.text}
        </Badge>
      );
    case "icon":
      return <IconNode icon={node.icon} />;
    case "divider":
      return <Divider {...metaOf(node)} />;
    case "spinner":
      return <Spinner label={node.label} {...metaOf(node)} />;
    case "button":
      return (
        <Button
          tone={node.tone}
          disabled={node.disabled}
          data-action={node.action}
          icon={node.icon}
          iconOnly={node.iconOnly}
          {...metaOf(node)}
          onClick={() => onEvent(node.event, node.payload)}
          onBlur={blurOf(node.blurEvent, onEvent)}
        >
          {node.label}
        </Button>
      );
    case "select":
      return (
        <Select
          value={node.value}
          options={node.options}
          label={node.label}
          disabled={node.disabled}
          {...metaOf(node)}
          onChange={(value) => onEvent(node.event, value)}
          onBlur={blurOf(node.blurEvent, onEvent)}
        />
      );
    case "input":
      return (
        <Input
          value={node.value}
          label={node.label}
          placeholder={node.placeholder}
          mono={node.mono}
          disabled={node.disabled}
          {...metaOf(node)}
          onChange={(value) => onEvent(node.event, value)}
          onBlur={blurOf(node.blurEvent, onEvent)}
        />
      );
    case "toggle":
      return (
        <Toggle
          value={node.value}
          label={node.label}
          disabled={node.disabled}
          {...metaOf(node)}
          onChange={(value) => onEvent(node.event, value)}
          onBlur={blurOf(node.blurEvent, onEvent)}
        />
      );
    case "list":
      return (
        <List
          {...metaOf(node)}
          items={node.items.map(({ key, primary, secondary, tone, event, payload }) => ({
            key,
            primary,
            secondary,
            tone,
            onClick: event === undefined ? undefined : () => onEvent(event, payload),
          }))}
        />
      );
    case "empty":
      return <Empty {...metaOf(node)}>{node.text}</Empty>;
    default: {
      const unreachable: never = node;
      throw new Error(`unknown vocabulary node ${String(unreachable)}`);
    }
  }
}

const LEGACY_GAPS = ["0", "0.25rem", "0.5rem", "1rem"] as const;

/**
 * Paint through the same layout primitives as the page. New roots explicitly name their
 * adaptive default; numeric/absent gaps and wrapping flags keep older guests' behavior.
 * Stable node keys preserve the DOM when siblings move; legacy nodes retain positional keys.
 */
function BoxNode({ node, onEvent }: NodeProps<NodeOf<"box">>): ReactElement {
  const { gapRem } = node;
  const gap =
    gapRem !== undefined
      ? `${String(gapRem)}rem`
      : node.gap === "adaptive"
        ? undefined
        : LEGACY_GAPS[node.gap ?? 1];
  const Layout = node.direction === "row" ? Cluster : Stack;
  return (
    <Layout
      className={`mf-vocab-box${node.grow === true ? " is-grow" : ""}${node.wrap === true ? " is-wrap" : ""}`}
      {...(gap === undefined ? {} : { gap })}
      align={node.align}
      data-direction={node.direction ?? "column"}
      data-gap={gapRem === undefined ? (node.gap ?? 1) : undefined}
      style={{
        flexWrap: node.wrap === true ? undefined : "nowrap",
        justifyContent: node.justify === "between" ? "space-between" : node.justify,
      }}
      {...metaOf(node)}
    >
      {node.children.map((child, index) => (
        <Node
          key={child.key === undefined ? index : `key:${child.key}`}
          node={child}
          onEvent={onEvent}
        />
      ))}
    </Layout>
  );
}

/**
 * A named glyph from the icon vocabulary's own tables: an item name this build has never
 * heard of wears the contributed-element fallback, and no drawing ever comes from the guest.
 */
function IconNode({ icon }: { readonly icon: UiIcon }): ReactElement {
  return icon.family === "control" ? (
    <ControlIcon kind={icon.name} size={icon.size} className="mf-vocab-icon" />
  ) : (
    <ItemIcon kind={icon.name} size={icon.size} className="mf-vocab-icon" />
  );
}
