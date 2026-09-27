import type { PortablePanelProps } from "@manifold/plugin";
import { defineWebPlugin } from "@manifold/plugin-kit/web";
import { Heading, Stack, Text } from "@manifold/ui";
import { useEffect, useState, type ReactElement } from "react";

/** A handle-driven viewer: the stream lives exactly as long as the panel's effect does. */
function Frames({ host }: PortablePanelProps): ReactElement {
  const [progress, setProgress] = useState({ seq: 0, status: "opening" });
  useEffect(() => {
    const handle = host.client.openStream({
      kind: "example.streams.frames",
      node: { kind: "plugin", pluginId: "example.streams" },
    });
    const off = handle.on(() => {
      setProgress({ seq: handle.cursor?.seq ?? 0, status: handle.status });
    });
    return () => {
      off();
      handle.close();
    };
  }, [host.client]);
  return (
    <Stack gap="0.5rem">
      <Heading level={2}>Continuous stream fixture</Heading>
      <Text>Stream frame {progress.seq}</Text>
      <Text>Stream status {progress.status}</Text>
    </Stack>
  );
}

export default defineWebPlugin({ id: "example.streams", panels: { frames: Frames } });
