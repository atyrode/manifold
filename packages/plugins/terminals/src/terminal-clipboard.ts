import type { Terminal } from "@xterm/xterm";

export interface TerminalClipboardCopy {
  readonly byteLength: number;
  readonly mimeTypes: readonly string[];
  accept(): Promise<void>;
  cancel(): void;
}

export interface TerminalClipboard {
  setPasteMode(enabled: boolean): void;
  reset(): void;
  pasteFromClipboard(stillCurrent?: () => boolean): Promise<void>;
  dispose(): void;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TYPES = 32;
const MAX_META = 8192;
const CHUNK = 4096;
const LIFETIME = 15_000;
const SUPPORTED_TYPES = new Set([
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const mimePattern = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\s\x00-\x1f\x7f]+)*$/;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function decode(value: string, limit: number): Uint8Array<ArrayBuffer> {
  if (
    value.length > Math.ceil(limit / 3) * 4 ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    !/^[^=]*={0,2}$/.test(value)
  ) {
    throw new Error("EINVAL");
  }
  const binary = atob(value);
  if (binary.length > limit) throw new Error("EINVAL");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function mimeList(value: string): string[] {
  const types = decoder
    .decode(decode(value, MAX_META))
    .trim()
    .split(/[\t\n\r\f ]+/);
  if (
    types.length > MAX_TYPES ||
    types.some((type) => type !== "." && (type.length > 255 || !mimePattern.test(type)))
  ) {
    throw new Error("EINVAL");
  }
  return [...new Set(types)];
}

type Snapshot = Map<string, Blob>;
type Exchange = {
  expires: number;
  guard: () => boolean;
  snapshot?: Snapshot;
  password?: string | undefined;
  release?: () => void;
};

/** Clipboard bytes live only in this view. OSC never initiates a browser read.
 * Ambient reads are denied by browser policy. DECRQM advertisement is left to
 * the terminal integration; this module handles explicit 5522 enable only.
 */
export function installTerminalClipboard(
  terminal: Terminal,
  host: HTMLElement,
  options: {
    canWrite(): boolean;
    send(data: string): void;
    notice(message: string): void;
    offerCopy(request: TerminalClipboardCopy | null): void;
  },
): TerminalClipboard {
  const document = host.ownerDocument;
  const window = document.defaultView!;
  const clipboard = (): Clipboard | undefined => window.navigator.clipboard;
  let mode = false;
  let disposed = false;
  let exchange: Exchange | undefined;
  let offer: TerminalClipboardCopy | undefined;
  let timer: number | undefined;

  const authorized = (): boolean => !disposed && options.canWrite() && document.hasFocus();
  const focused = (): boolean => authorized() && host.contains(document.activeElement);
  const clear = (): void => {
    exchange?.release?.();
    exchange = undefined;
    window.clearTimeout(timer);
    timer = undefined;
    if (offer) {
      offer = undefined;
      options.offerCopy(null);
    }
  };
  const abort = (): void => {
    const operation = exchange;
    // Abort framing contains no clipboard data. It may still complete while the
    // window loses focus, but never after this view loses PTY write authority.
    if (operation?.snapshot && !disposed && options.canWrite()) {
      options.send("\x1b]5522;type=read:status=EPERM\x1b\\");
    }
    clear();
  };
  const current = (operation: Exchange): boolean => {
    if (exchange !== operation) return false;
    if (!authorized() || !operation.guard() || Date.now() >= operation.expires) {
      abort();
      return false;
    }
    return true;
  };
  const send = (type: string, status: string, id = "", extra = "", payload?: string): void => {
    if (!authorized()) {
      clear();
      return;
    }
    options.send(
      `\x1b]5522;type=${type}:status=${status}${id ? `:id=${id}` : ""}${extra}${payload === undefined ? "" : `;${payload}`}\x1b\\`,
    );
  };
  const begin = (guard: () => boolean = () => true): Exchange | undefined => {
    if (exchange && !current(exchange)) exchange = undefined;
    if (exchange || !authorized() || !guard()) return undefined;
    const operation: Exchange = { expires: Date.now() + LIFETIME, guard };
    exchange = operation;
    timer = window.setTimeout(() => {
      if (exchange !== operation) return;
      abort();
      options.notice("Clipboard request expired. Paste or copy again to retry.");
    }, LIFETIME);
    return operation;
  };
  const pause = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    window.setTimeout(resolve, 0);
    return promise;
  };

  const deliver = async (operation: Exchange, types: string[], id: string): Promise<void> => {
    const snapshot = operation.snapshot!;
    let sent = 0;
    if (!current(operation)) return;
    send("read", "OK", id);
    for (const type of types) {
      const blob = type === "." ? new Blob([[...snapshot.keys()].join(" ")]) : snapshot.get(type)!;
      const metadata = `:mime=${encode(encoder.encode(type))}`;
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        if (!current(operation)) return;
        send("read", "DATA", id, metadata, encode(bytes));
        if (++sent % 16 === 0) {
          await pause();
          if (!current(operation)) return;
        }
      }
    }
    if (current(operation)) {
      send("read", "DONE", id);
      clear();
    }
  };

