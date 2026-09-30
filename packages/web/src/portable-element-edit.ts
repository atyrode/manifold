import type { PortableElementEdit } from "@manifold/plugin";
import { useProjectionScope, type ProjectionScope } from "@manifold/plugin/hooks";
import {
  canonicalJobJson,
  elementPayload,
  isElementEnvelopeKey,
  SceneElementPayloadSchema,
  type PortableElementProjection,
} from "@manifold/protocol";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";

class ElementEditLifetime {
  private live = false;
  private elementType: string | undefined;

  constructor(
    readonly binding: {
      readonly client: ProjectionScope["client"] | undefined;
      readonly owner: ProjectionScope["host"]["client"] | undefined;
      readonly token: string | undefined;
      readonly principal: string | undefined;
      readonly containerId: string | null | undefined;
      readonly id: string | undefined;
      readonly expected: string | null;
      readonly epoch: ProjectionScope["client"]["epoch"] | undefined;
    },
  ) {}

  mount(): () => void {
    this.elementType =
      this.binding.id === undefined
        ? undefined
        : this.binding.client?.elements.get(this.binding.id)?.type;
    this.live = true;
    return () => {
      this.live = false;
    };
  }

  get isLive(): boolean {
    return this.live;
  }

  get type(): string | undefined {
    return this.elementType;
  }
}

/** A mount-owned document port, shared by page React and the Worker supervisor. */
export function usePortableElementEdit(
  element: PortableElementProjection | null,
): PortableElementEdit {
  const scope = useProjectionScope();
  const client = scope?.client;
  const owner = scope?.host.client;
  const token = scope?.host.token;
  const principal = scope?.host.principal.id;
  const containerId = scope?.host.containerId;
  const id = element?.id;
  const subscribe = useMemo(
    () =>
      (notify: () => void): (() => void) => {
        if (!client) return () => {};
        const off = [
          client.on("status", notify),
          client.on("scene_authority_changed", notify),
          client.on("scene_reset", notify),
        ];
        return () => {
          for (const release of off) release();
        };
      },
    [client],
  );
  useSyncExternalStore(
    subscribe,
    () =>
      client === undefined
        ? ""
        : `${client.epoch}:${client.status}:${client.sceneWriteAllowed}:${client.spectator}`,
    () => "",
  );
  const expected = element === null ? null : canonicalJobJson(element.data);
  const epoch = client?.epoch;
  const lifetime = useMemo(
    () =>
      new ElementEditLifetime({
        client,
        owner,
        token,
        principal,
        containerId,
        id,
        expected,
        epoch,
      }),
    [client, owner, token, principal, containerId, id, expected, epoch],
  );
  useLayoutEffect(() => lifetime.mount(), [lifetime]);
  const writable =
    client !== undefined &&
    !client.spectator &&
    client.status === "open" &&
    client.sceneWriteAllowed;
  return useMemo<PortableElementEdit>(
    () => ({
      writable: writable && element !== null,
      async patch(data): Promise<void> {
        if (
          !lifetime.isLive ||
          !client ||
          !element ||
          client.epoch !== epoch ||
          client.spectator ||
          client.status !== "open" ||
          !client.sceneWriteAllowed
        )
          throw new Error("Element is no longer writable");
        const patch = SceneElementPayloadSchema.parse(data);
        if (Object.keys(patch).some(isElementEnvelopeKey))
          throw new Error("Only element payload fields may be edited");
        const current = client.elements.get(element.id);
        if (
          !current ||
          current.type !== lifetime.type ||
          canonicalJobJson(elementPayload(current)) !== expected
        ) {
          throw new Error("Element changed; review the current source before applying this edit");
        }
        // This is the existing document path. The canonical room validates the merged payload
        // against the installed owner's schema; no action, replacement file or alternate room.
        client.transact((tx) => {
          if (!tx.patch(element.id, patch)) throw new Error("Element is no longer available");
        });
      },
    }),
    [client, lifetime, element, expected, epoch, writable],
  );
}
