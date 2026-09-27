import type { EmitEvent } from "@manifold/plugin";
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
import { MACHINES_PLUGIN_ID } from "./names.ts";

/** An in-realm host answers now; a hardened host answers across its process boundary. */
type Awaitable<T> = T | PromiseLike<T>;

/**
 * The slice of the host this plugin touches, declared locally (D1): the fleet bridge and the
 * event stager, and nothing else. It is STRUCTURAL and awaitable on purpose: the engine's
 * in-realm `ActionCtx` answers synchronously and a hardened guest's context answers with
 * promises, and both satisfy this one type, so there is one set of handlers for both modes.
 *
 * The bridge is pre-bound to the caller and to this plugin's admitted ceiling by the engine,
 * so this plugin never sees an `AuthService`, an `AuthContext`, a store or any way to verify a
 * secret. It names machines only by id; the host resolves every id against current state,
 * re-proves the live caller, and answers public metadata or a refusal. Target attribution for
 * the trace is the host's too, recorded where the id is resolved.
 */
interface MachinesCtx {
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
   * The fleet's news, staged on the engine and published only if this dispatch commits. Only
   * enrolment is this plugin's to announce; the online pair belongs to the socket registry,
   * which is floor and emits under this plugin's declared vocabulary (ADR 0012 §1).
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
      machines: inventory.value.machines.map(
        (machine): MachineSummary => ({
          ...dot(machine),
          online: machine.online,
          ...(machine.terminalExecution === null
            ? {}
            : { terminalExecution: machine.terminalExecution }),
          ...(machine.revoked ? { revoked: true } : {}),
          ...(machine.draining ? { draining: true } : {}),
          ...(machine.lastRefusal === null ? {} : { lastRefusal: machine.lastRefusal }),
        }),
      ),
    };
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
   * NO EVENT EMITTED, and that is the plane rule rather than an omission. `token_revoked`
   * already lands in the journal at the mechanism, which is where every other revocation
   * records itself; an event-plane emission here would be a SECOND announcement of one act,
   * and the fleet's declared vocabulary (`machine_enrolled`, `machine_online`,
   * `machine_offline`) already tells a watching client what it needs — a withdrawn machine
   * goes offline within one liveness interval because its socket is severed.
   *
   * A count of ZERO is a success: a machine already cut off is exactly what a careful
   * operator asks about twice.
   */
  async revoke(
    ctx: MachinesCtx,
    args: { machineId: string },
  ): Promise<Refusable<{ revoked: number }>> {
    const outcome = await ctx.identity.revokeMachine(args.machineId);
    return outcome.ok ? { revoked: outcome.value } : { refused: outcome.message };
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
    return outcome.ok ? {} : { refused: outcome.message };
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
   * NO EVENT EMITTED, for `revoke`'s reason: the roster already carries `draining` beside
   * `online`, the trace ledger records the act at the door, and a second announcement of one
   * act would be the plane rule with the seams showing.
   */
  async drain(
    ctx: MachinesCtx,
    args: { machineId: string; draining: boolean },
  ): Promise<Refusable<MachineDrainStatus>> {
    const outcome = await ctx.machines.drain(args.machineId, args.draining);
    return outcome.ok ? outcome.status : { refused: outcome.reason };
  },
};
