import type { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalRendererMode } from "./terminal-renderer-preferences";

/** Swaps only xterm's renderer; the Terminal, parser, buffer, PTY and input remain untouched. */
export function installTerminalRenderer(
  terminal: Terminal,
  host: HTMLElement,
  notify: (message: string) => void,
) {
  let selected: TerminalRendererMode = "dom";
  let generation = 0;
  let disposed = false;
  let addon: WebglAddon | null = null;
  let contextLoss: IDisposable | null = null;
  host.dataset.terminalRenderer = "dom";

  const retireAddon = (): void => {
    contextLoss?.dispose();
    contextLoss = null;
    const current = addon;
    addon = null;
    // The maintained addon retires the GPU context and restores xterm's original DOM renderer.
    current?.dispose();
  };
  const refresh = (): void => terminal.refresh(0, terminal.rows - 1);

  return {
    setMode(mode: TerminalRendererMode): void {
      if (disposed || selected === mode) return;
      selected = mode;
      const stamp = ++generation;
      retireAddon();
      if (mode === "dom") {
        host.dataset.terminalRenderer = "dom";
        refresh();
        return;
      }
      host.dataset.terminalRenderer = "loading";
      void (async () => {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (disposed || stamp !== generation) return;
          const candidate = new WebglAddon();
          addon = candidate;
          contextLoss = candidate.onContextLoss(() => {
            if (disposed || addon !== candidate || stamp !== generation) return;
            retireAddon();
            host.dataset.terminalRenderer = "fallback";
            refresh();
            notify(
              "The WebGL context was lost. This terminal is using the DOM renderer; its screen, history and input remain available. Toggle WebGL off and on to try again.",
            );
          });
          terminal.loadAddon(candidate);
          host.dataset.terminalRenderer = "webgl";
          refresh();
        } catch (error: unknown) {
          if (disposed || stamp !== generation) return;
          retireAddon();
          host.dataset.terminalRenderer = "fallback";
          refresh();
          console.warn({ evt: "terminal_webgl_initialization_refused", error });
          notify(
            "WebGL could not initialize. This terminal is using the DOM renderer; its screen, history and input remain available. Toggle WebGL off and on to try again.",
          );
        }
      })();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation++;
      retireAddon();
      delete host.dataset.terminalRenderer;
    },
  };
}
