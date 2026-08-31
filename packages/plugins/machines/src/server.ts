import { identityColorFor } from "@manifold/protocol";

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
  };
  readonly machines: {
    isOnline(machineId: string): boolean;
  };
  readonly identity: {
    enrollMachine(name: string): IdentityResult<Enrollment>;
    rotateMachineToken(machine: MachineRow): IdentityResult<Enrollment>;
  };
}

/** A machine as the wire carries it: the row, its derived dot, and — for the list — liveness. */
interface MachineDot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

interface MachineSummary extends MachineDot {
  readonly online: boolean;
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
 *   gateway, unfiltered, for every caller the door lets through — including a pad-scoped
 *   one, which is why the action declares `scope: "pad"`. It reads `ctx.padScope` nowhere,
 *   and that is not the containment obligation being waived, it is the obligation being
 *   VACUOUS: nothing in the answer is addressed by pad, so there is no pad-addressed thing
 *   in it to constrain. `scope: "pad"` says only "a pad-scoped token may open this", which
 *   is exactly what `GET /api/machines` already allowed — a share-link viewer still has to
 *   paint the machine badge on the terminal in front of it. Any future fleet door whose
 *   arguments or payload name a pad-addressed node (a session, an element, a layout) owes
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
    return {
      machines: ctx.store
        .listMachines()
        .map((machine) => ({ ...dot(machine), online: ctx.machines.isOnline(machine.id) })),
    };
  },

  async enroll(
    ctx: MachinesCtx,
    args: { name: string; rotateToken?: boolean },
  ): Promise<Refusable<{ machine: MachineDot; machineToken?: string }>> {
    const existing = ctx.store.getMachineByName(args.name);
    if (existing !== null && args.rotateToken !== true) return { machine: dot(existing) };
    const outcome =
      existing === null
        ? ctx.identity.enrollMachine(args.name)
        : ctx.identity.rotateMachineToken(existing);
    if (!outcome.ok) return { refused: outcome.message };
    return { machine: dot(outcome.value.machine), machineToken: outcome.value.machineToken };
  },
};
