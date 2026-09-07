/** The parser seam shared by live terminal viewers and their authoritative mirrors. */
export interface TerminalModeParser {
  registerCsiHandler(
    identifier: { prefix?: string; intermediates?: string; final: string },
    handler: (params: (number | number[])[]) => boolean,
  ): { dispose(): void };
  registerEscHandler(
    identifier: { intermediates?: string; final: string },
    handler: () => boolean,
  ): { dispose(): void };
}

/** Observe one DEC private mode without consuming another parser's mode handling. */
export function trackTerminalPrivateMode(
  parser: TerminalModeParser,
  mode: number,
  onChange?: (enabled: boolean) => void,
) {
  if (!Number.isInteger(mode) || mode < 1 || mode > 65535) {
    throw new RangeError("DEC private mode must be an integer from 1 to 65535");
  }
  let enabled = false;
  const setSequence = `\u001b[?${String(mode)}h`;
  const resetSequence = `\u001b[?${String(mode)}l`;
  const set = (next: boolean): void => {
    if (enabled === next) return;
    enabled = next;
    onChange?.(next);
  };
  const observe =
    (next: boolean) =>
    (params: (number | number[])[]): boolean => {
      if (params.includes(mode)) set(next);
      return false;
    };
  const handlers = [
    parser.registerCsiHandler({ prefix: "?", final: "h" }, observe(true)),
    parser.registerCsiHandler({ prefix: "?", final: "l" }, observe(false)),
    parser.registerEscHandler({ final: "c" }, () => {
      set(false);
      return false;
    }),
  ];
  return {
    get enabled(): boolean {
      return enabled;
    },
    serialize: (): string => (enabled ? setSequence : resetSequence),
    reset: (): void => set(false),
    dispose: (): void => {
      for (const handler of handlers) handler.dispose();
    },
  };
}
