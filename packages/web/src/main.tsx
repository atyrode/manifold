// Scaffold canary: proves @excalidraw/excalidraw 0.18.1 + React 19 + xterm 6 build and render
// under Vite 8. Replaced by the real app in the web implementation pass.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Terminal } from "@xterm/xterm";
import { PROTOCOL_VERSION } from "@manifold/protocol";

// Touch xterm so the canary proves it bundles.
const canaryTerminal = new Terminal({ cols: 8, rows: 2 });
canaryTerminal.dispose();

function App() {
  return (
    <div style={{ position: "fixed", inset: 0 }} data-protocol-version={PROTOCOL_VERSION}>
      <Excalidraw />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
