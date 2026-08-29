import { LOCAL_ORIGIN } from "@manifold/scene";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, type ReactElement } from "react";
import { useFlowPad } from "./flow-terminal-node.tsx";
import { textHeightFor } from "./flow-scene.ts";
import { diffText } from "./text-diff.ts";

/** Text stays editable at any size, but must not collapse to an unclickable sliver. */
export const MIN_TEXT_WIDTH = 80;
export const MIN_TEXT_HEIGHT = 32;

export interface TextSurfaceProps {
  /** The room owning the element: a canvas, or the composition a note was tiled into. */
  readonly client: SessionClient;
  readonly elementId: string;
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly editing: boolean;
  readonly onBeginEditing: () => void;
  readonly onEndEditing: () => void;
  /**
   * Whether emptying the note deletes it. True on a canvas, where an empty note is
   * invisible litter; false in a tile, where the element is the leaf's occupant and
   * deleting it would strand the leaf.
   */
  readonly removeWhenEmpty: boolean;
}

/**
 * A note, wherever it is placed. Notes are `tileable` as of this wave, so this component
 * is deliberately independent of React Flow: a canvas wraps it in a node (with resize
 * handles), a composition renders it straight into a tile leaf, and both edit the SAME
 * `Y.Text` through the room they are joined to — so a note tiled into a composition is
 * collaborative there for exactly the same reason it was on the canvas.
 */
export function TextSurface({
  client,
  elementId,
  text,
  fontSize,
  color,
  editing,
  onBeginEditing,
  onEndEditing,
  removeWhenEmpty,
}: TextSurfaceProps): ReactElement {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const ytext = client.elementText(elementId);

  useEffect(() => {
    if (!editing || ytext === null) return;
    const updateFromRemote = (event: {
      readonly transaction: { readonly origin: unknown };
    }): void => {
      if (event.transaction.origin === LOCAL_ORIGIN) return;
      const editor = editorRef.current;
      if (editor === null) return;
      const value = ytext.toString();
      if (editor.value === value) return;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = value;
      editor.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
    };
    ytext.observe(updateFromRemote);
    return () => ytext.unobserve(updateFromRemote);
  }, [editing, ytext]);

  const finishEditing = (): void => {
    onEndEditing();
    if (!removeWhenEmpty) return;
    if (client.elementText(elementId)?.toString() === "") {
      client.transact((tx) => tx.remove(elementId));
    }
  };

  if (editing) {
    return (
      <textarea
        ref={editorRef}
        className="flow-text__editor nodrag nowheel"
        autoFocus
        defaultValue={ytext?.toString() ?? text}
        style={{ color, fontSize }}
        onBlur={finishEditing}
        onChange={(event) => {
          if (ytext === null) return;
          const next = event.currentTarget.value;
          const cursor = event.currentTarget.selectionStart ?? next.length;
          const diff = diffText(ytext.toString(), next, cursor);
          client.transact((tx) => {
            const current = tx.text(elementId);
            if (current === null) return;
            if (diff.remove > 0) current.delete(diff.index, diff.remove);
            if (diff.insert !== "") current.insert(diff.index, diff.insert);
            tx.patch(elementId, { height: textHeightFor(next, fontSize) });
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          finishEditing();
        }}
      />
    );
  }

  return (
    <div
      className="flow-text"
      style={{ color, fontSize }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onBeginEditing();
      }}
    >
      {text}
    </div>
  );
}

function TextNodeImpl({ id, data, selected }: NodeProps): ReactElement {
  const pad = useFlowPad();
  const text = typeof data["text"] === "string" ? data["text"] : "";
  const fontSize = typeof data["fontSize"] === "number" ? data["fontSize"] : 20;
  const color = typeof data["color"] === "string" ? data["color"] : "#f8f9fa";
  const editing = pad.editingId === id;

  if (editing) {
    return (
      <TextSurface
        client={pad.client}
        elementId={id}
        text={text}
        fontSize={fontSize}
        color={color}
        editing
        onBeginEditing={() => pad.beginTextEditing(id)}
        onEndEditing={() => pad.endTextEditing(id)}
        removeWhenEmpty
      />
    );
  }

  return (
    <>
      {/* Ink and text keep the classic bounding-box handles; only terminals grab by border. */}
      <NodeResizer
        nodeId={id}
        isVisible={pad.tool === "select" && selected === true}
        minWidth={MIN_TEXT_WIDTH}
        minHeight={MIN_TEXT_HEIGHT}
        onResize={(_event, params) =>
          pad.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          pad.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      <TextSurface
        client={pad.client}
        elementId={id}
        text={text}
        fontSize={fontSize}
        color={color}
        editing={false}
        onBeginEditing={() => pad.beginTextEditing(id)}
        onEndEditing={() => pad.endTextEditing(id)}
        removeWhenEmpty
      />
    </>
  );
}

/**
 * Memoized for the same reason as `TerminalNode`: React Flow's node wrapper re-invokes its
 * node component on every drag frame, and none of these props move with the pointer.
 */
export const TextNode = memo(TextNodeImpl);
