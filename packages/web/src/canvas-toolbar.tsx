import { useMemo } from "react";
import { FLOOR_TOOLS, type CanvasTool } from "./canvas-tool.ts";
import { useComposition } from "./plugin-host.tsx";

interface CanvasToolbarProps {
  readonly tool: CanvasTool;
  readonly onChange: (tool: CanvasTool) => void;
}

/** Titles for the tools the engine still owns; contributed titles come from manifests. */
const FLOOR_TOOL_TITLES: Readonly<Record<string, string>> = {
  select: "Select",
  text: "Text",
};

interface ToolbarItem {
  readonly id: CanvasTool;
  readonly title: string;
}

/**
 * The tool strip, composed. Floor tools first, then every ENABLED contributed tool in roster
 * order with the title its manifest declares — so disabling `core.draw` removes its button
 * live, with no reload and no literal here naming it (R3).
 */
export function CanvasToolbar({ tool, onChange }: CanvasToolbarProps): React.ReactElement {
  const composition = useComposition();
  const items = useMemo<readonly ToolbarItem[]>(() => {
    const floor = FLOOR_TOOLS.map((id) => ({ id, title: FLOOR_TOOL_TITLES[id] ?? id }));
    const contributed = composition.tools
      .filter((candidate) => candidate.enabled)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.contribution?.title ?? candidate.title,
      }));
    return [...floor, ...contributed];
  }, [composition]);

  return (
    <div className="flow-toolbar" role="toolbar" aria-label="Canvas tools">
      {items.map((item) => {
        const active = item.id === tool;
        return (
          <button
            key={item.id}
            type="button"
            className={`flow-toolbar__button${active ? " flow-toolbar__button--active" : ""}`}
            data-testid={`toolbar-${item.id}`}
            aria-pressed={active}
            onClick={() => onChange(item.id)}
          >
            {item.title}
          </button>
        );
      })}
    </div>
  );
}
