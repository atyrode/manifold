import type { HostServices, PanelProps } from "@manifold/plugin";
import { useProjection } from "@manifold/plugin/hooks";
import {
  MAX_BORROWED_PANELS,
  PanelResultSchema,
  PortablePanelInputSchema,
  validPanelArg,
  type LocalFileDescriptor,
  type PortablePanelInput,
} from "@manifold/protocol";
import { BorrowedPanelProvider, Empty, type BorrowedPanelProps } from "@manifold/ui";
import {
  createContext,
  useCallback,
  useContext,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { MountedByteResources } from "./byte-renderer.tsx";

interface BorrowScope {
  readonly ancestors: readonly string[];
  readonly budget: Set<symbol>;
  readonly live: () => boolean;
}
const Scope = createContext<BorrowScope | null>(null);
const Host = createContext<HostServices | null>(null);

export function BorrowedPanelHost({
  host,
  resources,
  children,
}: {
  readonly host: HostServices;
  readonly resources: MountedByteResources;
  readonly children: ReactNode;
}): ReactElement {
  const parent = useContext(Scope);
  const scope = useMemo<BorrowScope>(
    () => ({
      ancestors: parent?.ancestors ?? [],
      budget: parent?.budget ?? new Set(),
      live: () => resources.isLive && (parent?.live() ?? true),
    }),
    [parent, resources],
  );
  return (
    <Host value={host}>
      <Scope value={scope}>
        <BorrowedPanelProvider Component={BorrowedPanelMount}>{children}</BorrowedPanelProvider>
      </Scope>
    </Host>
  );
}

function BorrowedPanelMount(props: BorrowedPanelProps): ReactElement {
  if (props.input !== undefined && !validPanelArg(props.input))
    return <Empty>Panel input unavailable.</Empty>;
  return <BorrowedPanelInstance key={JSON.stringify([props.panelId, props.input])} {...props} />;
}

/** An uncommitted render owns no slot in the shared subtree budget. */
class BorrowLease {
  private admission: { readonly isLive: () => boolean } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly scope: BorrowScope | null,
    private readonly panelId: string,
  ) {}

  readonly getSnapshot = (): typeof this.admission => this.admission;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(): (() => void) | undefined {
    const scope = this.scope;
    if (
      scope === null ||
      !scope.live() ||
      scope.ancestors.includes(this.panelId) ||
      scope.ancestors.length >= MAX_BORROWED_PANELS ||
      scope.budget.size >= MAX_BORROWED_PANELS
    )
      return;
    const token = Symbol();
    let live = true;
    scope.budget.add(token);
    this.admission = { isLive: () => live && scope.live() };
    for (const listener of this.listeners) listener();
    return () => {
      live = false;
      scope.budget.delete(token);
      this.admission = null;
      for (const listener of this.listeners) listener();
    };
  }
}

function BorrowedPanelInstance({ panelId, input, onResult }: BorrowedPanelProps): ReactElement {
  const scope = useContext(Scope);
  const host = useContext(Host);
  const registry = useProjection();
  const panel = registry.panel(panelId);
  const lease = useMemo(() => new BorrowLease(scope, panelId), [scope, panelId]);
  useLayoutEffect(() => lease.mount(), [lease]);
  const admission = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
  const [mountedInput] = useState(() => ({ value: input }));
  const delivered = useRef(false);
  const nested = useMemo<BorrowScope | null>(
    () =>
      scope === null
        ? null
        : {
            ...scope,
            ancestors: [...scope.ancestors, panelId],
            live: () => admission?.isLive() === true,
          },
    [scope, panelId, admission],
  );
  if (scope === null || host === null || nested === null)
    return <Empty>Panel host unavailable.</Empty>;
  if (scope.ancestors.includes(panelId))
    return <Empty>Panel unavailable: recursive borrowing.</Empty>;
  if (admission === null) return <Empty>Panel unavailable: intake limit reached.</Empty>;
  if (panel === null || !panel.enabled || panel.Component === null) {
    const Placeholder = registry.Placeholder;
    return (
      <Placeholder
        name={panel?.title ?? panelId}
        state={panel === null ? "unknown" : panel.enabled ? "unavailable" : "disabled"}
      />
    );
  }
  const Component = panel.Component;
  const Boundary = registry.ErrorBoundary;
  return (
    <Scope value={nested}>
      <Boundary>
        <Component
          host={host}
          input={mountedInput}
          onResult={(result) => {
            if (!nested.live() || delivered.current) return;
            delivered.current = true;
            onResult(result);
          }}
        />
      </Boundary>
    </Scope>
  );
}

/** Remounting a resource store must not repeat a result or hand an old selection to a new viewer. */
export function PanelIntakeGate(
  props: PanelProps & {
    readonly children: (onResult: PanelProps["onResult"]) => ReactNode;
  },
): ReactElement {
  return props.input === undefined && props.onResult === undefined ? (
    <>{props.children(undefined)}</>
  ) : (
    <IntakeIdentity {...props} />
  );
}

