import { describe, expect, spyOn, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { installTerminalClipboard, type TerminalClipboardCopy } from "../src/terminal-clipboard.ts";

const b64 = (value: string) => Buffer.from(value).toString("base64");

function fixture(entries: Record<string, Blob> = { "text/plain": new Blob(["hello"]) }) {
  const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const sent: string[] = [];
  const notices: string[] = [];
  const copied: string[] = [];
  const pasted: string[] = [];
  let allowed = true;
  let focused = true;
  let offer: TerminalClipboardCopy | null = null;
  const changes = new Set<() => void>();
  const window = Object.assign(new EventTarget(), {
    crypto: globalThis.crypto,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    navigator: {
      clipboard: {
        read: async () => [
          { types: Object.keys(entries), getType: async (type: string) => entries[type]! },
        ],
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
  });
  const activeElement = {};
  const document = Object.assign(new EventTarget(), {
    defaultView: window,
    activeElement,
    hasFocus: () => true,
    hidden: false,
  });
  const host = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (element: unknown) => focused && element === activeElement,
  });
  const terminal = {
    parser: {
      registerOscHandler: (code: number, handler: (data: string) => boolean) => {
        handlers.set(code, handler);
        return { dispose: () => handlers.delete(code) };
      },
    },
    paste: (text: string) => {
      pasted.push(text);
    },
    focus: () => {
      focused = true;
    },
  };
  const clipboard = installTerminalClipboard(
    terminal as unknown as Terminal,
    host as unknown as HTMLElement,
    {
      canWrite: () => allowed,
      send: (data) => {
        sent.push(data);
        for (const notify of changes) notify();
      },
      notice: (message) => {
        notices.push(message);
      },
      offerCopy: (request) => {
        offer = request;
        for (const notify of changes) notify();
      },
    },
  );
  clipboard.setPasteMode(true);
  return {
    clipboard,
    sent,
    copied,
    pasted,
    notices,
    window,
    until: (predicate: () => boolean): Promise<void> => {
      if (predicate()) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      const notify = () => {
        if (!predicate()) return;
        changes.delete(notify);
        resolve();
      };
      changes.add(notify);
      return promise;
    },
    get offer() {
      return offer;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
    osc: (code: number, value: string) => handlers.get(code)?.(value),
    token: () => sent.find((frame) => frame.includes(":pw="))!.match(/:pw=([A-Za-z0-9+/=]+)/)![1]!,
  };
}

function request(token: string, mime = "text/plain", extra = "") {
  return `type=read:pw=${token}:name=${b64("Paste event")}${extra};${b64(mime)}`;
}

function received(frames: string[], mime: string) {
  return Buffer.concat(
    frames
      .filter((frame) => frame.includes(`:mime=${b64(mime)};`))
      .map((frame) => {
        const payload = frame.slice(frame.lastIndexOf(";") + 1, -2);
        const bytes = Buffer.from(payload, "base64");
        expect(bytes.byteLength).toBeLessThanOrEqual(4096);
        return bytes;
      }),
  );
}

describe("terminal clipboard consent and MIME transport", () => {
  test("lists actual Blob formats and negotiates available types, preserving binary and split UTF-8 bytes", async () => {
    const text = "a".repeat(4095) + "🦉" + "z".repeat(8192);
    const image = Uint8Array.from({ length: 9000 }, (_, index) => index % 256);
    const f = fixture({ "text/plain": new Blob([text]), "image/png": new Blob([image]) });
    try {
      await f.clipboard.pasteFromClipboard();
      expect(received(f.sent, ".").toString()).toBe("text/plain image/png");
      const token = f.token();
      f.sent.length = 0;
      f.osc(5522, request(token, "image/unknown text/plain image/png", ":id=abc+_"));
      await f.until(() => f.sent.some((frame) => frame.includes("status=DONE")));
      expect(received(f.sent, "text/plain").toString()).toBe(text);
      expect(received(f.sent, "image/png")).toEqual(Buffer.from(image));
      expect(f.sent.every((frame) => frame.includes(":id=abc+_"))).toBe(true);
      expect(f.pasted).toEqual([]);
      f.sent.length = 0;
      f.osc(5522, request(token));
      expect(f.sent).toEqual([]);
    } finally {
      f.clipboard.dispose();
    }
  });

  test("invalid owned requests consume their grant; unsolicited and foreign requests cannot read clipboard data", async () => {
    const f = fixture();
    try {
      f.osc(5522, `type=read;${b64(".")}`);
      expect(f.sent.pop()).toContain("status=EPERM");
      for (const [makeRequest, status] of [
        [(token: string) => `type=read:pw=${token};${b64("text/plain")}`, "EPERM"],
        [(token: string) => request(token, "text/plain", ":loc=primary"), "ENOSYS"],
        [(token: string) => request(token, "image/jpeg"), "ENOSYS"],
      ] as const) {
        await f.clipboard.pasteFromClipboard();
        const token = f.token();
        f.sent.length = 0;
        f.osc(5522, request("wrong"));
        expect(f.sent).toEqual([]);
        f.osc(5522, makeRequest(token));
        expect(f.sent.pop()).toContain(`status=${status}`);
        f.osc(5522, request(token));
        expect(f.sent).toEqual([]);
        expect(f.offer).toBeNull();
      }
    } finally {
      f.clipboard.dispose();
    }
  });

  test("another authorized viewer cannot refuse the initiating viewer's paste grant", async () => {
    const source = fixture({ "text/plain": new Blob(["one deliberate paste"]) });
    const viewer = fixture();
    try {
      await source.clipboard.pasteFromClipboard();
      const read = request(source.token());
      source.sent.length = 0;
      // PTY output fans out to both viewers, including two devices of one principal.
      viewer.osc(5522, read);
      source.osc(5522, read);
      await source.until(() => source.sent.some((frame) => frame.includes("status=DONE")));
      expect(viewer.sent).toEqual([]);
      expect(received(source.sent, "text/plain").toString()).toBe("one deliberate paste");
    } finally {
      source.clipboard.dispose();
      viewer.clipboard.dispose();
    }
  });

  test("expires grants and makes reset, authority loss and changed gesture preferences irreversible", async () => {
    const f = fixture();
    try {
      await f.clipboard.pasteFromClipboard();
      const token = f.token();
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
      try {
        f.osc(5522, request(token));
        expect(f.sent.pop()).toContain("status=EPERM");
      } finally {
        clock.mockRestore();
      }
      f.sent.length = 0;
      await f.clipboard.pasteFromClipboard();
      const second = f.token();
      expect(second).not.toBe(token);
      f.sent.length = 0;
      f.setAllowed(false);
      f.osc(5522, request(second));
      f.setAllowed(true);
      f.osc(5522, request(second));
      expect(f.sent).toEqual([]);
      f.sent.length = 0;
      let preference = true;
      const pending = f.clipboard.pasteFromClipboard(() => preference);
      preference = false;
      await pending;
      expect(f.sent).toEqual([]);
      await f.clipboard.pasteFromClipboard();
      const third = f.token();
      f.clipboard.reset();
      f.osc(5522, request(third));
      expect(f.sent.pop()).toContain("status=EPERM");
    } finally {
      f.clipboard.dispose();
    }
  });

  test("does not replace a pending grant and accepts OMP's older MIME metadata dialect", async () => {
    const f = fixture();
    try {
      await f.clipboard.pasteFromClipboard();
      const token = f.token();
      f.sent.length = 0;
      await f.clipboard.pasteFromClipboard();
      expect(f.sent).toEqual([]);
      expect(f.notices[0]).toContain("pending");
      f.osc(5522, `type=read:pw=${token}:name=${b64("Paste event")}:mime=${b64("text/plain")}`);
      await f.until(() => f.sent.some((frame) => frame.includes("status=DONE")));
      expect(received(f.sent, "text/plain").toString()).toBe("hello");
    } finally {
      f.clipboard.dispose();
    }
  });

  test("mode-off right-click uses xterm text paste and reports image-only paste", async () => {
    const text = fixture();
    const image = fixture({ "image/png": new Blob([new Uint8Array([137, 80, 78, 71])]) });
    try {
      text.clipboard.setPasteMode(false);
      await text.clipboard.pasteFromClipboard();
      expect(text.pasted).toEqual(["hello"]);
      expect(text.sent).toEqual([]);
      image.clipboard.setPasteMode(false);
      await image.clipboard.pasteFromClipboard();
      expect(image.notices[0]).toContain("has not enabled image/MIME paste");
      expect(image.pasted).toEqual([]);
    } finally {
      text.clipboard.dispose();
      image.clipboard.dispose();
    }
  });

  test("unsupported-only clipboard data never issues a grant or blocks a subsequent supported paste", async () => {
    const entries: Record<string, Blob> = {
      "text/html": new Blob(["<p>not a terminal format</p>"]),
    };
    const f = fixture(entries);
    try {
      await f.clipboard.pasteFromClipboard();
      expect(f.sent).toEqual([]);
      entries["text/plain"] = new Blob(["supported after refusal"]);
      await f.clipboard.pasteFromClipboard();
      const token = f.token();
      f.sent.length = 0;
      f.osc(5522, request(token));
      await f.until(() => f.sent.some((frame) => frame.includes("status=DONE")));
      expect(received(f.sent, "text/plain").toString()).toBe("supported after refusal");
    } finally {
      f.clipboard.dispose();
    }
  });

  test("oversized captured data never receives a paste grant", async () => {
    const f = fixture({ "image/png": new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]) });
    try {
      await f.clipboard.pasteFromClipboard();
      expect(f.sent).toEqual([]);
      expect(f.pasted).toEqual([]);
    } finally {
      f.clipboard.dispose();
    }
  });

  test("malformed, non-UTF-8 and oversized OSC52 copies never ask for approval or retain the exchange", async () => {
    const f = fixture();
    try {
      for (const payload of [
        "%%%",
        "/w==",
        "A".repeat(Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4),
      ]) {
        f.osc(52, `c;${payload}`);
        expect(f.offer).toBeNull();
      }
      expect(f.copied).toEqual([]);
      f.osc(52, `c;${b64("valid after rejected copy")}`);
      await f.until(() => f.offer !== null);
      await f.offer!.accept();
      expect(f.copied).toEqual(["valid after rejected copy"]);
    } finally {
      f.clipboard.dispose();
    }
  });

  test("OSC52 never writes before approval, consumes approval once, ignores queries and background output", async () => {
    const f = fixture();
    try {
      f.osc(52, "c;?");
      expect(f.offer).toBeNull();
      f.setFocused(false);
      f.osc(52, `c;${b64("background")}`);
      expect(f.offer).toBeNull();
      f.setFocused(true);
      f.osc(52, `c;${b64("copy 🦉")}`);
      await f.until(() => f.offer !== null);
      const offer = f.offer!;
      expect(offer.byteLength).toBe(Buffer.byteLength("copy 🦉"));
      expect(f.copied).toEqual([]);
      await offer.accept();
      await offer.accept();
      expect(f.copied).toEqual(["copy 🦉"]);
      f.osc(52, `c;${b64("cancelled")}`);
      await f.until(() => f.offer !== null);
      const cancelled = f.offer!;
      cancelled.cancel();
      await cancelled.accept();
      expect(f.copied).toEqual(["copy 🦉"]);
      f.osc(52, `c;${b64("stale")}`);
      await f.until(() => f.offer !== null);
      const stale = f.offer!;
      f.clipboard.reset();
      await stale.accept();
      expect(f.copied).toEqual(["copy 🦉"]);
    } finally {
      f.clipboard.dispose();
    }
  });

  test("browser copy denial preserves clipboard privacy and permits the next exchange", async () => {
    const f = fixture();
    try {
      f.window.navigator.clipboard.writeText = async () => {
        throw new Error("browser denied private content");
      };
      f.osc(52, `c;${b64("private content")}`);
      await f.until(() => f.offer !== null);
      await f.offer!.accept();
      expect(f.copied).toEqual([]);
      expect(f.sent).toEqual([]);
      expect(f.offer).toBeNull();
      expect(f.notices.join(" ")).not.toContain("private content");
      f.window.navigator.clipboard.writeText = async (text) => {
        f.copied.push(text);
      };
      f.osc(52, `c;${b64("accepted after denial")}`);
      await f.until(() => f.offer !== null);
      await f.offer!.accept();
      expect(f.copied).toEqual(["accepted after denial"]);
    } finally {
      f.clipboard.dispose();
    }
  });
});
