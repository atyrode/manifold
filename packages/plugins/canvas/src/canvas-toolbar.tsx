import { useProjection } from "@manifold/plugin/hooks";
import { Cluster } from "@manifold/ui";
import { useMemo } from "react";
import { CANVAS_TOOLS } from "./canvas-tool.ts";
import type { CanvasTool } from "./contract.ts";

interface CanvasToolbarProps {
  readonly tool: CanvasTool;
  readonly onChange: (tool: CanvasTool) => void;
}

interface ToolbarItem {
  readonly id: CanvasTool;
  readonly title: string;
  readonly shortcut: string | undefined;
}

/**
 * Every button comes from the tool registry. Canvas owns selection, while its note and
 * drawing children contribute their own modes and disappear independently when disabled.
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
      .map(({ candidate }) => ({
        id: candidate.id,
        title: candidate.title,
        shortcut: candidate.shortcut,
      }));
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
            aria-keyshortcuts={item.shortcut}
            title={
              item.shortcut === undefined
                ? item.title
                : `${item.title} (${item.shortcut.toUpperCase()})`
            }
            onClick={() => onChange(item.id)}
          >
            {item.title}
          </button>
        );
      })}
    </Cluster>
  );
}
