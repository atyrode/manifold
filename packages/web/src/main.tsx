// The design system's sheet leads: it carries the reset, the type and colour ground and the
// tokens every owner reads, so it must reach the document before any owner's skin does — the
// floor's own sheet included. Every other stylesheet arrives through the module that paints
// against it — the shell's from `workspace.tsx`, each plugin's from its own web half (§Lexicon
// cssFamilies, S13).
import "@manifold/ui";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { captureOwnerKeyFromFragment, IdentityGate } from "./identity.tsx";
import { LensGate } from "./lens.tsx";
import { AssemblyProvider } from "./plugin-host.tsx";
import { WEB_CHANNEL } from "./web-version.ts";

captureOwnerKeyFromFragment();

/*
  A development build names itself in the tab, so two windows on two instances never look alike
  (#221). Composed onto whatever title the build shipped, and only when the operator did not
  already choose one (`VITE_MANIFOLD_SITE_TITLE`, docs/SELF-HOST.md): a title somebody picked is
  theirs to have picked.
*/
if (WEB_CHANNEL === "development" && import.meta.env.VITE_MANIFOLD_SITE_TITLE === "") {
  document.title = `${document.title} · development`;
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing #root mount point");

createRoot(rootElement).render(
  <StrictMode>
    {/*
      OUTSIDE the identity gate: which instance this device looks at, whether it can be reached,
      and whether this bundle still speaks its protocol are questions about the LENS, and they are
      settled before "who is asking" is even meaningful — a grant belongs to one instance.
    */}
    <LensGate>
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
    </LensGate>
  </StrictMode>,
);
