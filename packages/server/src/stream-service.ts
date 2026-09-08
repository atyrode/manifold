import { randomUUID } from "node:crypto";
import {
  compileStreamBodySchema,
  formatManifoldUri,
  type ManifoldRef,
  type StreamDescriptor,
  type StreamOpen,
  type StreamServerMessage,
  type StreamBody,
} from "@manifold/protocol";
import type { Assembly, StreamProducer } from "@manifold/plugin";
export interface StreamSubscriber {
  send(message: StreamServerMessage, authorized?: () => boolean): boolean;
  allows(kind: string, node: ManifoldRef): boolean;
  close(reason: string): void;
}
interface RetainedFrame {
  seq: number;
  body: StreamBody;
  bytes: number;
}
interface Subscription {
  id: string;
  subscriber: StreamSubscriber;
  active: boolean;
}
interface Instance {
  kind: string;
  node: ManifoldRef;
  plugin: string;
  epoch: string;
  descriptor: StreamDescriptor;
  assembly: Assembly;
  parse: (body: unknown) => StreamBody;
  seq: number;
  bytes: number;
  frames: RetainedFrame[];
  subscriptions: Set<Subscription>;
  closed: boolean;
  gracefulClose: boolean;
  closeListeners: Set<() => void>;
  lifecycle: (phase: "open" | "close", epoch: string) => void;
}

/** Live memory only. Lifecycle attribution is supplied by the traced action owner. */
export class StreamService {
  private readonly instances = new Map<string, Instance>();
  constructor(
    private readonly assembly: () => Assembly,
    private readonly owns: (plugin: string, node: ManifoldRef) => boolean,
  ) {}

  private key(kind: string, node: ManifoldRef): string {
    return `${kind}\n${formatManifoldUri(node)}`;
  }

  open(
    plugin: string,
    kind: string,
    node: ManifoldRef,
    lifecycle: Instance["lifecycle"],
  ): StreamProducer {
    const assembly = this.assembly();
    const entry = assembly.streams.get(kind);
    if (
      entry === undefined ||
      entry.plugin !== plugin ||
      !assembly.enabled(plugin) ||
      !entry.descriptor.nodeKinds.includes(node.kind) ||
      !this.owns(plugin, node)
    ) {
      throw new Error("stream producer refused");
    }
    const key = this.key(kind, node);
    if (this.instances.has(key)) throw new Error("stream producer already open");
    let count = 0;
    for (const instance of this.instances.values()) if (instance.kind === kind) count++;
    if (count >= entry.descriptor.maxInstances) throw new Error("stream instance limit");
    const schema = compileStreamBodySchema(entry.descriptor.body);
    const instance: Instance = {
      kind,
      node: structuredClone(node),
      plugin,
      epoch: randomUUID(),
      descriptor: entry.descriptor,
      assembly,
      parse: (body) => schema.parse(body),
      seq: 0,
      bytes: 0,
      frames: [],
      subscriptions: new Set(),
      closed: false,
      gracefulClose: false,
      closeListeners: new Set(),
      lifecycle,
    };
    lifecycle("open", instance.epoch);
    this.instances.set(key, instance);
    return {
      epoch: instance.epoch,
      get closed() {
        return instance.closed;
      },
      publish: (body) => this.publish(instance, body),
      close: () => this.closeInstance(instance, "producer_closed"),
      onClose: (listener) => {
        if (instance.closed) listener();
        else instance.closeListeners.add(listener);
        return () => {
          instance.closeListeners.delete(listener);
        };
      },
    };
  }

  private current(instance: Instance, draining = false): boolean {
    const assembly = this.assembly();
    if (assembly !== instance.assembly) {
      const descriptor = assembly.streams.get(instance.kind)?.descriptor;
      if (
        descriptor === undefined ||
        JSON.stringify(descriptor) !== JSON.stringify(instance.descriptor)
      )
        return false;
      instance.descriptor = descriptor;
      instance.assembly = assembly;
    }
    return (
      (!instance.closed || (draining && instance.gracefulClose)) &&
      assembly.enabled(instance.plugin) &&
      this.owns(instance.plugin, instance.node)
    );
  }

