import { MAX_STORAGE_VALUE_BYTES, type EmitEvent, type PluginStorage } from "@manifold/plugin";
import {
  identityColorFor,
  type MachineBridgeAnswer,
  type MachineCredentialGrant,
  type MachineDrainOutcome,
  type MachineDrainStatus,
  type MachineEnrollmentOutcome,
  type MachineIdentity,
  type MachineInventory,
  type MachineRefusal,
  type TerminalExecution,
} from "@manifold/protocol";
import { HostViewsSchema, type HostView, type HostViews } from "./host-views.ts";
import { MACHINES_PLUGIN_ID } from "./names.ts";

/** An in-realm host answers now; a hardened host answers across its process boundary. */
type Awaitable<T> = T | PromiseLike<T>;

/**
 * The slice of the host this plugin touches, declared locally (D1): caller-bound fleet
 * bridges, plugin-owned storage and the event stager. It is STRUCTURAL and awaitable on purpose:
 * the engine's in-realm `ActionCtx` answers synchronously and a hardened guest's context answers with
 * promises, and both satisfy this one type, so there is one set of handlers for both modes.
 *
 * The bridge is pre-bound to the caller and to this plugin's admitted ceiling by the engine,
 * so this plugin never sees an `AuthService`, an `AuthContext`, a store or any way to verify a
 * secret. It names machines only by id; the host resolves every id against current state,
 * re-proves the live caller, and answers public metadata or a refusal. Target attribution for
 * the trace is the host's too, recorded where the id is resolved.
 */
interface MachinesCtx {
  readonly storage: Pick<PluginStorage, "get" | "compareAndSet">;
  readonly machines: {
    /** The whole fleet in one answer: no per-row question, in either mode. */
    inventory(): Awaitable<MachineBridgeAnswer<MachineInventory>>;
    /**
     * Closes or reopens a machine's terminal admission and asks its PTY owner what it holds
     * (#278). The latch is the floor's and persisted; this plugin only turns the answer into
     * the door's result, or the reason there is none into a refusal.
     */
    drain(machineId: string, draining: boolean): Awaitable<MachineDrainOutcome>;
  };
  readonly identity: {
    /** One host-side find-or-create by name; a raw token only when this call minted one. */
    enrollMachine(name: string): Awaitable<MachineBridgeAnswer<MachineEnrollmentOutcome>>;
    /** Re-mints the CURRENT credential of the machine this id names now, revoking the old. */
    rotateMachineToken(machineId: string): Awaitable<MachineBridgeAnswer<MachineCredentialGrant>>;
    /** Withdraws a machine's credential and answers how many died; 0 is a success. */
    revokeMachine(machineId: string): Awaitable<MachineBridgeAnswer<number>>;
    forgetMachine(machineId: string): Awaitable<MachineBridgeAnswer<null>>;
  };
  /**
   * The fleet's news, staged on the engine and published only if this dispatch commits.
   * Metadata and identity mutations announce inventory changes; socket transitions and
   * committed drain latches belong to the floor (ADR 0012 §1).
   */
  readonly emit: EmitEvent;
}

/** A machine as the wire carries it: the row, its derived dot, and — for the list — liveness. */
interface MachineDot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

interface MachineSummary extends MachineDot {
  readonly online: boolean;
  readonly physicalCoreCount?: number;
  /**
   * OMITTED when the credential is live, which is the wire's rule rather than this file's
   * (`MachineSummarySchema`): absent reproduces the pre-v20 row exactly, so a v19 reader
   * sees the roster it always saw.
   */
  readonly revoked?: boolean;
  /** OMITTED when admission is open, for the same reason: a v23 reader's row is unchanged. */
  readonly draining?: boolean;
  readonly terminalExecution?: TerminalExecution;
  readonly lastRefusal?: MachineRefusal;
}

/** Either a published result, or a refusal the door turns into a `refused` denial. */
type Refusable<T> = T | { readonly refused: string };

const HOST_VIEWS_KEY = "host-views";
const storageEncoder = new TextEncoder();

async function readHostViews(
  storage: MachinesCtx["storage"],
): Promise<{ stored: string | null; registry: HostViews }> {
  const stored = await storage.get(HOST_VIEWS_KEY);
  return {
    stored,
    registry:
      stored === null ? { revision: 0, hosts: [] } : HostViewsSchema.parse(JSON.parse(stored)),
  };
}

async function commitHostViews(
  ctx: MachinesCtx,
  stored: string | null,
  registry: HostViews,
): Promise<Refusable<HostViews>> {
  const value = JSON.stringify(registry);
  if (storageEncoder.encode(value).byteLength > MAX_STORAGE_VALUE_BYTES) {
    return { refused: "host_view_capacity_exceeded" };
  }
  if (!(await ctx.storage.compareAndSet(HOST_VIEWS_KEY, stored, value))) {
    return { refused: "host_views_changed" };
  }
  ctx.emit({ kind: "plugin", pluginId: MACHINES_PLUGIN_ID }, "host_views_changed", {
    revision: registry.revision,
  });
  return registry;
}

