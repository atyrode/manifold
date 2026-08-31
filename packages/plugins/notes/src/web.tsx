import "./styles.css";
import type { ElementProps } from "@manifold/plugin";
import { useElementHost } from "@manifold/plugin/hooks";
import { LOCAL_ORIGIN } from "@manifold/scene";
import { memo, useEffect, useRef, type ReactElement } from "react";
import { diffText } from "./text-diff.ts";

/**
 * The note renderer — `core.notes`'s browser half, and the same component wherever a note is
 * placed. A canvas paints it inside the engine's element frame (which owns the resize handles
 * and the selection rule); a composition paints it straight into a tile leaf. Both edit the
 * SAME `Y.Text` through the room they are joined to, which is why a note placed into a
 * composition is collaborative there for exactly the same reason it was on the canvas: the
 * document is the door, not this file.
 *
 * The mount site's disagreements arrive as `ElementHost` (editing focus, and whether an emptied
 * note is litter), so nothing here asks which ref it is on.
 */

/** Fallbacks match the engine's authoring defaults for a note written by an older client. */
const FALLBACK_FONT_SIZE = 20;
const FALLBACK_COLOR = "#f8f9fa";

/**
 * A fresh single-line note's height, and therefore the floor for a grown one. It repeats the
 * engine's own creation default because a plugin may not import web floor modules (REGISTRY.md
 * §Foundation import boundary) — and because how tall prose is IS this plugin's business: the
 * engine only needs a box to put a new element in, while the ratio below is the note's own
 * typography. The canvas's authoring default moves here with `core.canvas`.
 */
const MIN_NOTE_HEIGHT = 48;
const LINE_HEIGHT_RATIO = 1.4;
const VERTICAL_PADDING = 16;

export function noteHeightFor(text: string, fontSize: number): number {
  const lines = text.split("\n").length;
  return Math.max(MIN_NOTE_HEIGHT, lines * fontSize * LINE_HEIGHT_RATIO + VERTICAL_PADDING);
}

function NoteNodeImpl({ id, data }: ElementProps): ReactElement {
  const host = useElementHost();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const text = typeof data["text"] === "string" ? data["text"] : "";
  const fontSize = typeof data["fontSize"] === "number" ? data["fontSize"] : FALLBACK_FONT_SIZE;
  const color = typeof data["color"] === "string" ? data["color"] : FALLBACK_COLOR;
  const editing = host.editingElementId === id;
  const ytext = host.doc.elementText(id);

  /*
    While the editor is open the textarea — not the projected `data` — is the live view of the
    text, so a peer's keystrokes have to be written into the DOM node by hand, and the caret
    has to survive it. Skipping our OWN transactions is what keeps typing from fighting the
    round trip: the local edit is already in the element.
  */
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
    host.endEditing(id);
    if (!host.removeWhenEmpty) return;
    if (host.doc.elementText(id)?.toString() === "") {
      host.doc.transact((tx) => tx.remove(id));
    }
  };

  if (editing) {
    return (
      <textarea
        ref={editorRef}
        className="canvas-text__editor nodrag nowheel"
        autoFocus
        defaultValue={ytext?.toString() ?? text}
        style={{ color, fontSize }}
        onBlur={finishEditing}
        onChange={(event) => {
          if (ytext === null) return;
          const next = event.currentTarget.value;
          const cursor = event.currentTarget.selectionStart ?? next.length;
          const diff = diffText(ytext.toString(), next, cursor);
          host.doc.transact((tx) => {
            const current = tx.text(id);
            if (current === null) return;
            if (diff.remove > 0) current.delete(diff.index, diff.remove);
            if (diff.insert !== "") current.insert(diff.index, diff.insert);
            tx.patch(id, { height: noteHeightFor(next, fontSize) });
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
      className="canvas-text"
      style={{ color, fontSize }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        host.beginEditing(id);
      }}
    >
      {text}
    </div>
  );
}

/**
 * Memoized for the same reason every element renderer is: a canvas re-invokes its node
 * components on every drag frame of the canvas, and none of these props move with the pointer.
 */
export const NoteNode = memo(NoteNodeImpl);

/**
 * What this plugin registers in the browser, keyed by the wire type its manifest declared. It
 * is inert data: `packages/web/src/assembly.ts` is the one file that reads it, and the host
 * joins it against the server's roster before anything renders.
 */
export const notesWebPlugin = {
  id: "core.notes",
  elements: { text: NoteNode },
};
