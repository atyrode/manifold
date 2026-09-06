import { emissionRefusal, type Assembly } from "@manifold/plugin";
import {
  CONNECTION_BODIES,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  formatManifoldUri,
  topicMatches,
  type EventKind,
  type EventPayload,
  type ManifoldRef,
  type RuntimeDeps,
} from "@manifold/protocol";
import type { AuthContext } from "./auth.ts";
import type { Logger } from "./log.ts";

/**
 * THE EVENT PLANE'S ONE MECHANISM (ADR 0012): a subscription registry, a matching rule, and a
 * fan-out that arbitrates who may hear what.
 *
 * It is FLOOR by both criteria the foundation law names. Neutrality: it knows no kind, no
 * plugin and no section — the vocabulary arrives from the assembly and the audience arrives
 * from sockets, and swapping every plugin in the build changes nothing here. Arbitration: it
 * decides which subscriber hears an emission, a question no plugin can answer about another
 * plugin's node, and it answers it with the SAME authority discharge `/api/resolve` performs
 * for a node read — one permission vocabulary, per ADR 0012 §2.
 *
 * What it deliberately is NOT: a queue. No offsets, no acknowledgements, no replay, no
 * delivery guarantee beyond "delivered to the sockets subscribed at the instant of emission".
 * Catch-up is reading state through the doors a fresh client already uses, and durable history
 * is the `events` table this class appends to — as a table read by `core.events.list`, never a
 * stream a consumer positions itself in.
 *
 * And it is not a second way to change the world. Nothing here mutates anything: `emit` is
 * called BY the doors, after they have committed, and an event carries no way to answer it.
 */

/**
 * THE AUTHORITY SEAM, as this mechanism needs it: one question, spelled the way `/api/resolve`
 * spells it. `AuthService` satisfies it structurally, which is what keeps "may I subscribe to
 * this node" and "may I resolve this node" from becoming two answers to one question
 * (invariant 14).
 */
export interface EventAuthority {
  allows(context: AuthContext, cap: "containers:read", containerId?: string): boolean;
}

/**
 * The durable half: `ServerStore.addEvent`, named by the one method used. There is no second
 * history — every emission lands in the same append-only table, pruned by the same retention,
 * read back by the same action.
 */
