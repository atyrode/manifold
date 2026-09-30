import type { HostServices, PanelProps } from "@manifold/plugin";
import { useProjection } from "@manifold/plugin/hooks";
import {
  MAX_BORROWED_PANELS, PanelResultSchema, PortablePanelInputSchema, validPanelArg,
  type LocalFileDescriptor, type PanelArg, type PortablePanelInput,
} from "@manifold/protocol";
import { BorrowedPanelProvider, Empty, type BorrowedPanelProps } from "@manifold/ui";
import {
  createContext, useContext, useLayoutEffect, useMemo, useRef, useState,
  type ReactElement, type ReactNode,
} from "react";
import type { MountedByteResources } from "./byte-surface.tsx";

interface BorrowScope {
  readonly ancestors: readonly string[];
  readonly budget: Set<symbol>;
  readonly live: () => boolean;
}
const Scope = createContext<BorrowScope | null>(null);
const Host = createContext<HostServices | null>(null);

export function BorrowedPanelHost({ host, resources, children }: {
  readonly host: HostServices;
  readonly resources: MountedByteResources;
  readonly children: ReactNode;
}): ReactElement {
  const parent = useContext(Scope);
  const scope = useMemo<BorrowScope>(() => ({
    ancestors: parent?.ancestors ?? [],
    budget: parent?.budget ?? new Set(),
    live: () => resources.isLive && (parent?.live() ?? true),
  }), [parent, resources]);
  return <Host value={host}><Scope value={scope}>
    <BorrowedPanelProvider Component={BorrowedPanelMount}>{children}</BorrowedPanelProvider>
  </Scope></Host>;
}

function BorrowedPanelMount(props: BorrowedPanelProps): ReactElement {
  if (props.input !== undefined && !validPanelArg(props.input)) return <Empty>Panel input unavailable.</Empty>;
  return <BorrowedPanelInstance key={JSON.stringify([props.panelId, props.input])} {...props} />;
}

function BorrowedPanelInstance({ panelId, input, onResult }: BorrowedPanelProps): ReactElement {
  const scope = useContext(Scope);
  const host = useContext(Host);
  const registry = useProjection();
  const panel = registry.panel(panelId);
  const [lease, setLease] = useState<{ live: boolean } | null>(null);
  const [mountedInput] = useState(() => ({ value: input }));
  const delivered = useRef(false);
  const nested = useMemo<BorrowScope | null>(() => scope === null ? null : ({
    ...scope, ancestors: [...scope.ancestors, panelId],
    live: () => lease?.live === true && scope.live(),
  }), [scope, panelId, lease]);
  useLayoutEffect(() => {
    if (scope === null || !scope.live() || scope.ancestors.includes(panelId) ||
        scope.ancestors.length >= MAX_BORROWED_PANELS || scope.budget.size >= MAX_BORROWED_PANELS) return;
    const token = Symbol();
    const current = { live: true };
    scope.budget.add(token);
    setLease(current);
    return () => { current.live = false; scope.budget.delete(token); };
  }, [scope, panelId]);
  if (scope === null || host === null || nested === null) return <Empty>Panel host unavailable.</Empty>;
  if (scope.ancestors.includes(panelId)) return <Empty>Panel unavailable: recursive borrowing.</Empty>;
  if (lease?.live !== true) return <Empty>Panel unavailable: intake limit reached.</Empty>;
  if (panel === null || !panel.enabled || panel.Component === null) {
    const Placeholder = registry.Placeholder;
    return <Placeholder name={panel?.title ?? panelId}
      state={panel === null ? "unknown" : panel.enabled ? "unavailable" : "disabled"} />;
  }
  const Component = panel.Component;
  const Boundary = registry.ErrorBoundary;
  return <Scope value={nested}><Boundary><Component host={host} input={mountedInput}
    onResult={(result) => {
      if (!nested.live() || delivered.current) return;
      delivered.current = true;
      onResult(result);
    }} /></Boundary></Scope>;
}

/** Remounting a resource store must not repeat a result or hand an old selection to a new viewer. */
export function PanelIntakeGate(props: Parameters<typeof IntakeLifetime>[0]): ReactElement {
  return props.input === undefined && props.onResult === undefined
    ? <>{props.children(undefined)}</> : <IntakeLifetime {...props} />;
}

function IntakeLifetime({ host, input, onResult, children }: PanelProps & {
  readonly children: (onResult: PanelProps["onResult"]) => ReactNode;
}): ReactElement {
  const identity = useRef({ input, client: host.client, token: host.token, containerId: host.containerId, delivered: false });
  if (identity.current.input !== input) {
    identity.current = { input, client: host.client, token: host.token, containerId: host.containerId, delivered: false };
  }
  const current = identity.current;
  const latest = useRef({ host, input, onResult });
  latest.current = { host, input, onResult };
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const sameHost = (): boolean => current.client === latest.current.host.client &&
    current.token === latest.current.host.token && current.containerId === latest.current.host.containerId;
  if ((input !== undefined || onResult !== undefined) && !sameHost()) {
    return <Empty>Intake retired: its host identity changed. Start a new intake.</Empty>;
  }
  return <>{children(onResult === undefined ? undefined : (result) => {
    if (!live.current || identity.current !== current || !sameHost() || current.delivered) return;
    const parsed = PanelResultSchema.parse(result);
    current.delivered = true;
    latest.current.onResult?.(parsed);
  })}</>;
}

/** Capture native Files only in the receiving owner's store; workers receive its descriptors. */
export function MountedPanelInput(props: Parameters<typeof InputCustody>[0]): ReactElement | null {
  return props.input === undefined && props.onResult === undefined
    ? <>{props.children(undefined, undefined)}</> : <InputCustody {...props} />;
}

function InputCustody({ resources, input, onResult, children }: {
  readonly resources: MountedByteResources;
  readonly input: PanelProps["input"];
  readonly onResult: PanelProps["onResult"];
  readonly children: (input: PortablePanelInput | undefined, onResult: PanelProps["onResult"]) => ReactNode;
}): ReactElement | null {
  const callback = useRef(onResult);
  callback.current = onResult;
  const currentInput = useRef(input);
  currentInput.current = input;
  const [mounted, setMounted] = useState<{
    source: PanelProps["input"]; resources: MountedByteResources;
    input: PortablePanelInput | undefined; live: boolean; error: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const held = { source: input, resources, input: undefined as PortablePanelInput | undefined,
      captured: [] as readonly LocalFileDescriptor[], live: true, error: false };
    try {
      if (input !== undefined) {
        if (input.value !== undefined && !validPanelArg(input.value)) throw new Error("invalid panel input");
        held.captured = input.files?.length ? resources.services.capture(input.files) : [];
        held.input = PortablePanelInputSchema.parse({ value: input.value, files: held.captured });
      }
    } catch { held.error = true; }
    setMounted(held);
    return () => {
      held.live = false;
      for (const file of held.captured) void resources.localFiles.release(file.handle);
    };
  }, [resources, input]);
  if (mounted === null || mounted.source !== input || mounted.resources !== resources) return null;
  if (mounted.error) return <Empty>Panel input unavailable: invalid or over its custody limit.</Empty>;
  return <>{children(mounted.input, onResult === undefined ? undefined : (result) => {
    if (mounted.live && resources.isLive && currentInput.current === mounted.source) callback.current?.(result);
  })}</>;
}
