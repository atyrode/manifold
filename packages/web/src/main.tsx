import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { captureOwnerKeyFromFragment, IdentityGate } from "./identity.tsx";
import { AssemblyProvider } from "./plugin-host.tsx";
import "./styles.css";

captureOwnerKeyFromFragment();

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing #root mount point");

createRoot(rootElement).render(
  <StrictMode>
    <IdentityGate>
      {(identity) => (
        // The composition needs the bearer token for its boot roster fetch, so it mounts
        // INSIDE the gate and above every route: the vocabulary is settled before the shell
        // asks what panels exist.
        <AssemblyProvider identity={identity}>
          <App identity={identity} />
        </AssemblyProvider>
      )}
    </IdentityGate>
  </StrictMode>,
);
