import type { EmitEvent } from "@manifold/plugin";
import { identityColorFor } from "@manifold/protocol";
import { machinesManifest } from "./index.ts";

/**
 * The slice of the host this plugin touches, declared locally (D1): two narrow store reads,
 * one liveness question, and two credential verbs — exactly what `GET`/`POST /api/machines`
 * reached for, and nothing else. The identity door is pre-bound to the caller by the engine,
 * so this plugin never sees an `AuthService`, an `AuthContext`, or any way to verify a
 * secret: it can ask for a machine credential to be minted, and it can be told no.
 */
interface MachineRow {
  readonly id: string;
  readonly name: string;
  /**
   * `enrolled` through this door, or `declared` by the hub's configuration. Read here for
   * one decision only — whether an existing name is answered from the row or sent to the
   * mechanism — because the refusal itself is the mechanism's sentence, not this plugin's.
   */
  readonly origin: "enrolled" | "declared";
}

interface Enrollment {
  readonly machine: MachineRow;
  readonly machineToken: string;
}

type IdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface MachinesCtx {
  readonly store: {
    listMachines(): readonly MachineRow[];
    getMachineByName(name: string): MachineRow | null;
    /**
     * Which machines hold a WITHDRAWN credential. One store read for the whole roster
     * rather than a question per row, and the definition lives there because it is a join
     * between a machine and the token it references — not something a plugin should
     * reconstruct (ADR 0019 §3).
     */
    revokedMachineIds(): ReadonlySet<string>;
  };
  readonly machines: {
    isOnline(machineId: string): boolean;
  };
  readonly identity: {
    enrollMachine(name: string): IdentityResult<Enrollment>;
    rotateMachineToken(machine: MachineRow): IdentityResult<Enrollment>;
    /** Withdraws a machine's credential and answers how many died; 0 is a success. */
    revokeMachine(machineId: string): IdentityResult<number>;
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
}

/** Either a published result, or a refusal the door turns into a `refused` denial. */
type Refusable<T> = T | { readonly refused: string };

/**
 * `color` is derived here rather than stored, and derived from the PROTOCOL's palette and
 * hash rather than a copy of them: the dot a browser paints, the dot a stranger's agent
 * paints and the dot a second client nobody has written yet paints all come from one wire
 * field, so there is no algorithm to keep in sync.
 */
function dot(machine: MachineRow): MachineDot {
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
 * scope), and the identity door re-checks both at the point of minting. A refusal from it
 * is relayed rather than thrown: an attenuation failure is an answer, not a server fault.
 */
export const machinesHandlers = {
  async list(
    ctx: MachinesCtx,
    _args: Record<string, never>,
  ): Promise<{ machines: readonly MachineSummary[] }> {
    /*
      One read for the whole roster, hoisted out of the map for the reason the map exists:
      the alternative is a query per machine, which is the N+1 a list door must not ship.
    */
    const withdrawn = ctx.store.revokedMachineIds();
    return {
      machines: ctx.store.listMachines().map((machine) => ({
        ...dot(machine),
        online: ctx.machines.isOnline(machine.id),
        /*
          OMITTED when live rather than `false`, because the wire says absent ≡ not revoked
          and one representation of "normal" is what keeps a v19 reader's parse exact.
        */
        ...(withdrawn.has(machine.id) ? { revoked: true } : {}),
      })),
    };
  },

  async enroll(
    ctx: MachinesCtx,
    args: { name: string; rotateToken?: boolean },
  ): Promise<Refusable<{ machine: MachineDot; machineToken?: string }>> {
    const existing = ctx.store.getMachineByName(args.name);
    /*
      Idempotence answers from the row ONLY for a row this door minted. A declared row is
      sent through the mechanism whatever the flags say, and the mechanism refuses it by
      name: a POST for a machine the fleet repository owns must not look like a success.
    */
    if (existing !== null && existing.origin === "enrolled" && args.rotateToken !== true) {
      return { machine: dot(existing) };
    }
    const outcome =
      existing === null
        ? ctx.identity.enrollMachine(args.name)
        : ctx.identity.rotateMachineToken(existing);
    if (!outcome.ok) return { refused: outcome.message };
    /*
      ONE EMISSION PER COMMIT, and the commit here is an ENROLMENT rather than a call.
      Enrolment is idempotent by name (issue #40): a re-run provision flow answers with the
      existing row and mints nothing, and it returned above without reaching this line. A
      `rotateToken: true` recovery is the other non-event — the machine did not join the fleet,
      its secret changed — so the announcement is gated on the row having actually been born.
      The token itself never enters a payload; only the identity does.
     */
    if (existing === null) {
      ctx.emit({ kind: "plugin", pluginId: machinesManifest.id }, "machine_enrolled", {
        machineId: outcome.value.machine.id,
        name: outcome.value.machine.name,
      });
    }
    return { machine: dot(outcome.value.machine), machineToken: outcome.value.machineToken };
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
    const outcome = ctx.identity.revokeMachine(args.machineId);
    return outcome.ok ? { revoked: outcome.value } : { refused: outcome.message };
  },
};