  private publish(instance: Instance, raw: unknown): void {
    if (!this.current(instance)) {
      this.closeInstance(instance, "producer_unavailable");
      throw new Error("stream producer closed");
    }
    // Parsing makes an owned immutable-by-convention value before retention or fanout.
    const body = instance.parse(raw);
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    if (bodyBytes > instance.descriptor.maxFrameBytes) throw new Error("stream frame limit");
    if (instance.seq === Number.MAX_SAFE_INTEGER) {
      this.closeInstance(instance, "sequence_exhausted");
      throw new Error("stream sequence exhausted");
    }
    const seq = instance.seq + 1;
    const bytes = Buffer.byteLength(JSON.stringify({ seq, body })) + 1;
    if (bytes + 2 > instance.descriptor.maxRingBytes) throw new Error("stream ring frame limit");
    instance.seq = seq;
    const frame = { seq, body, bytes };
    instance.frames.push(frame);
    instance.bytes += bytes;
    while (
      instance.frames.length > instance.descriptor.maxRingFrames ||
      instance.bytes + 2 > instance.descriptor.maxRingBytes
    ) {
      const removed = instance.frames.shift();
      if (removed !== undefined) instance.bytes -= removed.bytes;
    }
    for (const subscription of instance.subscriptions) {
      this.deliver(instance, subscription, {
        type: "stream_frame",
        subscriptionId: subscription.id,
        epoch: instance.epoch,
        seq: frame.seq,
        body: frame.body,
      });
    }
  }

  subscribe(request: StreamOpen, subscriber: StreamSubscriber): () => void {
    const instance = this.instances.get(this.key(request.kind, request.node));
    if (
      instance === undefined ||
      !this.current(instance) ||
      !subscriber.allows(request.kind, request.node)
    ) {
      if (
        !subscriber.send({
          type: "stream_refused",
          subscriptionId: request.subscriptionId,
          reason: "unavailable",
        })
      )
        subscriber.close("stream control overflow");
      return () => {};
    }
    const subscription: Subscription = { id: request.subscriptionId, subscriber, active: true };
    instance.subscriptions.add(subscription);
    const first = instance.frames[0]?.seq ?? instance.seq + 1;
    if (request.cursor !== undefined) {
      if (request.cursor.epoch !== instance.epoch || request.cursor.seq > instance.seq) {
        this.deliver(instance, subscription, {
          type: "stream_reset",
          subscriptionId: subscription.id,
          epoch: instance.epoch,
          reason: "epoch_changed",
        });
      } else if (request.cursor.seq < first - 1) {
        this.deliver(instance, subscription, {
          type: "stream_gap",
          subscriptionId: subscription.id,
          epoch: instance.epoch,
          fromSeq: request.cursor.seq + 1,
          toSeq: first - 1,
        });
      }
    }
    // One synchronous handoff: nothing can publish between this watermark and registration.
    this.deliver(instance, subscription, {
      type: "stream_snapshot",
      subscriptionId: subscription.id,
      kind: instance.kind,
      node: instance.node,
      epoch: instance.epoch,
      firstSeq: first,
      lastSeq: instance.seq,
      frames: instance.frames.map(({ seq, body }) => ({ seq, body })),
    });
    return () => {
      subscription.active = false;
      instance.subscriptions.delete(subscription);
    };
  }

  private deliver(
    instance: Instance,
    subscription: Subscription,
    message: StreamServerMessage,
  ): void {
    const authorized = (): boolean => {
      if (!subscription.active) return false;
      if (
        this.current(instance, true) &&
        subscription.subscriber.allows(instance.kind, instance.node)
      )
        return true;
      subscription.active = false;
      instance.subscriptions.delete(subscription);
      if (
        !subscription.subscriber.send({
          type: "stream_refused",
          subscriptionId: subscription.id,
          reason: "unavailable",
        })
      )
        subscription.subscriber.close("stream control overflow");
      return false;
    };
    if (!authorized()) return;
    if (!subscription.subscriber.send(message, authorized)) {
      subscription.active = false;
      instance.subscriptions.delete(subscription);
      // A bounded sender cannot promise space for a resync control. Named connection closure
      // lets the existing pooled reconnect path reopen without concealing discarded frames.
      subscription.subscriber.close("stream resync required");
    }
  }

  private closeInstance(instance: Instance, reason: string): void {
    if (instance.closed) return;
    instance.closed = true;
    instance.gracefulClose = reason === "producer_closed";
    this.instances.delete(this.key(instance.kind, instance.node));
    for (const subscription of instance.subscriptions) {
      if (!instance.gracefulClose) subscription.active = false;
      if (
        !subscription.subscriber.send({
          type: "stream_closed",
          subscriptionId: subscription.id,
          reason,
        })
      )
        subscription.subscriber.close("stream control overflow");
    }
    instance.subscriptions.clear();
    instance.frames = [];
    instance.bytes = 0;
    try {
      instance.lifecycle("close", instance.epoch);
    } finally {
      for (const listener of instance.closeListeners) {
        try {
          listener();
        } catch (error) {
          console.error("evt=stream_close_listener_failed", error);
        }
      }
      instance.closeListeners.clear();
    }
  }

  reconcile(): void {
    for (const instance of this.instances.values()) {
      if (!this.current(instance)) this.closeInstance(instance, "producer_unavailable");
    }
  }

  shutdown(): void {
    for (const instance of this.instances.values()) this.closeInstance(instance, "shutdown");
  }
}
