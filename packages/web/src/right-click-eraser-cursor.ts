import type { AppState } from "@excalidraw/excalidraw/types";

let lightCursorDataUrl: string | null = null;
let darkCursorDataUrl: string | null = null;

function createEraserCursorDataUrl(theme: AppState["theme"]): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 20;
  const context = canvas.getContext("2d");
  if (context === null) return null;

  const dark = theme === "dark";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(10, 10, 5, 0, 2 * Math.PI);
  context.fillStyle = dark ? "#000000" : "#ffffff";
  context.fill();
  context.strokeStyle = dark ? "#ffffff" : "#000000";
  context.stroke();
  return canvas.toDataURL("image/png");
}

export function applyRightClickEraserCursor(
  canvas: HTMLCanvasElement,
  theme: AppState["theme"],
): void {
  let dataUrl = theme === "dark" ? darkCursorDataUrl : lightCursorDataUrl;
  if (dataUrl === null) {
    dataUrl = createEraserCursorDataUrl(theme);
    if (theme === "dark") darkCursorDataUrl = dataUrl;
    else lightCursorDataUrl = dataUrl;
  }
  if (dataUrl !== null) canvas.style.cursor = `url(${dataUrl}) 10 10, auto`;
}
