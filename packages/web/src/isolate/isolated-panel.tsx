import {
  panelRefId,
  type HostServices,
  type PanelProps,
  type SectionProps,
  type PortableElementEdit,
} from "@manifold/plugin";
import type {
  PanelArg,
  PortablePanelInput,
  PortableElementProjection,
  UiNode,
} from "@manifold/protocol";
import { useProjectionScope } from "@manifold/plugin/hooks";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useMemo,
  useState,
  type ComponentType,
  type ReactElement,
} from "react";
import { VocabularyRenderer } from "./vocabulary.tsx";
import { WorkerRegistry, type WorkerLease } from "./worker-host.ts";
import {
  type MountedByteResources,
  MountedByteRenderer,
  portableElementProjection,
} from "../byte-renderer.tsx";
import { usePortableElementEdit } from "../portable-element-edit.ts";
import { MountedPanelInput, PanelIntakeGate } from "../borrowed-panels.tsx";

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
  readonly kind: "panel" | "section" | "element";
  readonly portableWorker: boolean;
  readonly arg?: PanelArg | undefined;
  readonly input?: PortablePanelInput | undefined;
  readonly onResult?: ((result: PanelArg) => void) | undefined;
  readonly element?: PortableElementProjection | undefined;
  readonly edit?: PortableElementEdit | undefined;
  readonly host: HostServices;
  readonly resources: MountedByteResources;
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
  input,
  onResult,
  element,
  edit,
  resources,
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
  const propsAtMount = useEffectEvent(() => ({ host, arg, element, edit, input, onResult }));

  useEffect(() => {
    const {
      host: currentHost,
      arg: currentArg,
      element: currentElement,
      edit: currentEdit,
      input: currentInput,
      onResult: currentResult,
    } = propsAtMount();
    const held = WORKERS.acquire(pluginId, currentHost, portableWorker);
    lease.current = held;
    const unmount = held.worker.mount(
      instance,
      panelId,
      (tree) => setState({ kind: "tree", tree, token: currentHost.token }),
      (error) => setState({ kind: "fault", error, token: currentHost.token }),
      {
        kind,
        host: currentHost,
        arg: currentArg,
        element: currentElement,
        edit: currentEdit,
        input: currentInput,
        onResult: currentResult,
        resources,
      },
    );
    return () => {
      unmount();
      held.release();
      lease.current = null;
    };
  }, [pluginId, panelId, kind, portableWorker, instance, host.token, resources, input]);

  useEffect(() => {
    const worker = lease.current?.worker;
    worker?.bind(host);
    worker?.update(instance, host, arg, element, edit);
  }, [host, arg, element, edit, instance]);

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
          : kind === "section"
            ? host.assembly.sections.find(
                (section) => section.plugin === pluginId && section.id === panelId,
              )?.title
            : panelId;
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
  const IsolatedPanel = ({ host, arg, input, onResult }: PanelProps): ReactElement => (
    <PanelIntakeGate host={host} input={input} onResult={onResult}>
      {(result) => (
        <MountedByteRenderer host={host}>
          {(resources) => (
            <MountedPanelInput resources={resources} input={input} onResult={result}>
              {(captured, deliver) => (
                <IsolatedInstance
                  key={host.containerId ?? ""}
                  pluginId={pluginId}
                  panelId={panelId}
                  kind={kind}
                  portableWorker={portableWorker}
                  arg={arg}
                  input={captured}
                  onResult={deliver}
                  host={host}
                  resources={resources}
                />
              )}
            </MountedPanelInput>
          )}
        </MountedByteRenderer>
      )}
    </PanelIntakeGate>
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

const ELEMENT_COMPONENTS = new Map<string, ComponentType<never>>();

/** A hardened element is still a vocabulary mount, never its page renderer as a fallback. */
export function isolatedElement(
  pluginId: string,
  type: string,
  portableWorker = false,
): ComponentType<never> {
  const key = `${pluginId}:${type}:${portableWorker ? "react" : "legacy"}`;
  const cached = ELEMENT_COMPONENTS.get(key);
  if (cached !== undefined) return cached;
  const IsolatedElement = (props: Readonly<Record<string, unknown>>): ReactElement => {
    const scope = useProjectionScope();
    const { id, data } = props;
    const element = useMemo(() => portableElementProjection(id, data), [id, data]);
    const edit = usePortableElementEdit(element);
    if (scope === null || element === null)
      return (
        <VocabularyRenderer
          kind="element"
          tree={{ type: "empty", text: "Element projection unavailable." }}
          onEvent={ignoreEvent}
        />
      );
    return (
      <MountedByteRenderer host={scope.host}>
        {(resources) => (
          <IsolatedInstance
            key={`${scope.host.containerId ?? ""}:${element.id}`}
            pluginId={pluginId}
            panelId={type}
            kind="element"
            portableWorker={portableWorker}
            host={scope.host}
            element={element}
            edit={edit}
            resources={resources}
          />
        )}
      </MountedByteRenderer>
    );
  };
  ELEMENT_COMPONENTS.set(key, IsolatedElement);
  return IsolatedElement;
}