/**
 * `color` is derived here rather than stored, and derived from the PROTOCOL's palette and
 * hash rather than a copy of them: the dot a browser paints, the dot a stranger's agent
 * paints and the dot a second client nobody has written yet paints all come from one wire
 * field, so there is no algorithm to keep in sync.
 */
function dot(machine: MachineIdentity): MachineDot {
  return { id: machine.id, name: machine.name, color: identityColorFor(machine.id) };
}

/**
 * These are the bodies of `GET /api/machines` and `POST /api/machines`, moved with their
 * meaning intact:
 *
 * - the list is every enrolled machine in store order with live liveness from the machine
 *   gateway, unfiltered, for every caller the door lets through — including a container-scoped
 *   one, which is why the action declares `scope: "container"`. It reads `ctx.containerScope` nowhere,
 *   and that is not the containment obligation being waived, it is the obligation being
 *   VACUOUS: nothing in the answer is addressed by container, so there is no container-addressed thing
 *   in it to constrain. `scope: "container"` says only "a container-scoped token may open this", which
 *   is exactly what `GET /api/machines` already allowed — a share-link viewer still has to
 *   paint the machine badge on the terminal in front of it. Any future fleet door whose
 *   arguments or payload name a container-addressed node (a terminal, an element, a layout) owes
 *   the real check;
 * - enrolment is IDEMPOTENT BY NAME (issue #40): an existing name comes back as its own row
 *   with no token minted, so a re-run provision flow can never invalidate the credential a
 *   running agent already holds. `rotateToken: true` is the explicit recovery path for a
 *   lost token file — same row, fresh secret, old token revoked and its socket fenced.
 *
 * The unscoped-caller and `machines:mint` checks the route made itself are now two rungs of
 * the ladder above this code (`enroll` declares the cap and keeps the default workspace
 * scope), and the bridge re-checks both — against the live caller AND this plugin's admitted
 * ceiling — at the point of minting. A refusal from it is relayed rather than thrown: an
 * attenuation failure is an answer, not a server fault.
 */
