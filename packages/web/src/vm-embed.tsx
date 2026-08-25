import { useEffect, useState } from "react";
import { createVmSession } from "./api.ts";

type VmEmbedState = "authorizing" | "ready" | "failed";

interface VmEmbedProps {
  readonly link: string;
  readonly token: string;
}

/** Establishes an HttpOnly scoped cookie before the protected noVNC document is requested. */
export function VmEmbed({ link, token }: VmEmbedProps) {
  const [state, setState] = useState<VmEmbedState>("authorizing");

  useEffect(() => {
    let current = true;
    void createVmSession(token).then(
      () => {
        if (current) setState("ready");
      },
      (error: unknown) => {
        console.error("VM session authorization failed", error);
        if (current) setState("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [token]);

  if (state !== "ready") {
    return (
      <div className="terminal-placeholder">
        {state === "failed"
          ? "Could not authorize virtual machine"
          : "Authorizing virtual machine…"}
      </div>
    );
  }

  return (
    <iframe
      className="excalidraw__embeddable"
      src={link}
      scrolling="no"
      referrerPolicy="no-referrer"
      title="manifold OS virtual machine"
      allow="clipboard-read; clipboard-write; fullscreen"
      allowFullScreen
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
    />
  );
}
