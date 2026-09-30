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
import { ByteSurfaceProvider, Empty, type ByteSurfaceServices } from "@manifold/ui";
import {
  createElement,
  useLayoutEffect,
  useMemo,
  useState,
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
  readonly services: ByteSurfaceServices;
  private readonly projections = new Set<ByteImageReadHandle>();
  private readonly downloads = new Set<ByteDownloadHandle>();
  private live = true;

  constructor(client: SessionHandle) {
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

export function MountedByteSurface({
  host,
  children,
}: {
  readonly host: HostServices;
  readonly children: (resources: MountedByteResources) => ReactNode;
}): ReactElement | null {
  const [mounted, setMounted] = useState<{
    client: SessionHandle;
    token: string;
    containerId: string | null;
    resources: MountedByteResources;
  } | null>(null);
  useLayoutEffect(() => {
    const resources = new MountedByteResources(host.client);
    setMounted({
      client: host.client,
      token: host.token,
      containerId: host.containerId,
      resources,
    });
    return () => resources.close();
  }, [host.client, host.token, host.containerId]);
  if (
    mounted === null ||
    mounted.client !== host.client ||
    mounted.token !== host.token ||
    mounted.containerId !== host.containerId
  )
    return null;
  return (
    <ByteSurfaceProvider services={mounted.resources.services}>
      <BorrowedPanelHost host={host} resources={mounted.resources}>
        {children(mounted.resources)}
      </BorrowedPanelHost>
    </ByteSurfaceProvider>
  );
}

/** A portable page contribution receives the same narrow, bearer-free surface as a worker. */
function portableHost(host: HostServices, localFiles: LocalFilesHandle): PortableHostServices {
  const client = host.client;
  return {
    principal: host.principal,
    containerId: host.containerId,
    topics: host.topics,
    navigate: host.navigate,
    authoring: host.authoring,
    localFiles,
    client: {
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
    },
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
      portable
        ? portableHost(host, resources.localFiles)
        : { ...host, localFiles: resources.localFiles },
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
        <MountedByteSurface host={host}>
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
        </MountedByteSurface>
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
  const bound = useMemo(() => portableHost(host, resources.localFiles), [host, resources]);
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
    const element = useMemo(
      () => (portable ? portableElementProjection(props["id"], props["data"]) : null),
      [portable, props["id"], props["data"]],
    );
    if (portable) {
      if (scope === null || element === null) return <Empty>Element projection unavailable.</Empty>;
      return (
        <MountedByteSurface host={scope.host}>
          {(resources) => (
            <PortableElementBody
              Component={Component}
              host={scope.host}
              element={element}
              resources={resources}
            />
          )}
        </MountedByteSurface>
      );
    }
    const child = createElement(
      Component as ComponentType<Readonly<Record<string, unknown>>>,
      props,
    );
    return scope === null ? (
      child
    ) : (
      <MountedByteSurface host={scope.host}>{() => child}</MountedByteSurface>
    );
  };
  cache.set(Component, Adapted);
  return Adapted;
}
