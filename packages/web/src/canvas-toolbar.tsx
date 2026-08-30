import type { CanvasTool } from "./canvas-tool.ts";

interface CanvasToolbarProps {
  readonly tool: CanvasTool;
  readonly onChange: (tool: CanvasTool) => void;
}

const TOOLS = [
  { tool: "select", label: "Select" },
  { tool: "draw", label: "Draw" },
  { tool: "text", label: "Text" },
] as const;

export function CanvasToolbar({ tool, onChange }: CanvasToolbarProps): React.ReactElement {
  return (
    <div className="flow-toolbar" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((item) => {
        const active = item.tool === tool;
        return (
          <button
            key={item.tool}
            type="button"
            className={`flow-toolbar__button${active ? " flow-toolbar__button--active" : ""}`}
            data-testid={`toolbar-${item.tool}`}
            aria-pressed={active}
            onClick={() => onChange(item.tool)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
