import type {
  HostServices,
  LocalFilesHandle,
  PanelProps,
  PortableElementProps,
  PortableHostServices,
  PortablePanelProps,
  SectionProps,
  PortableSectionProps,
  SessionHandle,
} from "@manifold/plugin";
import { useProjectionScope } from "@manifold/plugin/hooks";
import {
  ByteTransferError,
  PortableElementProjectionSchema,
  type PortableElementProjection,
} from "@manifold/protocol";
import {
  createByteDownloadHandle,
  createByteImageReadHandle,
  type ByteDownloadHandle,
  type ByteImageReadHandle,
} from "@manifold/sdk";
import { ByteRendererProvider, Empty, type ByteRendererServices } from "@manifold/ui";
import {
  createElement,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import { usePortableElementEdit } from "./portable-element-edit.ts";
import { BorrowedPanelHost, MountedPanelInput, PanelIntakeGate } from "./borrowed-panels.tsx";
import { LocalFileStore } from "./local-files.ts";
/** Shared custody owner for both page React and worker vocabulary mounts. */
export class MountedByteResources {
  readonly files = new LocalFileStore();
  readonly localFiles: LocalFilesHandle = {
    read: (handle, offset, length, options) => this.files.read(handle, offset, length, options),
    release: (handle) => this.files.release(handle),
  };
  readonly portableClient: PortableHostServices["client"];
  readonly services: ByteRendererServices;
  private readonly projections = new Set<ByteImageReadHandle>();
  private readonly downloads = new Set<ByteDownloadHandle>();
  private live = true;

  constructor(client: SessionHandle) {
    this.portableClient = portableClient(client);
    this.services = {
      capture: (files) => {
        if (!this.live) throw new ByteTransferError("unavailable");
        return this.files.capture(files);
      },
      project: (source, observer) => {
        if (!this.live) throw new ByteTransferError("unavailable");
        if (this.projections.size >= 4) throw new ByteTransferError("busy");
        const read = createByteImageReadHandle(client, source, {
          ...observer,
          unavailable: (reason) => {
            this.projections.delete(read);
            observer.unavailable(reason);
          },
        });
        this.projections.add(read);
        return {
          close: () => {
            this.projections.delete(read);
            read.close();
          },
          recheck: () => read.recheck(),
          refuse: (reason) => read.refuse(reason),
        };
      },
      download: (source, filename, change) => {
        if (!this.live) throw new ByteTransferError("unavailable");
        if (this.downloads.size >= 4) throw new ByteTransferError("busy");
        const read = createByteDownloadHandle(client, source, filename, {
          handoff: (url, name) => {
            if (!this.live || client.status !== "open") throw new ByteTransferError("unavailable");
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            anchor.rel = "noopener";
            anchor.hidden = true;
            document.body.append(anchor);
            try {
              anchor.click();
            } finally {
              anchor.remove();
            }
          },
          change: (status) => {
            if (status.state !== "downloading") this.downloads.delete(read);
            change(status);
          },
        });
        this.downloads.add(read);
        return {
          close: () => {
            this.downloads.delete(read);
            read.close();
          },
          cancel: () => {
            this.downloads.delete(read);
            read.cancel();
          },
        };
      },
    };
  }

  get isLive(): boolean {
    return this.live;
  }

  close(): void {
    if (!this.live) return;
    this.live = false;
    this.files.close();
    for (const projection of this.projections) projection.close();
    this.projections.clear();
    for (const download of this.downloads) download.close();
    this.downloads.clear();
  }
}

/** Construction is inert; only the committed layout owns native byte resources. */
class ByteResourceLease {
  private resources: MountedByteResources | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: SessionHandle) {}

  readonly getSnapshot = (): MountedByteResources | null => this.resources;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(): () => void {
    const resources = new MountedByteResources(this.client);
    this.resources = resources;
    for (const listener of this.listeners) listener();
    return () => {
      resources.close();
      this.resources = null;
      for (const listener of this.listeners) listener();
    };
  }
}

export function MountedByteRenderer({
  host,
  children,
}: {
  readonly host: HostServices;
  readonly children: (resources: MountedByteResources) => ReactNode;
}): ReactElement | null {
  const [owner, setOwner] = useState({
    client: host.client,
    token: host.token,
    principal: host.principal.id,
    containerId: host.containerId,
    generation: 0,
  });
  if (
    owner.client !== host.client ||
    owner.token !== host.token ||
    owner.principal !== host.principal.id ||
    owner.containerId !== host.containerId
  ) {
    setOwner({
      client: host.client,
      token: host.token,
      principal: host.principal.id,
      containerId: host.containerId,
      generation: owner.generation + 1,
    });
    return null;
  }
  return (
    <ByteRendererLifetime key={owner.generation} host={host}>
      {children}
    </ByteRendererLifetime>
  );
}

function ByteRendererLifetime({
  host,
  children,
}: {
  readonly host: HostServices;
  readonly children: (resources: MountedByteResources) => ReactNode;
}): ReactElement | null {
  const [lease] = useState(() => new ByteResourceLease(host.client));
  useLayoutEffect(() => lease.mount(), [lease]);
  const resources = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
  if (resources === null) return null;
  return (
    <ByteRendererProvider services={resources.services}>
      <BorrowedPanelHost host={host} resources={resources}>
        {children(resources)}
      </BorrowedPanelHost>
    </ByteRendererProvider>
  );
}

