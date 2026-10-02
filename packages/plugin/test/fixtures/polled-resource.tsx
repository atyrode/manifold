import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { MachineSummary, ManifoldRef } from "@manifold/protocol";
import type { FeedEvents } from "../../src/host.ts";
import {
  MACHINES_RESOURCE_OPTIONS,
  polledFeedReport,
  usePolledResource,
} from "../../src/polled-resource.ts";

import type { FeedRead } from "./polled-resource-contract.ts";

const requests: FeedRead[] = [];
const values = new Map<string, string>();
const parameters = new URLSearchParams(window.location.search);
const initialStatus = parameters.get("initialStatus") === "connecting" ? "connecting" : "open";
const pending = new Map<
  number,
  {
    readonly request: FeedRead;
    readonly snapshot: string;
    readonly resolve: (value: string) => void;
    readonly reject: (reason: unknown) => void;
  }
>();
const doors = new Map<
  string,
  FeedEvents & {
    readonly handlers: Set<(event: unknown) => void>;
  }
>();

function Reader({ name, destination }: { readonly name: string; readonly destination: string }) {
  const [revision, setRevision] = useState(0);
  const [doorVersion, setDoorVersion] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [holding, setHolding] = useState(false);
  const [ignoreValue, setIgnoreValue] = useState(false);
  const [accepted, setAccepted] = useState(0);
  const [status, setStatus] = useState("idle");
  const [draft, setDraft] = useState("");
  const doorId = `${destination}:${String(doorVersion)}`;
  let events = doors.get(doorId);
  if (events === undefined) {
    const handlers = new Set<(event: unknown) => void>();
    events = {
      handlers,
      status: doorVersion === 0 ? initialStatus : "open",
      subscribe(_topics, handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      on: () => () => undefined,
      workspaceEventsAvailable: () => true,
      onAuthorityChange: () => () => undefined,
      syncSubscriptions: async () => true,
    };
    doors.set(doorId, events);
  }
  const { value, refresh } = usePolledResource(
    () => {
      const request = { id: requests.length + 1, reader: name, destination, revision };
      const response = Promise.withResolvers<string>();
      requests.push(request);
      pending.set(request.id, {
        request,
        snapshot: values.get(destination) ?? "initial",
        resolve: response.resolve,
        reject: response.reject,
      });
      return response.promise;
    },
    60_000,
    {
      key: "fixture.readDestination",
      restartKey: destination,
      initial: `loading:${destination}`,
      enabled,
      events,
      topics: [{ kind: "plugin", pluginId: `fixture.${destination}` }],
      hold: () => holding,
      equal: (current, incoming) =>
        ignoreValue ? current.split(":")[0] === incoming.split(":")[0] : current === incoming,
      onError: () => {
        setStatus(`error:${destination}:${String(revision)}`);
      },
      onSuccess: () => {
        setAccepted((count) => count + 1);
        setStatus(`ok:${destination}:${String(revision)}`);
      },
    },
  );
  return (
    <section data-reader={name} data-destination={destination} data-revision={revision}>
      <output data-testid={`${name}-value`}>{value}</output>
      <output data-testid={`${name}-accepted`}>{accepted}</output>
      <output data-testid={`${name}-status`}>{status}</output>
      <input
        aria-label={`${name} draft`}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <button data-testid={`${name}-refresh`} onClick={refresh}>
        Refresh
      </button>
      <button data-testid={`${name}-revision`} onClick={() => setRevision((value) => value + 1)}>
        New callback
      </button>
      <button
        data-testid={`${name}-rebind`}
        onClick={() => {
          setRevision((value) => value + 1);
          setDoorVersion((value) => value + 1);
        }}
      >
        New callback and socket
      </button>
      <button data-testid={`${name}-enabled`} onClick={() => setEnabled((value) => !value)}>
        Toggle reader
      </button>
      <button data-testid={`${name}-holding`} onClick={() => setHolding((value) => !value)}>
        Toggle hold
      </button>
      <button data-testid={`${name}-equal`} onClick={() => setIgnoreValue((value) => !value)}>
        Toggle equality
      </button>
    </section>
  );
}

function App() {
  const [first, setFirst] = useState("A");
  const [second, setSecond] = useState("A");
  return (
    <>
      <button
        data-testid="first-retarget"
        onClick={() => setFirst((value) => (value === "A" ? "B" : "A"))}
      >
        Retarget first
      </button>
      <button
        data-testid="second-retarget"
        onClick={() => setSecond((value) => (value === "A" ? "B" : "A"))}
      >
        Retarget second
      </button>
      <Reader name="first" destination={first} />
      <Reader name="second" destination={second} />
    </>
  );
}

const MACHINE_TOPIC = { kind: "plugin", pluginId: "core.machines" } as const;
const ROSTER_TOPIC = { kind: "plugin", pluginId: "engine.plugins" } as const;
let inventoryEnabled = true;
let inventoryOnline = parameters.get("initialOnline") === "true";
const inventoryRequests: { id: number; enabled: boolean; online: boolean }[] = [];
const inventoryPending = new Map<number, () => void>();
const inventorySubscriptions = new Set<{
  readonly topics: readonly ManifoldRef[];
  readonly handler: (event: unknown) => void;
}>();
const inventoryEvents: FeedEvents = {
  status: "open",
  subscribe(topics, handler) {
    const record = { topics, handler };
    inventorySubscriptions.add(record);
    return () => {
      inventorySubscriptions.delete(record);
    };
  },
  on: () => () => undefined,
  workspaceEventsAvailable: () => true,
  onAuthorityChange: () => () => undefined,
  syncSubscriptions: async () => true,
};

function inventoryEvent(topic: typeof MACHINE_TOPIC | typeof ROSTER_TOPIC, kind: string): void {
  for (const record of inventorySubscriptions) {
    if (
      record.topics.some(
        (subscribed) => subscribed.kind === "plugin" && subscribed.pluginId === topic.pluginId,
      )
    ) {
      record.handler({ topic, kind, plugin: topic.pluginId, payload: { plugin: "core.machines" } });
    }
  }
}

function InventoryReader({ name }: { readonly name: string }) {
  const [failure, setFailure] = useState<string | null>(null);
  const { value } = usePolledResource<readonly MachineSummary[] | null>(
    () => {
      const response = Promise.withResolvers<readonly MachineSummary[]>();
      const request = {
        id: inventoryRequests.length + 1,
        enabled: inventoryEnabled,
        online: inventoryOnline,
      };
      inventoryRequests.push(request);
      inventoryPending.set(request.id, () => {
        if (!request.enabled) response.reject(new Error("plugin_disabled"));
        else
          response.resolve([
            {
              id: "machine",
              name: "Machine",
              online: request.online,
              terminalExecution: "unconfined",
            },
          ]);
      });
      return response.promise;
    },
    60_000,
    {
      ...MACHINES_RESOURCE_OPTIONS,
      events: inventoryEvents,
      topics: [MACHINE_TOPIC, ROSTER_TOPIC],
      onError: (reason) => {
        setFailure(reason instanceof Error ? reason.message : "Machine inventory unavailable");
      },
      onSuccess: () => setFailure(null),
    },
  );
  return (
    <section data-inventory-reader={name}>
      <output data-testid={`${name}-inventory`}>
        {value === null ? "UNKNOWN" : value[0]?.online ? "online" : "offline"}
      </output>
      <output data-testid={`${name}-failure`}>{failure ?? "readable"}</output>
    </section>
  );
}

function InventoryApp() {
  return (
    <>
      <InventoryReader name="canvas" />
      <InventoryReader name="composition" />
      <InventoryReader name="fleet" />
    </>
  );
}

// Browser-fixture controls settle the actual hook's I/O, never the feed store or React state.
Object.assign(window, {
  inventoryFeedFixture: {
    requests: inventoryRequests,
    report: polledFeedReport,
    setEnabled(enabled: boolean) {
      inventoryEnabled = enabled;
      inventoryEvent(ROSTER_TOPIC, enabled ? "plugin_enabled" : "plugin_disabled");
    },
    setOnline(online: boolean) {
      inventoryOnline = online;
      inventoryEvent(MACHINE_TOPIC, online ? "machine_online" : "machine_offline");
    },
    finish(id: number) {
      const settle = inventoryPending.get(id);
      if (settle === undefined) throw new Error(`No pending inventory read ${String(id)}`);
      inventoryPending.delete(id);
      settle();
    },
  },
  polledResourceFixture: {
    requests,
    mutate(destination: string, value: string) {
      values.set(destination, value);
    },
    resolve(id: number, value?: string) {
      const response = pending.get(id);
      if (response === undefined) throw new Error(`No pending read ${String(id)}`);
      pending.delete(id);
      response.resolve(`${response.request.destination}:${value ?? response.snapshot}`);
    },
    reject(id: number) {
      const response = pending.get(id);
      if (response === undefined) throw new Error(`No pending read ${String(id)}`);
      pending.delete(id);
      response.reject(new Error("temporary read failure"));
    },
    event(doorId: string) {
      for (const handler of doors.get(doorId)?.handlers ?? []) handler({ kind: "changed" });
    },
    subscriptions() {
      return [...doors]
        .filter(([, door]) => door.handlers.size > 0)
        .map(([id, door]) => [id, door.handlers.size]);
    },
  },
});
const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(parameters.get("scenario") === "machines" ? <InventoryApp /> : <App />);
