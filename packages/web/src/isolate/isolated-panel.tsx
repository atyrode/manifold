import {
  panelRefId,
  type HostServices,
  type PanelProps,
  type SectionProps,
} from "@manifold/plugin";
import type { PanelArg, UiNode } from "@manifold/protocol";
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
 * A HARDENED CONTRIBUTION: the same panel or section slot, host and React source, rendered in
 * the plugin's Worker and painted through the closed vocabulary. One mounted instance owns
 * its callbacks, calls and resources. The host paints loading and fault states the guest
 * cannot; a context or panel-argument update does not remount the guest component.
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
  readonly kind: "panel" | "section";
  readonly portableWorker: boolean;
  readonly arg?: PanelArg | undefined;
  readonly host: HostServices;
}

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "tree"; readonly tree: UiNode }
  | { readonly kind: "fault"; readonly error: string };

const LOADING: PanelState = { kind: "loading" };

function ignoreEvent(): void {}

function IsolatedInstance({
  pluginId,
  panelId,
  kind,
  portableWorker,
  host,
  arg,
}: IsolatedInstanceProps): ReactElement {
  const [instance] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<PanelState & { readonly token: string }>(() => ({
    ...LOADING,
    token: host.token,
  }));
  const lease = useRef<WorkerLease | null>(null);
  /*
    The host ref is read at mount time without being a dependency: the gate rebuilds it on every
    composition change, and re-mounting the instance for each would make the guest re-init a
    panel nobody touched. Credential changes acquire a fresh supervisor; all other host
    changes still serve every call through the second effect.
  */
  const propsAtMount = useEffectEvent(() => ({ host, arg }));

  useEffect(() => {
    const { host: currentHost, arg: currentArg } = propsAtMount();
    const held = WORKERS.acquire(pluginId, currentHost, portableWorker);
    lease.current = held;
    const unmount = held.worker.mount(
      instance,
      panelId,
      (tree) => setState({ kind: "tree", tree, token: currentHost.token }),
      (error) => setState({ kind: "fault", error, token: currentHost.token }),
      { kind, host: currentHost, arg: currentArg },
    );
    return () => {
      unmount();
      held.release();
      lease.current = null;
    };
  }, [pluginId, panelId, kind, portableWorker, instance, host.token]);

  useEffect(() => {
    const worker = lease.current?.worker;
    worker?.bind(host);
    worker?.update(instance, host, arg);
  }, [host, arg, instance]);

  const onEvent = useCallback(
    (event: string, payload?: unknown): void => {
      lease.current?.worker.event(instance, event, payload);
    },
    [instance],
  );

  const currentState = state.token === host.token ? state : LOADING;
  switch (currentState.kind) {
    case "loading": {
      const title =
        kind === "panel"
          ? host.assembly.panels.get(panelRefId(pluginId, panelId))?.title
          : host.assembly.sections.find(
              (section) => section.plugin === pluginId && section.id === panelId,
            )?.title;
      return (
        <VocabularyRenderer
          tree={title === undefined ? { type: "spinner" } : { type: "spinner", label: title }}
          onEvent={ignoreEvent}
          kind={kind}
        />
      );
    }
    case "fault":
      return (
        <VocabularyRenderer
          tree={{ type: "empty", text: currentState.error }}
          onEvent={ignoreEvent}
          tone="danger"
          kind={kind}
        />
      );
    case "tree":
      return <VocabularyRenderer tree={currentState.tree} onEvent={onEvent} kind={kind} />;
    default: {
      const unreachable: never = currentState;
      throw new Error(`unhandled panel state ${String(unreachable)}`);
    }
  }
}

const COMPONENTS = new Map<string, ComponentType<PanelProps>>();

/** Stable component identity across roster recomposition; execution mode is part of the key. */
function isolatedContribution(
  pluginId: string,
  panelId: string,
  kind: "panel" | "section",
  portableWorker: boolean,
): ComponentType<PanelProps> {
  const id = `${kind}:${panelRefId(pluginId, panelId)}:${portableWorker ? "react" : "legacy"}`;
  const cached = COMPONENTS.get(id);
  if (cached !== undefined) return cached;
  const IsolatedPanel = ({ host, arg }: PanelProps): ReactElement => (
    <IsolatedInstance
      key={host.containerId ?? ""}
      pluginId={pluginId}
      panelId={panelId}
      kind={kind}
      portableWorker={portableWorker}
      arg={arg}
      host={host}
    />
  );
  IsolatedPanel.displayName = `IsolatedPanel(${id})`;
  COMPONENTS.set(id, IsolatedPanel);
  return IsolatedPanel;
}

export function isolatedPanel(
  pluginId: string,
  panelId: string,
  portableWorker = false,
): ComponentType<PanelProps> {
  return isolatedContribution(pluginId, panelId, "panel", portableWorker);
}

export function isolatedSection(
  pluginId: string,
  sectionId: string,
  portableWorker = false,
): ComponentType<SectionProps> {
  return isolatedContribution(pluginId, sectionId, "section", portableWorker);
}
