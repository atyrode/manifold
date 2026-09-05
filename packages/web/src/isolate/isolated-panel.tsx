import { panelRefId, type HostServices, type PanelProps } from "@manifold/plugin";
import type { UiNode } from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from "react";
import { VocabularyRenderer } from "./vocabulary.tsx";
import { WorkerRegistry, type WorkerLease } from "./worker-host.ts";

/**
 * THE PANEL AN INSTALLED PLUGIN GETS (ADR 0016 §1, §3): a tile ref exactly like an in-tree
 * panel's — same `PanelProps`, same host ref, same outlet — whose body is whatever tree the
 * plugin's worker last rendered for this instance, painted through the vocabulary. It holds
 * one instance id, mounts it on the plugin's worker for the life of the tile, forwards every
 * control event, and shows the two states the worker cannot: a spinner until the first
 * `render`, and a danger-toned `empty` naming the fault when the worker or its program breaks.
 *
 * WHICH WORKER. One registry per page holds a worker per (plugin, container) — see
 * `WorkerRegistry` — so every instance of every panel of one plugin shares a worker, and a
 * panel that stays mounted while the viewer moves to another container re-keys onto a worker
 * initialised for it (the `key` below remounts the instance, which is the honest thing: the
 * guest's `init` said where the viewer was, and that is no longer true).
 */

const WORKERS = new WorkerRegistry();

interface IsolatedInstanceProps {
  readonly pluginId: string;
  readonly panelId: string;
  readonly host: HostServices;
}

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "tree"; readonly tree: UiNode }
  | { readonly kind: "fault"; readonly error: string };

const LOADING: PanelState = { kind: "loading" };

function ignoreEvent(): void {}

function IsolatedInstance({ pluginId, panelId, host }: IsolatedInstanceProps): ReactElement {
  const [instance] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<PanelState>(LOADING);
  const lease = useRef<WorkerLease | null>(null);
  /*
    The host ref is read at mount time without being a dependency: the gate rebuilds it on every
    composition change, and re-mounting the instance for each would make the guest re-init a
    panel nobody touched. The newest ref still serves every call — see the second effect.
  */
  const hostAtMount = useEffectEvent((): HostServices => host);

  useEffect(() => {
    const held = WORKERS.acquire(pluginId, hostAtMount());
    lease.current = held;
    const unmount = held.worker.mount(
      instance,
      panelId,
      (tree) => setState({ kind: "tree", tree }),
      (error) => setState({ kind: "fault", error }),
    );
    return () => {
      unmount();
      held.release();
      lease.current = null;
    };
  }, [pluginId, panelId, instance]);

  useEffect(() => {
    lease.current?.worker.bind(host);
  }, [host]);

  const onEvent = useCallback(
    (event: string, payload?: unknown): void => {
      lease.current?.worker.event(instance, event, payload);
    },
    [instance],
  );

  switch (state.kind) {
    case "loading": {
      const title = host.assembly.panels.get(panelRefId(pluginId, panelId))?.title;
      return (
        <VocabularyRenderer
          tree={title === undefined ? { type: "spinner" } : { type: "spinner", label: title }}
          onEvent={ignoreEvent}
        />
      );
    }
    case "fault":
      return (
        <VocabularyRenderer
          tree={{ type: "empty", text: state.error }}
          onEvent={ignoreEvent}
          tone="danger"
        />
      );
    case "tree":
      return <VocabularyRenderer tree={state.tree} onEvent={onEvent} />;
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled panel state ${String(unreachable)}`);
    }
  }
}

const COMPONENTS = new Map<string, ComponentType<PanelProps>>();

/**
 * The component the composition resolves for a panel of an installed plugin
 * (`buildBrowserAssembly`): closed over (plugin, panel) so it has `PanelProps` and nothing
 * more, and CACHED by full panel id so the composition's every rebuild resolves the same
 * component — a fresh one per roster change would remount the tile and re-init the guest's
 * panel each time a plugin was toggled.
 */
export function isolatedPanel(pluginId: string, panelId: string): ComponentType<PanelProps> {
  const id = panelRefId(pluginId, panelId);
  const cached = COMPONENTS.get(id);
  if (cached !== undefined) return cached;
  const IsolatedPanel = ({ host }: PanelProps): ReactElement => (
    <IsolatedInstance
      key={host.containerId ?? ""}
      pluginId={pluginId}
      panelId={panelId}
      host={host}
    />
  );
  IsolatedPanel.displayName = `IsolatedPanel(${id})`;
  COMPONENTS.set(id, IsolatedPanel);
  return IsolatedPanel;
}