function IntakeIdentity(
  props: PanelProps & {
    readonly children: (onResult: PanelProps["onResult"]) => ReactNode;
  },
): ReactElement | null {
  const { host, input } = props;
  const [owner, setOwner] = useState({
    input,
    client: host.client,
    token: host.token,
    principal: host.principal.id,
    containerId: host.containerId,
    retired: false,
    generation: 0,
  });
  if (owner.input !== input) {
    setOwner({
      input,
      client: host.client,
      token: host.token,
      principal: host.principal.id,
      containerId: host.containerId,
      retired: false,
      generation: owner.generation + 1,
    });
    return null;
  }
  if (
    !owner.retired &&
    (owner.client !== host.client ||
      owner.token !== host.token ||
      owner.principal !== host.principal.id ||
      owner.containerId !== host.containerId)
  ) {
    setOwner({ ...owner, retired: true });
    return null;
  }
  if (owner.retired)
    return <Empty>Intake retired: its host identity changed. Start a new intake.</Empty>;
  return <IntakeLifetime key={owner.generation} {...props} />;
}

/** Imperative result ownership belongs to one committed intake, never to a render. */
class IntakeResultLease {
  private delivered = false;
  private live = false;
  private callback: PanelProps["onResult"];

  setCallback(callback: PanelProps["onResult"]): void {
    this.callback = callback;
  }

  mount(): () => void {
    this.live = true;
    return () => {
      this.live = false;
    };
  }

  readonly deliver: NonNullable<PanelProps["onResult"]> = (value) => {
    if (!this.live || this.delivered) return;
    const parsed = PanelResultSchema.parse(value);
    this.delivered = true;
    this.callback?.(parsed);
  };
}

function IntakeLifetime({
  onResult,
  children,
}: {
  readonly onResult?: PanelProps["onResult"];
  readonly children: (onResult: PanelProps["onResult"]) => ReactNode;
}): ReactElement {
  const [lease] = useState(() => new IntakeResultLease());
  // Descendant layout effects may complete immediately; install this commit's callback first.
  useInsertionEffect(() => {
    lease.setCallback(onResult);
  }, [lease, onResult]);
  useInsertionEffect(() => lease.mount(), [lease]);
  return <>{children(onResult === undefined ? undefined : lease.deliver)}</>;
}

/** Capture native Files only in the receiving owner's store; workers receive its descriptors. */
export function MountedPanelInput(props: Parameters<typeof InputCustody>[0]): ReactElement | null {
  return props.input === undefined && props.onResult === undefined ? (
    <>{props.children(undefined, undefined)}</>
  ) : (
    <InputCustody {...props} />
  );
}

interface CapturedInput {
  readonly input: PortablePanelInput | undefined;
  readonly error: boolean;
}

class InputLease {
  private captured: readonly LocalFileDescriptor[] = [];
  private snapshot: CapturedInput | null = null;
  private readonly listeners = new Set<() => void>();
  private callback: PanelProps["onResult"];

  constructor(
    private readonly resources: MountedByteResources,
    private readonly input: PanelProps["input"],
  ) {}

  readonly getSnapshot = (): CapturedInput | null => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isCurrent(snapshot: CapturedInput): boolean {
    return this.snapshot === snapshot && this.resources.isLive;
  }

  setCallback(callback: PanelProps["onResult"]): void {
    this.callback = callback;
  }

  deliver(
    snapshot: CapturedInput | null,
    value: Parameters<NonNullable<PanelProps["onResult"]>>[0],
  ): void {
    if (snapshot !== null && this.isCurrent(snapshot)) this.callback?.(value);
  }

  mount(): () => void {
    let input: PortablePanelInput | undefined;
    let error = false;
    try {
      if (this.input !== undefined) {
        if (this.input.value !== undefined && !validPanelArg(this.input.value))
          throw new Error("invalid panel input");
        this.captured = this.input.files?.length
          ? this.resources.services.capture(this.input.files)
          : [];
        input = PortablePanelInputSchema.parse({ value: this.input.value, files: this.captured });
      }
    } catch {
      error = true;
    }
    this.snapshot = { input, error };
    for (const listener of this.listeners) listener();
    return () => {
      this.snapshot = null;
      for (const file of this.captured) void this.resources.localFiles.release(file.handle);
      this.captured = [];
      for (const listener of this.listeners) listener();
    };
  }
}

function InputCustody({
  resources,
  input,
  onResult,
  children,
}: {
  readonly resources: MountedByteResources;
  readonly input: PanelProps["input"];
  readonly onResult: PanelProps["onResult"];
  readonly children: (
    input: PortablePanelInput | undefined,
    onResult: PanelProps["onResult"],
  ) => ReactNode;
}): ReactElement | null {
  const lease = useMemo(() => new InputLease(resources, input), [resources, input]);
  useLayoutEffect(() => lease.mount(), [lease]);
  const mounted = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
  useInsertionEffect(() => {
    lease.setCallback(onResult);
  }, [lease, onResult]);
  const result = useCallback<NonNullable<PanelProps["onResult"]>>(
    (value) => {
      lease.deliver(mounted, value);
    },
    [lease, mounted],
  );
  if (mounted === null) return null;
  if (mounted.error)
    return <Empty>Panel input unavailable: invalid or over its custody limit.</Empty>;
  return <>{children(mounted.input, onResult === undefined ? undefined : result)}</>;
}
