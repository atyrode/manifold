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
 * A fresh single-line note's height, and therefore the floor a grown or shrunk one may never
 * cross. It repeats the engine's own creation default because a plugin may not import web
 * floor modules (REGISTRY.md §Foundation import boundary), and the canvas's authoring default
 * moves here with `core.canvas`.
 */
const MIN_NOTE_HEIGHT = 48;

/**
 * The border the editor draws around itself, on top of the content it measures: a textarea's
 * `scrollHeight` reports content plus padding only — never a border, whatever the box-sizing —
 * so a height patched straight from it would sit one border short of the box the editor is
 * actually occupying. Matches `.canvas-text__editor`'s `border: 1px solid` (top and bottom).
 */
const EDITOR_BORDER_INSET = 2;

/**
 * THE commit policy behind a note's height, and the only sizing derivation this plugin owns.
 *
 * It used to re-derive a height from the text alone — counting `\n` characters and assuming a
 * fixed line height — which agreed with itself while the author never wrapped a line, and
 * silently under-sized the box the moment one did: `overflow-wrap: anywhere` breaks a line
 * wherever the box's width demands it, a fact this module cannot know without either
 * duplicating the engine's frame width (a box this file is deliberately never handed,
 * `ElementProps`'s own contract) or a second, approximate flavor of the same measurement the
 * browser already performs for free.
 *
 * So there is exactly one measurement: the editing textarea's own `scrollHeight`, read live as
 * the author types (below), in the SAME font the committed, non-editing render uses
 * (`.canvas-text__editor` inherits it explicitly rather than falling back to the browser's
 * form-control default) — so wrapping the editor measures is wrapping the render repaints.
 * This function's only remaining job is the floor every note shares: a fresh or emptied one is
 * still a target you can click into.
 */
export function noteHeightFor(measuredHeight: number): number {
  return Math.max(MIN_NOTE_HEIGHT, measuredHeight);
}

/**
 * The editor's true intrinsic content height, independent of whatever size it happens to be
 * painted at right now.
 *
 * `scrollHeight` only exceeds the box's current height when the content no longer fits it —
 * a box that just SHRANK (a paragraph trimmed back to one line) is, at the instant of that
 * edit, still exactly the size the previous measurement committed, so a naive read echoes
 * that stale size back and the note could grow but never shrink. Collapsing the height to
 * zero for the read (restored before anything else can observe it, so there is nothing to
 * repaint) forces the browser to report the content's real requirement either way.
 */
function measureContentHeight(editor: HTMLTextAreaElement): number {
  const restore = editor.style.height;
  editor.style.height = "0px";
  const measured = editor.scrollHeight;
  editor.style.height = restore;
  return measured;
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

  /*
    The editor's own box on ENTRY to a session, corrected once against what its content
    actually needs: a note authored by an older client (the newline-counting formula this
    file used to carry) or resized narrower since its last edit both leave a stale `height`
    behind that no keystroke is coming to fix. `onChange` below keeps it honest while typing;
    this is the same measurement, taken once at mount, so opening an existing note's editor is
    never the first time its box gets to disagree with its content.
  */
  useEffect(() => {
    if (!editing) return;
    const editor = editorRef.current;
    if (editor === null) return;
    host.doc.transact((tx) => {
      tx.patch(id, { height: noteHeightFor(measureContentHeight(editor) + EDITOR_BORDER_INSET) });
    });
    // Document and element identity are stable within an editing session. The whole host
    // is rebuilt after scene changes, including this patch, so it is not a dependency.
  }, [editing, host.doc, id]);

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
          const editor = event.currentTarget;
          const next = editor.value;
          const cursor = editor.selectionStart ?? next.length;
          const diff = diffText(ytext.toString(), next, cursor);
          const measuredHeight = measureContentHeight(editor) + EDITOR_BORDER_INSET;
          host.doc.transact((tx) => {
            const current = tx.text(id);
            if (current === null) return;
            if (diff.remove > 0) current.delete(diff.index, diff.remove);
            if (diff.insert !== "") current.insert(diff.index, diff.insert);
            tx.patch(id, { height: noteHeightFor(measuredHeight) });
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