  const add = (snapshot: Snapshot, type: string, blob: Blob): void => {
    if (!SUPPORTED_TYPES.has(type) || snapshot.has(type)) return;
    let bytes = blob.size;
    for (const existing of snapshot.values()) bytes += existing.size;
    if (bytes > MAX_BYTES) throw new Error("Clipboard is too large (maximum 16 MiB).");
    snapshot.set(type, blob);
  };
  const publish = async (operation: Exchange, snapshot: Snapshot): Promise<void> => {
    if (!current(operation)) return;
    if (!snapshot.size) throw new Error("No usable clipboard formats were available.");
    if (!mode) {
      const text = snapshot.get("text/plain");
      if (!text)
        throw new Error(
          "This terminal application has not enabled image/MIME paste. Copy plain text or enable enhanced paste in the application.",
        );
      const value = await text.text();
      if (!current(operation)) return;
      terminal.paste(value);
      clear();
      return;
    }
    // Base64 encodes a UTF-8 password, not arbitrary invalid UTF-8 bytes.
    const random = window.crypto.getRandomValues(new Uint8Array(24));
    operation.password = btoa(encode(random));
    operation.snapshot = snapshot;
    send("read", "OK", "", `:pw=${operation.password}`);
    if (!current(operation)) return;
    send("read", "DATA", "", ":mime=Lg==", encode(encoder.encode([...snapshot.keys()].join(" "))));
    if (current(operation)) send("read", "DONE");
  };
  const failedPaste = (operation: Exchange, error: unknown): void => {
    if (!current(operation)) return;
    clear();
    options.notice(
      error instanceof Error &&
        [
          "Clipboard is too large (maximum 16 MiB).",
          "No usable clipboard formats were available.",
          "This terminal application has not enabled image/MIME paste. Copy plain text or enable enhanced paste in the application.",
        ].includes(error.message)
        ? error.message
        : "Could not read clipboard data. Allow browser clipboard access or use the browser paste shortcut.",
    );
  };
  const pasteFromClipboard = async (stillCurrent: () => boolean = () => true): Promise<void> => {
    const operation = begin(stillCurrent);
    if (!operation) {
      if (authorized() && stillCurrent())
        options.notice(
          "A clipboard exchange is already pending. Finish it or wait for it to expire.",
        );
      return;
    }
    try {
      const snapshot: Snapshot = new Map();
      operation.release = () => snapshot.clear();
      const api = clipboard();
      if (api?.read) {
        const items = await api.read();
        if (!current(operation)) return;
        for (const item of items) {
          for (const type of item.types) {
            if (!SUPPORTED_TYPES.has(type) || snapshot.has(type)) continue;
            const blob = await item.getType(type);
            if (!current(operation)) return;
            add(snapshot, type, blob);
          }
        }
      } else if (api?.readText) {
        const text = await api.readText();
        if (!current(operation)) return;
        add(snapshot, "text/plain", new Blob([text], { type: "text/plain" }));
      } else throw new Error("unavailable");
      await publish(operation, snapshot);
    } catch (error) {
      failedPaste(operation, error);
    }
  };
  const paste = (event: ClipboardEvent): void => {
    if (!event.isTrusted) return;
    if (!authorized()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clear();
      return;
    }
    const data = event.clipboardData;
    if (!mode && data?.types.includes("text/plain")) return; // xterm owns ordinary paste.
    event.preventDefault();
    event.stopImmediatePropagation();
    const operation = begin();
    if (!operation) {
      options.notice(
        "A clipboard exchange is already pending. Finish it or wait for it to expire.",
      );
      return;
    }
    // Capture strings synchronously: DataTransfer is protected after dispatch.
    try {
      const snapshot: Snapshot = new Map();
      operation.release = () => snapshot.clear();
      if (data) {
        // A file MIME may also appear in types with no string payload. Keep its
        // actual bytes before adding text representations of the same clipboard.
        for (const item of data.items) {
          if (item.kind !== "file" || !SUPPORTED_TYPES.has(item.type)) continue;
          const file = item.getAsFile();
          if (file) add(snapshot, file.type, file);
        }
        for (const type of data.types) {
          if (!SUPPORTED_TYPES.has(type) || snapshot.has(type)) continue;
          const text = data.getData(type);
          add(snapshot, type, new Blob([text], { type }));
        }
      }
      void publish(operation, snapshot).catch((error: unknown) => failedPaste(operation, error));
    } catch (error) {
      failedPaste(operation, error);
    }
  };

