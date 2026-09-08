import type { Terminal } from "@xterm/headless";

const MAX_PENDING_BYTES = 180000;
type Result = void | Promise<boolean>;
interface ParserParams {
  toArray(): (number | number[])[];
  _rejectDigits: boolean;
  _rejectSubDigits: boolean;
  _digitIsSub: boolean;
}
interface ParserState {
  currentState: number;
  _collect: number;
  _params: ParserParams;
  _dcsParser: {
    hook(id: number, params: ParserParams): void;
    put(data: Uint32Array, start: number, end: number): void;
    unhook(success: boolean, resumed?: boolean): Result;
  };
  _oscParser: {
    start(): void;
    put(data: Uint32Array, start: number, end: number): void;
    end(success: boolean, resumed?: boolean): Result;
  };
}

/** Observe xterm's actual decoded payload, never duplicate its VT/UTF-8 state machine. */
export class TerminalParserContinuation {
  private readonly parser: ParserState;
  private readonly utf8: { interim: Uint8Array };
  private payload = "";
  private payloadBytes = 0;
  private overflow = false;
  private dcsId = 0;

  constructor(terminal: Terminal) {
    // The same pinned xterm 6 private seam the graphics addon uses. These hooks
    // receive only bytes that the real parser forwards, including its C0/DEL rules.
    const internal = terminal as unknown as {
      _core: { _inputHandler: { _parser: ParserState; _utf8Decoder: { interim: Uint8Array } } };
    };
    this.parser = internal._core._inputHandler._parser;
    this.utf8 = internal._core._inputHandler._utf8Decoder;
    if (
      typeof this.parser.currentState !== "number" ||
      typeof this.parser._params.toArray !== "function" ||
      !(this.utf8.interim instanceof Uint8Array)
    ) {
      throw new Error("Unsupported xterm parser state (expected 6.0.0)");
    }
    const dcs = this.parser._dcsParser;
    const hook = dcs.hook.bind(dcs);
    const put = dcs.put.bind(dcs);
    const unhook = dcs.unhook.bind(dcs);
    dcs.hook = (id, params) => {
      this.clear();
      this.dcsId = id;
      hook(id, params);
    };
    dcs.put = (data, start, end) => {
      this.append(data, start, end);
      put(data, start, end);
    };
    dcs.unhook = (success, resumed) => {
      this.clear();
      return unhook(success, resumed);
    };
    const osc = this.parser._oscParser;
    const start = osc.start.bind(osc);
    const oscPut = osc.put.bind(osc);
    const end = osc.end.bind(osc);
    osc.start = () => {
      this.clear();
      start();
    };
    osc.put = (data, first, last) => {
      this.append(data, first, last);
      oscPut(data, first, last);
    };
    osc.end = (success, resumed) => {
      this.clear();
      return end(success, resumed);
    };
  }

  private clear(): void {
    this.payload = "";
    this.payloadBytes = 0;
    this.overflow = false;
  }
  private append(data: Uint32Array, start: number, end: number): void {
    if (this.overflow) return;
    for (let i = start; i < end; i++) {
      const code = data[i]!;
      this.payloadBytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      // Reserve the bounded numeric header as well as the payload.
      if (this.payloadBytes > MAX_PENDING_BYTES - 2048) {
        this.payload = "";
        this.overflow = true;
        return;
      }
      this.payload += String.fromCodePoint(code);
    }
  }

  serialize(): string {
    const parser = this.parser;
    let collected = "";
    for (let shift = 24; shift >= 0; shift -= 8) {
      const byte = (parser._collect >>> shift) & 255;
      if (byte) collected += String.fromCharCode(byte);
    }
    let parameters = "";
    for (const entry of parser._params.toArray()) {
      if (Array.isArray(entry))
        parameters += ":" + entry.map((value) => (value < 0 ? "" : String(value))).join(":");
      else parameters += (parameters ? ";" : "") + String(entry);
    }
    if (parser._params._rejectDigits) parameters += ";";
    else if (parser._params._rejectSubDigits && parser._params._digitIsSub) parameters += ":";
    const prefix = collected.length && collected.charCodeAt(0) >= 0x3c ? collected[0]! : "";
    const intermediate = collected.slice(prefix.length);
    switch (parser.currentState) {
      case 0:
        return "";
      case 1:
        return "\x1b";
      case 2:
        return "\x1b" + collected;
      case 3:
        return "\x1b[";
      case 4:
      case 5:
        return "\x1b[" + prefix + parameters + intermediate;
      case 6:
        return "\x1b[?<";
      case 7:
        return "\x1b_";
      case 8:
        return this.overflow ? "\x1b]99999;" : "\x1b]" + this.payload;
      case 9:
        return "\x1bP";
      case 10:
      case 12:
        return "\x1bP" + prefix + parameters + intermediate;
      case 11:
        return "\x1bP?<";
      case 13:
        return this.overflow
          ? "\x1bP+q"
          : "\x1bP" +
              prefix +
              parameters +
              intermediate +
              String.fromCharCode(this.dcsId & 255) +
              this.payload;
      default:
        throw new Error("Unsupported xterm parser state");
    }
  }

  pendingUtf8(): Uint8Array {
    const firstEmpty = this.utf8.interim.indexOf(0);
    return this.utf8.interim.slice(0, firstEmpty < 0 ? this.utf8.interim.length : firstEmpty);
  }
  replaysSixel(): boolean {
    return this.parser.currentState === 13 && (this.dcsId & 255) === 113 && !this.overflow;
  }
}
