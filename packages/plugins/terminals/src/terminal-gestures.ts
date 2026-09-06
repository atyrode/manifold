import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";

/** Browser gestures only; PTY authority remains in the terminal's onData subscriber. */
export function installTerminalGestures(
  terminal: Terminal,
  host: HTMLElement,
  readOnly: () => boolean,
  notice: (message: string) => void,
  preferences: () => {
    readonly copyOnSelect: boolean;
    readonly pasteOnRightClick: boolean;
  },
): () => void {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const activate = (event: MouseEvent, uri: string): void => {
    if (event.button !== 0 || !(event.ctrlKey || (isMac && event.metaKey))) return;
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    window.open(url.href, "_blank", "noopener,noreferrer");
  };
  // Both plain URLs and OSC 8 use the same activation policy. Keep xterm's
  // protocol filter as well: unsafe OSC targets must not become links at all.
  terminal.options.linkHandler = { activate, allowNonHttpProtocols: false };
  terminal.loadAddon(new WebLinksAddon(activate));

  let disposed = false;
  let dragging = false;
  let changedDuringDrag = false;
  let selectionVersion = 0;
  const copySelection = (): void => {
    if (!preferences().copyOnSelect) return;
    const text = terminal.getSelection();
    if (!text) return;
    const version = selectionVersion;
    const failed = (): void => {
      if (!disposed && preferences().copyOnSelect) {
        notice(
          "Could not copy terminal selection. Allow clipboard access in your browser, or press Ctrl+Shift+C (Cmd+C on Mac) to copy the retained selection.",
        );
      }
    };
    if (!navigator.clipboard?.writeText) {
      failed();
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      // A new drag invalidates the old copy even before xterm emits its final
      // selection change. Never erase a newer or still-unfinished selection.
      if (
        !disposed &&
        preferences().copyOnSelect &&
        !dragging &&
        version === selectionVersion &&
        terminal.getSelection() === text
      ) {
        terminal.clearSelection();
      }
    }, failed);
  };
  const selection = terminal.onSelectionChange(() => {
    selectionVersion++;
    if (dragging) changedDuringDrag = terminal.hasSelection();
    else copySelection();
  });
  const shouldPasteOnRightClick = (event: MouseEvent): boolean =>
    preferences().pasteOnRightClick &&
    !event.shiftKey &&
    terminal.modes.mouseTrackingMode === "none";
  const mouseDown = (event: MouseEvent): void => {
    // Firefox runs xterm's native right-click word selection on mousedown.
    // Suppress it only when this gesture will paste; otherwise keep platform defaults.
    if (event.button === 2 && shouldPasteOnRightClick(event)) {
      event.stopPropagation();
      return;
    }
    if (event.button !== 0) return;
    selectionVersion++;
    dragging = true;
    changedDuringDrag = false;
  };
  // xterm emits completed mouse selections from its document mouseup handler.
  // Observe at window bubble phase, after that handler, including outside release.
  const mouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 || !dragging) return;
    dragging = false;
    if (changedDuringDrag) copySelection();
    changedDuringDrag = false;
  };
  const blur = (): void => {
    selectionVersion++;
    dragging = false;
    changedDuringDrag = false;
  };
  const contextMenu = (event: MouseEvent): void => {
    // Shift-right-click remains the browser menu. Mouse-reporting applications
    // retain their ordinary right-button events, rather than receiving a paste.
    if (!shouldPasteOnRightClick(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (readOnly()) {
      notice("This terminal preview is read-only. Open the terminal to paste.");
      return;
    }
    const failed = (): void => {
      if (!disposed && preferences().pasteOnRightClick)
        notice(
          "Could not read the clipboard. Allow clipboard access in your browser, or use Ctrl+Shift+V (Cmd+V on Mac) to paste. Shift-right-click opens the browser menu.",
        );
    };
    if (!navigator.clipboard?.readText) {
      failed();
      return;
    }
    void navigator.clipboard.readText().then((text) => {
      if (disposed || !preferences().pasteOnRightClick) return;
      if (readOnly()) {
        notice("This terminal preview is read-only. Open the terminal to paste.");
        return;
      }
      // xterm owns newline normalization and bracketed paste, and onData owns
      // the current socket and its existing input permission checks.
      terminal.paste(text);
      terminal.focus();
    }, failed);
  };
  host.addEventListener("mousedown", mouseDown, true);
  host.addEventListener("contextmenu", contextMenu, true);
  window.addEventListener("mouseup", mouseUp);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    selection.dispose();
    host.removeEventListener("mousedown", mouseDown, true);
    host.removeEventListener("contextmenu", contextMenu, true);
    window.removeEventListener("mouseup", mouseUp);
    window.removeEventListener("blur", blur);
  };
}