export interface EventHistory {
  addEvent(
    containerId: string | null,
    ts: number,
    principalId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * The ONE state-resolved edge in the topic tree: which container a terminal currently lives
 * in. `TerminalBroker.placedTerminal` satisfies it, and it is the same lookup the resolve door
 * performs before authorizing a terminal read (`http.ts`, the `terminal` case) — so the tree
 * events are matched over and the tree authority is discharged over are one tree.
 */
export interface TerminalHomePort {
  placedTerminal(terminalId: string): { readonly containerId: string } | null;
}

/**
 * What a socket must BE to hold subscriptions: an identity to key the registry by, the
 * credential its authority is discharged against, and a way to be written to. The session
 * gateway supplies one of these per connection; nothing here knows what a WebSocket is.
 */
export interface EventSubscriber {
  readonly id: string;
  readonly auth: AuthContext;
  deliver(frame: string, bytes: number): boolean;
}

/**
 * One connection's standing interest. `topics` is keyed by the topic's formatted URI and holds
 * the parsed ref, because matching compares refs the compiler joined and never strings a
 * caller typed.
 */
interface Subscription {
  readonly subscriber: EventSubscriber;
  readonly topics: Map<string, ManifoldRef>;
}

/**
 * THE MATCHING RULE'S INDEX HALF — a prefilter, never the decider.
 *
 * `topicMatches` (`@manifold/protocol`) is the ONE statement of which subscriptions an event
 * reaches: self, plus the single hop the addressing grammar itself states (an element and a
 * tile have no identity outside their container and are addressed THROUGH it, so a
 * subscription to a container hears what happens to its leaves). It lives in the protocol
 * because both halves must evaluate it identically — the same relation decides which sockets
 * this fan-out writes to and which handler an SDK gives the frame to, and a rule needing a
 * database lookup could only ever be answered on one side. A subscriber that watched the
 * server deliver events no client rule could route would be watching frames vanish.
 *
 * This function returns the registry keys that COULD match, so a fan-out reads two map entries
 * instead of walking every subscription; `topicMatches` then decides each candidate. If the
 * relation ever widens, this is the single place that has to widen with it, and the hub's own
 * test asserts the two agree over all seven address forms.
 *
 * NOTE the deliberate absence: there is no terminal → home-container hop. A terminal is a ROOT
 * of the grammar because it can be rehomed and keeps its identity, so its container is a fact
 * of state rather than of its address. The store IS consulted for a terminal — but for
 * AUTHORITY (`topicContainer` below), which can only ever narrow delivery, never widen it.
 */
function candidateKeys(topic: ManifoldRef): readonly string[] {
  const self = formatManifoldUri(topic);
  if (topic.kind === "element" || topic.kind === "tile") {
    return [self, formatManifoldUri({ kind: "container", containerId: topic.containerId })];
  }
  return [self];
}

/**
 * The container whose `containers:read` grant governs a topic, or null when the topic is
 * WORKSPACE-scoped and no container governs it.
 *
 * This is `resolveRef`'s per-kind check restated as a value instead of a throw: a terminal is
 * governed by its home, an element and a tile by the container that gives them identity, a
 * container by itself, and a principal, a plugin or an action by nothing — those are
 * workspace vocabulary every reader already holds (`http.ts`'s `principal` case says so in
 * prose; here it is the null).
 *
 * The null is also what confines a container-scoped token: a workspace-scoped topic has no
 * container in its ancestry, so it is nowhere inside that token's subtree, and
 * {@link EventHub.authorized} refuses it rather than inventing a rule for it.
 */
function topicContainer(ref: ManifoldRef, terminals: TerminalHomePort): string | null {
  switch (ref.kind) {
    case "container":
      return ref.containerId;
    case "element":
    case "tile":
      return ref.containerId;
    case "terminal":
      return terminals.placedTerminal(ref.terminalId)?.containerId ?? null;
    case "machine":
    case "principal":
    case "plugin":
    case "action":
      return null;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

/**
 * WHICH plugin declares the vocabulary for each concept the FLOOR emits about.
 *
 * ADR 0012 §1 splits emission from declaration: the engine emits at the doors it owns, and a
 * plugin declares the kinds. For a plugin's own action that split is invisible — the dispatch
 * knows which plugin's handler it is running. For a FLOOR door it is the whole problem: the
 * broker owns a PTY's lifecycle and the room owns its roster, but neither may name a plugin,
 * because a floor file naming a favorite plugin is the neutrality criterion failing in the one
 * layer that must be replaceable wholesale (`AXIOMS.md` §Foundation law).
 *
 * So a floor door emits by CONCEPT and this table, built in `assembly.ts` — the one server file
 * sanctioned to name a plugin at all — says which plugin currently owns the words.
 * Swap `core.terminals` for a stranger's terminals plugin and only `assembly.ts` changes.
 */
export interface FloorEventOwners {
  /** Terminal lifecycle: the broker owns the PTY, a plugin owns the words for what it did. */
  readonly terminals: string;
  /** Machine liveness: the socket registry owns the fact, a plugin owns the words. */
  readonly machines: string;
  /** Room attendance: the room owns the roster, a plugin owns the words. */
  readonly attendance: string;
  /**
   * Instance-channel liveness: the dialer owns the socket, a plugin owns the words. It is
   * the `machines` row's shape exactly — a long-lived outbound pipe going up or down is not
   * a commit point any action owns, so the floor is the only party that can announce it.
   */
  readonly shares: string;
}

/** Late-bound halves: both are downstream of this class in startup order, so both are thunks. */
export interface EventHubDeps {
  /** Read per emission, never captured: the roster changes under a live server. */
  assembly(): Assembly;
  terminals: TerminalHomePort;
  owners: FloorEventOwners;
}

/** Owns every subscription on every session socket, and every emission's fan-out. */
export class EventHub {
  private readonly subscriptions = new Map<string, Subscription>();
  /** Topic key → subscriber ids holding it. The fan-out index; two lookups per emission. */
  private readonly byTopic = new Map<string, Set<string>>();

  constructor(
    private readonly deps: EventHubDeps,
    private readonly authority: EventAuthority,
    private readonly history: EventHistory,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
  ) {}

  /**
   * MAY THIS CREDENTIAL HEAR ABOUT THIS NODE — the whole authorization story, asked once and
   * used twice (at subscribe, to refuse growing useless state; at delivery, because a
   * terminal's home moves).
   *
   * A governed topic asks `containers:read` FOR that container, which is where `allows`
   * enforces the token's own scope. An ungoverned one — a principal, a plugin, an action — is
   * workspace vocabulary, so it asks the bare capability AND refuses a container-scoped token
   * outright: a scoped token's authority is a subtree, and a node with no container above it
   * is not in anybody's subtree. That is the same shape as the action door's rung 3, where a
   * scoped token cannot invoke a workspace action.
   */
  private authorized(auth: AuthContext, containerId: string | null): boolean {
    if (containerId === null) {
      return auth.containerScope === null && this.authority.allows(auth, "containers:read");
    }
    return this.authority.allows(auth, "containers:read", containerId);
  }

  /**
   * Registers interest in every topic this credential may read, and silently declines the
   * rest. There is no acknowledgement by design (ADR 0012, the frame grammar): a per-topic
   * refusal on the wire would make the plane an oracle answering "does this node exist and may
   * I read it" one probe at a time. The refusal is a LOG line instead, where an operator can
   * see it and an attacker cannot.
   *
   * Past {@link MAX_SUBSCRIPTIONS_PER_CONNECTION} the excess is dropped and named, and the
   * socket lives: closing a tab because one panel over-subscribed is exactly the blast radius
   * multiplexing exists to remove.
   */
  subscribe(subscriber: EventSubscriber, topics: readonly ManifoldRef[]): void {
    let entry = this.subscriptions.get(subscriber.id);
    if (entry === undefined) {
      entry = { subscriber, topics: new Map() };
      this.subscriptions.set(subscriber.id, entry);
    }
    let forbidden = 0;
    let dropped = 0;
    for (const ref of topics) {
      const key = formatManifoldUri(ref);
      if (entry.topics.has(key)) continue;
      if (!this.authorized(subscriber.auth, topicContainer(ref, this.deps.terminals))) {
        forbidden += 1;
        continue;
      }
      if (entry.topics.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
        dropped += 1;
        continue;
      }
      entry.topics.set(key, ref);
      const holders = this.byTopic.get(key);
      if (holders === undefined) this.byTopic.set(key, new Set([subscriber.id]));
      else holders.add(subscriber.id);
    }
    if (forbidden > 0) {
      this.logger.warn("session_subscribe_forbidden", {
        principal: subscriber.auth.principal.id,
        topics: forbidden,
      });
    }
    if (dropped > 0) {
      this.logger.warn("session_subscription_limit", {
        principal: subscriber.auth.principal.id,
        held: entry.topics.size,
        topics: dropped,
      });
    }
  }

  /**
   * Drops interest in the named topics. Unsubscribing from a topic never held is a no-op
   * rather than an error: presence-class state has no transaction to violate, and a client
   * tearing down a panel it is no longer sure it registered must not have to remember.
   */
  unsubscribe(subscriberId: string, topics: readonly ManifoldRef[]): void {
    const entry = this.subscriptions.get(subscriberId);
    if (entry === undefined) return;
    for (const ref of topics) this.forget(entry, subscriberId, formatManifoldUri(ref));
    if (entry.topics.size === 0) this.subscriptions.delete(subscriberId);
  }

  /**
   * Every subscription this socket held, gone. Called from the gateway's socket-close path:
   * subscriptions are presence-class, so the socket dying IS their expiry — there is nothing
   * to persist, nothing to expire on a timer, and no reconnect that resumes them.
   */
  release(subscriberId: string): void {
    const entry = this.subscriptions.get(subscriberId);
    if (entry === undefined) return;
    for (const key of [...entry.topics.keys()]) this.forget(entry, subscriberId, key);
    this.subscriptions.delete(subscriberId);
  }

  private forget(entry: Subscription, subscriberId: string, key: string): void {
    if (!entry.topics.delete(key)) return;
    const holders = this.byTopic.get(key);
    if (holders === undefined) return;
    holders.delete(subscriberId);
    if (holders.size === 0) this.byTopic.delete(key);
  }

  /** How many topics one socket currently holds; the gateway's introspection and tests read it. */
  held(subscriberId: string): number {
    return this.subscriptions.get(subscriberId)?.topics.size ?? 0;
  }

  /**
   * ONE THING HAPPENED, ONCE, AT THE COMMIT POINT.
   *
   * `emitter` is the plugin that DECLARED the kind, which is not always the code that calls
   * this: a floor door emits under the plugin that owns the concept (the broker emits
   * `terminal_exited` as whichever plugin `assembly.ts` says owns terminal vocabulary), because
   * ADR 0012's rule is that the engine emits and the plugin declares. An emission whose kind
   * that plugin never declared is REFUSED — no history row, no fan-out, one error line — which
   * is the D5 vocabulary check moved to the one moment a kind can be known. It is refused
   * rather than thrown because the callers are a PTY exit, a socket close and a database
   * commit: a vocabulary bug must be loud, never able to take one of those down.
   *
   * `trailContainerId` is where the row lands in the audit trail, and it is a DIFFERENT
   * question from the topic. The topic answers "who hears this"; the trail's container answers
   * "where does this belong in `core.events.list({ containerId })`". They coincide whenever the
   * topic is a node inside a container, which is why it defaults to that — but a COLLECTION
   * topic resolves to no container, and an event about a terminal is still an event in that
   * terminal's container as far as the trail is concerned. A floor door that addresses a
   * collection therefore states the container itself, which is what keeps every pre-existing
   * row byte-identical.
   *
   * Then, in order: the durable row, and the fan-out. History first so a subscriber that
   * reacts by reading state back can never observe a world the audit trail has not recorded.
   */
  emit(
    emitter: string,
    topic: ManifoldRef,
    kind: EventKind,
    actor: string | null,
    payload: EventPayload = {},
    trailContainerId?: string | null,
  ): void {
    const refusal = emissionRefusal(this.deps.assembly(), emitter, topic, kind);
    if (refusal !== null) {
      this.logger.error("event_undeclared", { plugin: emitter, kind, detail: refusal });
      return;
    }
    const at = this.runtime.now();
    const governing = topicContainer(topic, this.deps.terminals);
    this.history.addEvent(trailContainerId ?? governing, at, actor, kind, payload);
    this.fanOut(topic, { kind: "plugin", pluginId: emitter }, governing, kind, at, actor, payload);
  }

  /**
   * A FLOOR DOOR'S emission about a COLLECTION — the shape every polled surface needs.
   *
   * Two things are forced here rather than chosen. The EMITTER is named by concept
   * ("terminals", "attendance", "machines") because the broker, the room and the machine
   * registry are mechanisms and a mechanism may not name a favorite plugin — that is what
   * {@link FloorEventOwners} is for, and swapping a plugin out is then one line in
   * `assembly.ts`. The TOPIC is the owning plugin's own node because a collection has no node
   * above its members, `emitterMayEmit` lets a plugin address exactly one plugin node (its
   * own), and grammar-only matching gives a collection exactly one address.
   *
   * This is also what makes the wave's deliverable reachable: a section that polled
   * `core.terminals.listAll` or `/api/attendance` from OUTSIDE the rooms it reports on now
   * holds one subscription, and the in-room half of the same news keeps riding the session
   * channel where it always did. WHICH member moved is the payload, and a container-scoped
   * token cannot subscribe here at all — a collection has no container above it and is
   * therefore in nobody's subtree.
   */
  emitCollection(
    concept: keyof FloorEventOwners,
    kind: EventKind,
    actor: string | null,
    payload: EventPayload = {},
    trailContainerId: string | null = null,
  ): void {
    const pluginId = this.deps.owners[concept];
    this.emit(pluginId, { kind: "plugin", pluginId }, kind, actor, payload, trailContainerId);
  }

  /**
   * The audience, resolved and written to, at the TWO addresses one fact has.
   *
   * The first is the node the emission named. The second is the emitter's own COLLECTION, and
   * it exists because ADR 0012 §2's collection rule has a converse the landing note left
   * implicit: a reading taken from OUTSIDE every room it reports on cannot subscribe to a node
   * it will only learn the id of from the answer it is waiting for. The index and both terminal
   * rosters are exactly that — a placement births a composition, absorbs another, and re-flags
   * `unplaced`, which is derived from the containment graph — so a placement addressed only to
   * the destination container is news no workspace-wide reader can ever hear. Reaching the
   * door's own node makes `manifold://plugin/<owner>` mean what every feed already assumes it
   * means: everything that plugin's doors announced. It is a delivery address, never a second
   * emission — `emitterMayEmit` gates the emission, and a plugin's own node is the one plugin
   * node it may always address anyway.
   *
   * Five properties are load-bearing:
   *
   * - ONE RULE DECIDES. `candidateKeys` narrows the registry to the two entries that could
   *   match; `topicMatches` — the protocol's relation, shared with every SDK — decides each
   *   one. The index never admits anything the relation refuses, and each address is delivered
   *   under its OWN topic, so the frame a socket receives is one its own copy of the relation
   *   routes.
   * - ONE FRAME PER SUBSCRIBER AT MOST. A socket subscribed to both a container and one of its
   *   elements is one member of a Set, so it hears the event once rather than once per
   *   matching subscription — and `reached` carries that across both addresses, so watching a
   *   node and its door's collection is still one frame.
   * - ONE COMMIT, ONE ROW. The second address adds no history: the trail records the fact,
   *   not how many audiences it had.
   * - SERIALIZED ONCE PER ADDRESS, not per socket — the roster frame's own shape
   *   (`session-ws.ts`). Parsed lazily too, so a malformed emission fails here rather than on
   *   N clients and an address nobody holds costs nothing.
   * - AUTHORITY RE-DISCHARGED PER SUBSCRIBER, against the container resolved for THIS
   *   emission — the SAME container at both addresses, which is what keeps the collection from
   *   widening anything. The subscribe-time check cannot be the guarantee: a terminal's home
   *   moves (`rebindTerminal`), so a subscription authorized against container A would
   *   otherwise keep delivering after the terminal was rebound into container B. The cost is
   *   one capability check per matching socket, and it buys the exact property ADR 0012 claims
   *   — an event reaches a socket only if that socket may read the topic's node AT THE INSTANT
   *   OF EMISSION.
   */
  private fanOut(
    topic: ManifoldRef,
    collection: ManifoldRef,
    containerId: string | null,
    kind: EventKind,
    at: number,
    actor: string | null,
    payload: EventPayload,
  ): void {
    const reached = new Set<string>();
    this.deliverAt(topic, containerId, kind, at, actor, payload, reached);
    // Already the collection's own news (every floor door's shape): one address, not two.
    if (formatManifoldUri(collection) === formatManifoldUri(topic)) return;
    this.deliverAt(collection, containerId, kind, at, actor, payload, reached);
  }

  /** One address's audience, deduplicated against every address already delivered. */
  private deliverAt(
    topic: ManifoldRef,
    containerId: string | null,
    kind: EventKind,
    at: number,
    actor: string | null,
    payload: EventPayload,
    reached: Set<string>,
  ): void {
    const audience = new Set<string>();
    for (const key of candidateKeys(topic)) {
      const holders = this.byTopic.get(key);
      if (holders === undefined) continue;
      for (const id of holders) {
        if (reached.has(id)) continue;
        const subscribed = this.subscriptions.get(id)?.topics.get(key);
        if (subscribed === undefined || !topicMatches(subscribed, topic)) continue;
        audience.add(id);
      }
    }
    let frame: string | null = null;
    let bytes = 0;
    for (const id of audience) {
      const entry = this.subscriptions.get(id);
      if (entry === undefined) continue;
      if (!this.authorized(entry.subscriber.auth, containerId)) continue;
      reached.add(id);
      if (frame === null) {
        frame = JSON.stringify(
          CONNECTION_BODIES.event.parse({ type: "event", topic, kind, at, actor, payload }),
        );
        bytes = Buffer.byteLength(frame);
      }
      if (!entry.subscriber.deliver(frame, bytes)) {
        this.logger.warn("socket_backpressure", { connectionId: id, topic });
      }
    }
  }
}
