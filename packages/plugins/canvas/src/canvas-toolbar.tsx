import { useProjection } from "@manifold/plugin/hooks";
import { Cluster } from "@manifold/ui";
import { useMemo } from "react";
import { CANVAS_TOOLS, type CanvasTool } from "./canvas-tool.ts";

interface CanvasToolbarProps {
  readonly tool: CanvasTool;
  readonly onChange: (tool: CanvasTool) => void;
}

interface ToolbarItem {
  readonly id: CanvasTool;
  readonly title: string;
}

/**
 * The tool strip, composed — and composed ALL the way down now that the canvas is a plugin
 * itself. Every button comes from the one tool registry the engine builds from the roster;
 * this ref contributes no literal naming any tool, including its own two. `select` and
 * `text` are `core.canvas`'s manifest rows, so they arrive through exactly the door
 * `core.draw`'s tool arrives through, and disabling `core.draw` removes its button live with
 * no reload (R3).
 *
 * The only judgement left here is ORDER, which is this ref's to make: the canvas's own
 * modes first (in {@link CANVAS_TOOLS} order), then every other plugin's in roster order.
 */
export function CanvasToolbar({ tool, onChange }: CanvasToolbarProps): React.ReactElement {
  const projection = useProjection();
  const items = useMemo<readonly ToolbarItem[]>(() => {
    const enabled = projection.tools.filter(
      (candidate) => candidate.enabled && candidate.toolbar === "canvas",
    );
    const rank = (id: string): number => {
      const own = CANVAS_TOOLS.indexOf(id);
      return own === -1 ? CANVAS_TOOLS.length : own;
    };
    return enabled
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => rank(a.candidate.id) - rank(b.candidate.id) || a.index - b.index)
      .map(({ candidate }) => ({ id: candidate.id, title: candidate.title }));
  }, [projection.tools]);

  return (
    <Cluster
      className="canvas-toolbar"
      gap="0.25rem"
      justify="center"
      role="toolbar"
      aria-label="Canvas tools"
    >
      {items.map((item) => {
        const active = item.id === tool;
        return (
          <button
            key={item.id}
            type="button"
            className={`canvas-toolbar__button${active ? " canvas-toolbar__button--active" : ""}`}
            data-testid={`toolbar-${item.id}`}
            aria-pressed={active}
            onClick={() => onChange(item.id)}
          >
            {item.title}
          </button>
        );
      })}
    </Cluster>
  );
}
