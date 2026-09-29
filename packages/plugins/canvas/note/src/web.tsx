import "./styles.css";
import type { ElementProps } from "@manifold/plugin";
import {
  ElementOutlet,
  useElementHost,
  type PointTool,
  type PointToolContext,
  type PointToolOutcome,
} from "@manifold/plugin/hooks";
import { memo, useLayoutEffect, useRef, type ReactElement } from "react";

const NOTE_WIDTH = 240;
const NOTE_HEIGHT = 48;
const NOTE_FONT_SIZE = 20;

async function createNoteAt({
  client,
  containerId,
  point,
  principal,
  signal,
}: PointToolContext): Promise<PointToolOutcome> {
  const elementId = crypto.randomUUID();
  const outcome = await client.action("core.text.create", {
    home: { kind: "container", containerId },
    documentId: elementId,
    reference: false,
  });
  if (!outcome.ok) return { ok: false, reason: outcome.denial.message };
  const result = outcome.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("reference" in result) ||
    typeof result.reference !== "string"
  ) {
    throw new Error("Text creation returned no document reference");
  }
  // The body is already an independent document. A retired gesture must not add a late note.
  if (signal.aborted) return { ok: false, reason: "Note creation cancelled" };
  if (client.status !== "open" || !client.sceneWriteAllowed) {
    return { ok: false, reason: "The document was created, but this canvas is no longer writable" };
  }
  const reference = result.reference;
  client.transact((tx) =>
    tx.create({
      id: elementId,
      type: "canvas_note",
      document: reference,
      x: point.x,
      y: point.y,
      width: NOTE_WIDTH,
      height: NOTE_HEIGHT,
      zIndex: tx.nextZIndex(),
      fontSize: NOTE_FONT_SIZE,
      color: principal.color,
    }),
  );
  return { ok: true, elementId };
}

const textTool: PointTool = { doubleClick: true, createAt: createNoteAt };

function CanvasNoteImpl({ id, data }: ElementProps): ReactElement {
  const host = useElementHost();
  const content = useRef<HTMLDivElement>(null);
  const editing = host.editingElementId === id;
  useLayoutEffect(() => {
    const node = content.current;
    if (!editing || node === null) return;
    let previousHeight: number | null = null;
    const measure = (): void => {
      if (host.doc.spectator || host.doc.status !== "open" || !host.doc.sceneWriteAllowed) return;
      // offsetHeight is in unscaled CSS pixels, unlike the canvas-transformed bounding rect.
      const height = Math.max(NOTE_HEIGHT, node.offsetHeight);
      if (height === previousHeight) return;
      previousHeight = height;
      host.doc.transact((tx) => tx.patch(id, { height }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [editing, host.doc, id]);

  return (
    <div className="canvas-note nowheel">
      <div className="canvas-note__content" ref={content}>
        <ElementOutlet
          type="text"
          elementId={id}
          data={{ ...data, fitContent: true }}
          doc={host.doc}
          editingElementId={host.editingElementId}
          onBeginEditing={host.beginEditing}
          onEndEditing={host.endEditing}
          removeWhenEmpty={false}
        />
      </div>
    </div>
  );
}

const CanvasNote = memo(CanvasNoteImpl);

export const canvasNoteWeb = {
  id: "core.canvas.note",
  elements: { canvas_note: CanvasNote },
  tools: { text: { shortcut: "t", point: textTool } },
};