  const offerTextCopy = (operation: Exchange, text: string, byteLength: number): void => {
    if (!current(operation)) return;
    operation.release = () => {
      text = "";
    };
    const request: TerminalClipboardCopy = {
      byteLength,
      mimeTypes: Object.freeze(["text/plain"]),
      cancel: () => {
        if (!current(operation) || offer !== request) return;
        clear();
      },
      accept: async () => {
        if (!current(operation) || offer !== request) return;
        offer = undefined;
        options.offerCopy(null);
        try {
          const api = clipboard();
          if (!api?.writeText) throw new Error("unavailable");
          // Invoke the browser write before the first await to retain activation.
          await api.writeText(text);
          if (!current(operation)) return;
          clear();
        } catch {
          if (!current(operation)) return;
          clear();
          options.notice(
            "Could not write the clipboard. Allow clipboard access in your browser and copy again.",
          );
        }
      },
    };
    offer = request;
    options.offerCopy(request);
  };

  const osc52 = terminal.parser.registerOscHandler(52, (data) => {
    if (!focused()) return true;
    const separator = data.indexOf(";");
    const target = data.slice(0, separator);
    const payload = data.slice(separator + 1);
    if (separator < 0 || !["", "c"].includes(target) || payload === "?") return true;
    const operation = begin();
    if (!operation) {
      options.notice("A clipboard exchange is already pending. Copy again after it finishes.");
      return true;
    }
    try {
      const bytes = decode(payload, MAX_BYTES);
      offerTextCopy(operation, decoder.decode(bytes), bytes.byteLength);
    } catch {
      clear();
      options.notice("The terminal requested an invalid or oversized clipboard copy.");
    }
    return true;
  });

  const osc5522 = terminal.parser.registerOscHandler(5522, (data) => {
    const separator = data.indexOf(";");
    const header = separator < 0 ? data : data.slice(0, separator);
    const payload = separator < 0 ? "" : data.slice(separator + 1);
    const metadata = new Map<string, string>();
    let malformed = header.length > MAX_META;
    if (!malformed) {
      for (const pair of header.split(":")) {
        const equals = pair.indexOf("=");
        const key = pair.slice(0, equals);
        if (equals < 1 || metadata.has(key)) malformed = true;
        else metadata.set(key, pair.slice(equals + 1));
      }
    }
    const type = metadata.get("type");
    const id = (metadata.get("id") ?? "").replace(/[^a-zA-Z0-9_+.\-]/g, "").slice(0, 256);
    const error = (status: string): void => send(type === "read" ? "read" : "write", status, id);
    if (!authorized()) {
      clear();
      return true;
    }
    // One principal may watch from several devices; only the issuing view may
    // answer or refuse its paste grant, including malformed requests.
    if (type === "read" && metadata.has("pw") && metadata.get("pw") !== exchange?.password)
      return true;
    if (malformed) {
      if (type === "read" && metadata.get("pw") === exchange?.password) clear();
      error(type === "read" ? "EPERM" : "EINVAL");
      return true;
    }
    if (type === "read") {
      const operation = exchange;
      if (!operation || !operation.password || metadata.get("pw") !== operation.password) {
        error("EPERM");
        return true;
      }
      if (!current(operation)) return true;
      if (metadata.has("loc") && metadata.get("loc") !== "clipboard") {
        clear();
        error("ENOSYS");
        return true;
      }
      try {
        const name = decoder.decode(decode(metadata.get("name") ?? "", 256));
        if (!name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error("EPERM");
        const requested = mimeList(payload || metadata.get("mime") || "");
        const selected = requested.filter((mime) => mime === "." || operation.snapshot!.has(mime));
        operation.password = undefined; // Consume before the first asynchronous read.
        if (!selected.length) {
          clear();
          error("ENOSYS");
        } else
          void deliver(operation, selected, id).catch(() => {
            if (current(operation)) {
              clear();
              error("EBUSY");
            }
          });
      } catch {
        clear();
        error("EPERM");
      }
      return true;
    }
    // OMP copies UTF-8 text through OSC 52. Generic MIME writes are not exposed.
    if (type === "write") error("ENOSYS");
    return true;
  });

  const keydown = (event: KeyboardEvent): void => {
    if (
      !mode ||
      !event.isTrusted ||
      !clipboard()?.read ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.key.toLowerCase() !== "v"
    )
      return;
    // Chromium treats Ctrl+Shift+V as plain-text paste and drops image formats.
    // In enhanced mode this terminal gesture reads the full MIME clipboard.
    event.preventDefault();
    event.stopImmediatePropagation();
    void pasteFromClipboard();
  };

  const blur = (): void => abort();
  const visibility = (): void => {
    if (document.hidden) abort();
  };
  host.addEventListener("paste", paste, true);
  host.addEventListener("keydown", keydown, true);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  return {
    setPasteMode: (enabled) => {
      if (disposed) return;
      if (mode !== enabled) abort();
      mode = enabled;
    },
    reset: () => {
      mode = false;
      abort();
    },
    pasteFromClipboard,
    dispose: () => {
      abort();
      disposed = true;
      mode = false;
      clear();
      osc52.dispose();
      osc5522.dispose();
      host.removeEventListener("paste", paste, true);
      host.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