/** One bearer-free facade belongs to the committed session owner, not its host metadata. */
function portableClient(client: SessionHandle): PortableHostServices["client"] {
  return {
    action: (name, args) => client.action(name, args),
    readByteChunk: (...args) => client.readByteChunk(...args),
    writeByteChunk: (...args) => client.writeByteChunk(...args),
    place: (...args) => client.place(...args),
    selfCaps: () => client.selfCaps(),
    machines: () => client.machines(),
    resolve: (uri) => client.resolve(uri),
    openStream: (options) => client.openStream(options),
    openTerminal: (options) => client.openTerminal(options),
    sendTerminalInput: (...args) => client.sendTerminalInput(...args),
    terminalsByContainer: () => client.terminalsByContainer(),
    subscribe: (...args) => client.subscribe(...args),
    get status() {
      return client.status;
    },
    on: (...args) => client.on(...args),
  };
}

/** A portable page contribution receives the same narrow, bearer-free surface as a worker. */
function portableHost(host: HostServices, resources: MountedByteResources): PortableHostServices {
  return {
    principal: host.principal,
    containerId: host.containerId,
    topics: host.topics,
    navigate: host.navigate,
    authoring: host.authoring,
    localFiles: resources.localFiles,
    client: resources.portableClient,
  };
}

function ContributionBody({
  Component,
  host,
  arg,
  input,
  onResult,
  portable,
  resources,
}: {
  readonly Component: Contribution;
  readonly host: HostServices;
  readonly arg: PanelProps["arg"];
  readonly input: PanelProps["input"];
  readonly onResult: PanelProps["onResult"];
  readonly portable: boolean;
  readonly resources: MountedByteResources;
}): ReactElement {
  const bound = useMemo(
    () =>
      portable ? portableHost(host, resources) : { ...host, localFiles: resources.localFiles },
    [host, portable, resources],
  );
  return (
    <MountedPanelInput resources={resources} input={input} onResult={onResult}>
      {(captured, result) =>
        portable
          ? createElement(Component as ComponentType<PortablePanelProps>, {
              host: bound as PortableHostServices,
              arg,
              input: captured,
              onResult: result,
            })
          : createElement(Component as ComponentType<PanelProps>, {
              host: bound as HostServices,
              arg,
              input,
              onResult: result,
            })
      }
    </MountedPanelInput>
  );
}

type Contribution =
  | ComponentType<PanelProps>
  | ComponentType<PortablePanelProps>
  | ComponentType<SectionProps>
  | ComponentType<PortableSectionProps>;
const PAGE_COMPONENTS = new WeakMap<Contribution, ComponentType<PanelProps>>();
const PORTABLE_COMPONENTS = new WeakMap<Contribution, ComponentType<PanelProps>>();
export function byteContribution(
  Component: Contribution | undefined,
  portable: boolean,
): ComponentType<PanelProps> | null {
  if (Component === undefined) return null;
  const cache = portable ? PORTABLE_COMPONENTS : PAGE_COMPONENTS;
  const existing = cache.get(Component);
  if (existing !== undefined) return existing;
  const Adapted = ({ host, arg, input, onResult }: PanelProps): ReactElement => (
    <PanelIntakeGate host={host} input={input} onResult={onResult}>
      {(result) => (
        <MountedByteRenderer host={host}>
          {(resources) => (
            <ContributionBody
              Component={Component}
              host={host}
              arg={arg}
              input={input}
              onResult={result}
              portable={portable}
              resources={resources}
            />
          )}
        </MountedByteRenderer>
      )}
    </PanelIntakeGate>
  );
  cache.set(Component, Adapted);
  return Adapted;
}

/** Only this canonical projection crosses into portable element code in either mode. */
export function portableElementProjection(
  id: unknown,
  data: unknown,
): PortableElementProjection | null {
  const parsed = PortableElementProjectionSchema.safeParse({ id, data });
  return parsed.success ? parsed.data : null;
}

function PortableElementBody({
  Component,
  host,
  element,
  resources,
}: {
  readonly Component: ComponentType<never>;
  readonly host: HostServices;
  readonly element: PortableElementProjection;
  readonly resources: MountedByteResources;
}): ReactElement {
  const bound = useMemo(() => portableHost(host, resources), [host, resources]);
  const edit = usePortableElementEdit(element);
  return (
    <div
      className="mf-vocab is-element"
      tabIndex={0}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {createElement(Component as ComponentType<PortableElementProps>, {
        ...element,
        host: bound,
        edit,
      })}
    </div>
  );
}

const ELEMENT_COMPONENTS = new WeakMap<ComponentType<never>, ComponentType<never>>();
const PORTABLE_ELEMENTS = new WeakMap<ComponentType<never>, ComponentType<never>>();
export function byteElement(
  Component: ComponentType<never> | undefined,
  portable: boolean,
): ComponentType<never> | null {
  if (Component === undefined) return null;
  const cache = portable ? PORTABLE_ELEMENTS : ELEMENT_COMPONENTS;
  const existing = cache.get(Component);
  if (existing !== undefined) return existing;
  const Adapted = (props: Readonly<Record<string, unknown>>): ReactElement => {
    const scope = useProjectionScope();
    const { id, data } = props;
    const element = useMemo(
      () => (portable ? portableElementProjection(id, data) : null),
      [id, data],
    );
    if (portable) {
      if (scope === null || element === null) return <Empty>Element projection unavailable.</Empty>;
      return (
        <MountedByteRenderer host={scope.host}>
          {(resources) => (
            <PortableElementBody
              Component={Component}
              host={scope.host}
              element={element}
              resources={resources}
            />
          )}
        </MountedByteRenderer>
      );
    }
    const child = createElement(
      Component as ComponentType<Readonly<Record<string, unknown>>>,
      props,
    );
    return scope === null ? (
      child
    ) : (
      <MountedByteRenderer host={scope.host}>{() => child}</MountedByteRenderer>
    );
  };
  cache.set(Component, Adapted);
  return Adapted;
}