export const machinesHandlers = {
  async list(
    ctx: MachinesCtx,
    _args: Record<string, never>,
  ): Promise<Refusable<{ machines: readonly MachineSummary[] }>> {
    const inventory = await ctx.machines.inventory();
    if (!inventory.ok) return { refused: inventory.message };
    return {
      machines: inventory.value.machines.map((machine): MachineSummary => ({
        ...dot(machine),
        online: machine.online,
        ...(machine.physicalCoreCount === undefined
          ? {}
          : { physicalCoreCount: machine.physicalCoreCount }),
        ...(machine.terminalExecution === null
          ? {}
          : { terminalExecution: machine.terminalExecution }),
        ...(machine.revoked ? { revoked: true } : {}),
        ...(machine.draining ? { draining: true } : {}),
        ...(machine.lastRefusal === null ? {} : { lastRefusal: machine.lastRefusal }),
      })),
    };
  },

  async listHostViews(ctx: MachinesCtx, _args: Record<string, never>): Promise<HostViews> {
    return (await readHostViews(ctx.storage)).registry;
  },

  async setHostView(
    ctx: MachinesCtx,
    args: { expectedRevision: number; host: HostView },
  ): Promise<Refusable<HostViews>> {
    const { stored, registry } = await readHostViews(ctx.storage);
    if (args.expectedRevision !== registry.revision) return { refused: "host_views_changed" };

    const previous = registry.hosts.find((host) => host.id === args.host.id);
    if (
      previous !== undefined &&
      previous.name === args.host.name &&
      previous.members.length === args.host.members.length &&
      previous.members.every((member, index) => {
        const next = args.host.members[index];
        return (
          next !== undefined &&
          member.machineId === next.machineId &&
          member.accountLabel === next.accountLabel
        );
      })
    ) {
      return registry;
    }
    if (previous === undefined && registry.hosts.length >= 128) {
      return { refused: "host_view_capacity_exceeded" };
    }
    const occupied = new Set<string>();
    for (const host of registry.hosts) {
      if (host.id === args.host.id) continue;
      for (const member of host.members) occupied.add(member.machineId);
    }
    if (args.host.members.some((member) => occupied.has(member.machineId))) {
      return { refused: "host_view_member_already_grouped" };
    }

    // Unchanged members may outlive revocation or forgetting. A changed/new member must
    // resolve by exact ID now; a reused enrollment name never rebinds missing metadata.
    const changed = args.host.members.filter(
      (member) =>
        !previous?.members.some(
          (old) => old.machineId === member.machineId && old.accountLabel === member.accountLabel,
        ),
    );
    if (changed.length > 0) {
      const inventory = await ctx.machines.inventory();
      if (!inventory.ok) return { refused: inventory.message };
      const available = new Set<string>();
      for (const machine of inventory.value.machines) available.add(machine.id);
      if (changed.some((member) => !available.has(member.machineId))) {
        return { refused: "machine_unavailable" };
      }
    }

    const hosts =
      previous === undefined
        ? [...registry.hosts, args.host]
        : registry.hosts.map((host) => (host.id === args.host.id ? args.host : host));
    return commitHostViews(ctx, stored, { revision: registry.revision + 1, hosts });
  },

  async removeHostView(
    ctx: MachinesCtx,
    args: { expectedRevision: number; hostId: string },
  ): Promise<Refusable<HostViews>> {
    const { stored, registry } = await readHostViews(ctx.storage);
    if (args.expectedRevision !== registry.revision) return { refused: "host_views_changed" };
    const hosts = registry.hosts.filter((host) => host.id !== args.hostId);
    if (hosts.length === registry.hosts.length) return registry;
    return commitHostViews(ctx, stored, { revision: registry.revision + 1, hosts });
  },

  async enroll(
    ctx: MachinesCtx,
    args: { name: string; rotateToken?: boolean },
  ): Promise<Refusable<{ machine: MachineDot; machineToken?: string }>> {
    const enrolled = await ctx.identity.enrollMachine(args.name);
    if (!enrolled.ok) return { refused: enrolled.message };
    const outcome = enrolled.value;
    /*
      ONE EMISSION PER COMMIT, and the commit here is an ENROLMENT rather than a call.
      Enrolment is idempotent by name (issue #40): a re-run provision flow answers with the
      existing row and mints nothing. A `rotateToken: true` recovery is the other non-event —
      the machine did not join the fleet, its secret changed — so the announcement is gated on
      the host having actually created the row. The token itself never enters a payload; only
      the identity does.
     */
    if (outcome.created) {
      ctx.emit({ kind: "plugin", pluginId: MACHINES_PLUGIN_ID }, "machine_enrolled", {
        machineId: outcome.machine.id,
        name: outcome.machine.name,
      });
      return { machine: dot(outcome.machine), machineToken: outcome.machineToken };
    }
    if (args.rotateToken !== true) return { machine: dot(outcome.machine) };
    // By id, never by the row just read: the host re-resolves and re-authorizes it.
    const rotated = await ctx.identity.rotateMachineToken(outcome.machine.id);
    if (!rotated.ok) return { refused: rotated.message };
    return { machine: dot(rotated.value.machine), machineToken: rotated.value.machineToken };
  },

  /**
   * WITHDRAWAL, relayed (ADR 0019 §3). The whole ladder is above and beneath this line —
   * `machines:mint` at the door, the unscoped-caller and capability re-check plus the
   * live-socket fence in the mechanism — so this handler exists to turn a count into the
   * result the door declares and a refusal into a denial.
   *
   * Inventory invalidation is distinct from the credential journal: withdrawing an already
   * offline endpoint changes its visible revocation state without any socket transition.
   *
   * A count of ZERO is a success: a machine already cut off is exactly what a careful
   * operator asks about twice.
   */
  async revoke(
    ctx: MachinesCtx,
    args: { machineId: string },
  ): Promise<Refusable<{ revoked: number }>> {
    const outcome = await ctx.identity.revokeMachine(args.machineId);
    if (!outcome.ok) return { refused: outcome.message };
    ctx.emit({ kind: "plugin", pluginId: MACHINES_PLUGIN_ID }, "machine_inventory_changed", {
      machineId: args.machineId,
    });
    return { revoked: outcome.value };
  },

  /**
   * REMOVAL, relayed. Legal only after withdrawal: the mechanism refuses a live credential,
   * retained terminals and a pending drain by name, and a second forget answers as unknown.
   * The host names the machine on the trace because this is the last row that ever will —
   * once the roster row is gone, nothing derives that address from an emission.
   */
  async forget(
    ctx: MachinesCtx,
    args: { machineId: string },
  ): Promise<Refusable<Record<string, never>>> {
    const outcome = await ctx.identity.forgetMachine(args.machineId);
    if (!outcome.ok) return { refused: outcome.message };
    ctx.emit({ kind: "plugin", pluginId: MACHINES_PLUGIN_ID }, "machine_inventory_changed", {
      machineId: args.machineId,
    });
    return {};
  },

  /**
   * ADMISSION, relayed (issue #278). The mechanism is the floor's — the persisted latch, the
   * refusal in `open`, the owner round trip — and this handler turns its answer into the
   * result the door declares, or the reason there is none into a `refused` denial. An unknown
   * machine is refused before the mechanism is asked. Every other refusal happens AFTER the
   * floor has set the latch the caller asked for, which is the property a maintenance caller
   * relies on: a refused `draining: true` is a machine whose state is unknown AND whose
   * admission is now closed, never one left open because the answer was awkward.
   *
   * The floor announces its latch commit even if the later owner acknowledgement refuses.
   * This handler emits nothing: success is not the boundary of that inventory change.
   */
  async drain(
    ctx: MachinesCtx,
    args: { machineId: string; draining: boolean },
  ): Promise<Refusable<MachineDrainStatus>> {
    const outcome = await ctx.machines.drain(args.machineId, args.draining);
    return outcome.ok ? outcome.status : { refused: outcome.reason };
  },
};
