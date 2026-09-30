import type { PanelArg } from "@manifold/protocol";
import {
  createContext,
  useContext,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { frameElement, frameMeta, useFrameMode } from "./frame-mode.tsx";
import { Stack } from "./layout.tsx";
import type { VocabularyMeta } from "./vocabulary.tsx";

export interface BorrowedPanelProps extends VocabularyMeta {
  readonly panelId: string;
  readonly input?: PanelArg | undefined;
  readonly onResult: (result: PanelArg) => void;
}
const PanelRenderer = createContext<ComponentType<BorrowedPanelProps> | null>(null);

/** Floor binding only: no component, callback or local file is serialized into a UI frame. */
export function BorrowedPanelProvider({
  Component,
  children,
}: {
  readonly Component: ComponentType<BorrowedPanelProps>;
  readonly children?: ReactNode;
}): ReactElement {
  return <PanelRenderer value={Component}>{children}</PanelRenderer>;
}

/** Mount the registered owner, in its selected execution mode, and receive one JSON result. */
export function BorrowedPanel({
  panelId,
  input,
  onResult,
  ...rest
}: BorrowedPanelProps): ReactElement {
  const framed = useFrameMode();
  const Component = useContext(PanelRenderer);
  const meta = frameMeta("BorrowedPanel", rest);
  if (framed) return frameElement("borrowedPanel", { panelId, input, onResult, ...meta });
  return (
    <Stack gap="0" {...rest}>
      {Component === null ? (
        <span role="status">Panel unavailable: no mounted host.</span>
      ) : (
        <Component panelId={panelId} input={input} onResult={onResult} />
      )}
    </Stack>
  );
}
