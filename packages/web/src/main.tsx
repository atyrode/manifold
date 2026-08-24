import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import { App } from "./app.tsx";
import { captureOwnerKeyFromFragment, IdentityGate } from "./identity.tsx";
import "./styles.css";

captureOwnerKeyFromFragment();

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing #root mount point");

createRoot(rootElement).render(
  <StrictMode>
    <IdentityGate>{(identity) => <App identity={identity} />}</IdentityGate>
  </StrictMode>,
);
