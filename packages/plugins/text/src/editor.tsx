import { defaultKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";
import { MAX_TEXT_LENGTH } from "@manifold/protocol";
import { Y } from "@manifold/scene";
import { useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import { applyTextHistory, type TextHistoryDirection } from "./history.ts";

const lengthRefusal = StateEffect.define<boolean>();
const refusedLength = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(lengthRefusal)) return effect.value;
    }
    return transaction.docChanged ? false : value;
  },
});

/** Reject the entire edit, never a prefix. Remote updates belong to room validation. */
const textLimit = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || transaction.annotation(ySyncAnnotation) !== undefined) {
    return transaction;
  }
  if (transaction.startState.readOnly) return [];
  if (transaction.newDoc.length > MAX_TEXT_LENGTH) {
    return { effects: lengthRefusal.of(true) };
  }
  return transaction;
});

interface TextEditorProps {
  readonly text: Y.Text;
  readonly canWrite: boolean;
  readonly editing: boolean;
  readonly fitContent?: boolean;
  readonly fontSize?: number;
  readonly color?: string;
  readonly onBeginEditing?: () => void;
  readonly onEndEditing?: () => void;
}

/** The sole editor, shared by the standalone surface and every borrowed representation. */
export function TextEditor(props: TextEditorProps): ReactElement {
  const { text, canWrite, editing, fitContent = false, fontSize = 20, color } = props;
  const mount = useRef<HTMLDivElement>(null);
  const binding = useRef<{ view: EditorView; configuration: Compartment } | null>(null);
  const callbacks = useRef(props);
  const messageId = useId();
  const [status, setStatus] = useState<{ text: Y.Text; length: number; refused: boolean } | null>(null);
  const length = status?.text === text ? status.length : text.length;
  const refused = status?.text === text && status.refused;

  useLayoutEffect(() => {
    callbacks.current = props;
  });

  useLayoutEffect(() => {
    const parent = mount.current;
    if (parent === null) return;
    // Only this binding's origin is added by yCollab. Neither remote nor SDK edits enter it.
    const history = new Y.UndoManager(text, { trackedOrigins: new Set() });
    const configuration = new Compartment();
    const performHistory = (direction: TextHistoryDirection, editor: EditorView): boolean => {
      const outcome = applyTextHistory(text, history, direction, editor.state.readOnly);
      if (outcome === "limit") editor.dispatch({ effects: lengthRefusal.of(true) });
      return true;
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          configuration.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(true),
          drawSelection(),
          dropCursor(),
          // Keep retained CR characters addressable: Y.Text positions are UTF-16 offsets.
          EditorState.lineSeparator.of("\n"),
          refusedLength,
          textLimit,
          // Upstream native history events act directly on Yjs, so gate them before yCollab.
          Prec.highest(EditorView.domEventHandlers({
            beforeinput(event, editor) {
              if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
              event.preventDefault();
              return performHistory(event.inputType === "historyUndo" ? "undo" : "redo", editor);
            },
            focus() {
              callbacks.current.onBeginEditing?.();
              return false;
            },
            blur() {
              history.stopCapturing();
              callbacks.current.onEndEditing?.();
              return false;
            },
            keydown(event) {
              if (event.key !== "Escape" || event.isComposing) return false;
              callbacks.current.onEndEditing?.();
              event.preventDefault();
              event.stopPropagation();
              return true;
            },
          })),
          keymap.of([
            { key: "Mod-z", run: (editor) => performHistory("undo", editor), preventDefault: true },
            { key: "Mod-y", mac: "Mod-Shift-z", run: (editor) => performHistory("redo", editor), preventDefault: true },
            { key: "Mod-Shift-z", run: (editor) => performHistory("redo", editor), preventDefault: true },
            ...defaultKeymap,
          ]),
          yCollab(text, null, { undoManager: history }),
          EditorView.updateListener.of((update) => {
            const nextRefusal = update.state.field(refusedLength);
            if (update.docChanged || nextRefusal !== update.startState.field(refusedLength)) {
              setStatus({ text, length: update.state.doc.length, refused: nextRefusal });
            }
          }),
        ],
      }),
    });
    binding.current = { view, configuration };
    return () => {
      binding.current = null;
      view.destroy();
      history.destroy();
    };
  }, [text]);

  useLayoutEffect(() => {
    const current = binding.current;
    if (current === null) return;
    const writable = canWrite && editing;
    current.view.dispatch({
      effects: current.configuration.reconfigure([
        EditorState.readOnly.of(!writable),
        EditorView.editable.of(writable),
        EditorView.contentAttributes.of({
          "aria-label": "Document text",
          "aria-multiline": "true",
          "aria-readonly": String(!writable),
          "aria-describedby": messageId,
          role: "textbox",
          tabindex: "0",
          spellcheck: "true",
        }),
      ]),
    });
    if (writable) current.view.focus();
  }, [text, canWrite, editing, messageId]);

  return (
    <div
      className={`text-editor${fitContent ? " text-editor--fit" : ""}${editing ? " nodrag nowheel" : ""}`}
      style={{ fontSize, color }}
      data-text-editing={canWrite && editing}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (!editing && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          props.onBeginEditing?.();
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.onBeginEditing?.();
      }}
    >
      <div className="text-editor__mount" ref={mount} />
      <div className="text-editor__status" id={messageId} role={refused ? "alert" : "status"}>
        {refused
          ? `Edit refused: documents are limited to ${MAX_TEXT_LENGTH.toLocaleString()} UTF-16 units. Nothing was truncated.`
          : editing
            ? `${length.toLocaleString()} / ${MAX_TEXT_LENGTH.toLocaleString()}${canWrite ? "" : " · Read only"}`
            : ""}
      </div>
    </div>
  );
}
