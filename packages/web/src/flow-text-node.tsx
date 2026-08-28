import { LOCAL_ORIGIN } from "@manifold/scene";
import type { NodeProps } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { useFlowPad } from "./flow-terminal-node.tsx";
import { textHeightFor } from "./flow-scene.ts";
import { diffText } from "./text-diff.ts";

export function TextNode({ id, data }: NodeProps): React.ReactElement {
  const pad = useFlowPad();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const text = typeof data["text"] === "string" ? data["text"] : "";
  const fontSize = typeof data["fontSize"] === "number" ? data["fontSize"] : 20;
  const color = typeof data["color"] === "string" ? data["color"] : "#f8f9fa";
  const ytext = pad.client.elementText(id);
  const editing = pad.editingId === id;

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
    pad.endTextEditing(id);
    if (pad.client.elementText(id)?.toString() === "") {
      pad.client.transact((tx) => tx.remove(id));
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
          pad.client.transact((tx) => {
            const current = tx.text(id);
            if (current === null) return;
            if (diff.remove > 0) current.delete(diff.index, diff.remove);
            if (diff.insert !== "") current.insert(diff.index, diff.insert);
            tx.patch(id, { height: textHeightFor(next, fontSize) });
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
        pad.beginTextEditing(id);
      }}
    >
      {text}
    </div>
  );
}
