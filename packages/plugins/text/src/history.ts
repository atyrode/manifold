import { MAX_TEXT_LENGTH } from "@manifold/protocol";
import { Y } from "@manifold/scene";

export type TextHistoryDirection = "undo" | "redo";
export type TextHistoryOutcome = "applied" | "empty" | "read-only" | "limit";
type HistoryStack = Y.UndoManager["undoStack"];
type HistoryItem = HistoryStack[number];

function copyDeletionSet(source: HistoryItem["deletions"]): HistoryItem["deletions"] {
  const copy = Y.createDeleteSet();
  for (const [client, ranges] of source.clients) {
    copy.clients.set(client, ranges.map(({ clock, len }) => ({ clock, len })));
  }
  return copy;
}

function copyStack(stack: HistoryStack): HistoryStack {
  return stack.map((item) => ({
    deletions: copyDeletionSet(item.deletions),
    insertions: copyDeletionSet(item.insertions),
    // Selection metadata contains live views; the length oracle neither needs nor shares it.
    meta: new Map<unknown, unknown>(),
  }));
}

/**
 * Yjs 13.6.32 keeps redo links only in the local replica, not in its encoded update.
 * Restore those links and their struct boundaries in the DISPOSABLE replica; otherwise an
 * older undo step can miss a redone insertion and predict an extra character incorrectly.
 * These are pinned, public Yjs exports/properties, not an implementation of undo itself.
 */
function copyRedoLinks(source: Y.Doc, copy: Y.Doc): void {
  copy.transact((transaction) => {
    for (const structs of source.store.clients.values()) {
      for (const item of structs) {
        if (!(item instanceof Y.Item) || item.redone === null) continue;
        const copiedItem = Y.getItemCleanStart(transaction, item.id);
        Y.getItemCleanEnd(transaction, copy.store, Y.createID(item.id.client, item.id.clock + item.length - 1));
        copiedItem.redone = Y.createID(item.redone.client, item.redone.clock);
      }
    }
  });
}

function previewHistoryLength(text: Y.Text, history: Y.UndoManager, direction: TextHistoryDirection): number {
  const copy = new Y.Doc({ gc: false });
  let preview: Y.UndoManager | null = null;
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(history.doc));
    copy.clientID = history.doc.clientID;
    copyRedoLinks(history.doc, copy);
    const position = Y.createRelativePositionFromTypeIndex(text, 0);
    // A root shared type is abstract after decoding until its owning API names its type.
    if (position.tname !== null) copy.getText(position.tname);
    const copiedText = Y.createAbsolutePositionFromRelativePosition(position, copy)?.type;
    if (!(copiedText instanceof Y.Text)) throw new Error("Cannot preview retired text history");
    preview = new Y.UndoManager(copiedText, {
      trackedOrigins: new Set(),
      deleteFilter: history.deleteFilter,
      ignoreRemoteMapChanges: history.ignoreRemoteMapChanges,
    });
    preview.undoStack = copyStack(history.undoStack);
    preview.redoStack = copyStack(history.redoStack);
    // Let upstream pop every skipped no-op entry, follow redo links and resolve remote edits.
    preview[direction]();
    return copiedText.length;
  } finally {
    preview?.destroy();
    copy.destroy();
  }
}

/**
 * The editor's sole history door. Read-only and overlength refusals leave live text,
 * stack entries and selection metadata untouched. The preview is synchronous and disposable,
 * never a second maintained history or provider.
 */
export function applyTextHistory(
  text: Y.Text,
  history: Y.UndoManager,
  direction: TextHistoryDirection,
  readOnly: boolean,
): TextHistoryOutcome {
  if (readOnly) return "read-only";
  const stack = direction === "undo" ? history.undoStack : history.redoStack;
  if (stack.length === 0) return "empty";
  const available = MAX_TEXT_LENGTH - text.length;
  let needsPreview = available < 0;
  // At most one effective entry is popped, but any number of no-ops may precede it.
  // Every restored UTF-16 unit costs at least one deletion-range clock. This upper bound
  // counts even formatting/unrelated structs, so uncertainty can only trigger a preview.
  for (const item of stack) {
    let growthBound = 0;
    for (const ranges of item.deletions.clients.values()) {
      for (const range of ranges) growthBound += range.len;
    }
    if (growthBound > available) {
      needsPreview = true;
      break;
    }
  }
  if (needsPreview && previewHistoryLength(text, history, direction) > MAX_TEXT_LENGTH) {
    return "limit";
  }
  return history[direction]() === null ? "empty" : "applied";
}
