import {
  formatManifoldUri,
  type EventKind,
  type EventPayload,
  type ManifoldRef,
} from "@manifold/protocol";
import type { Assembly } from "./assemble.ts";

/**
 * THE EMISSION BOUNDARY (ADR 0012).
 *
 * The event plane has exactly one mechanism and it is closed: the ENGINE emits, at the doors
 * it already owns, and it may only emit a kind some manifest DECLARED. Everything else about
 * the plane is open — any node is a topic, any plugin may declare a vocabulary — because the
 * failure mode this file exists to prevent is not "too few events", it is a general-purpose
 * bus growing beside the action door until publishing becomes the easy way to change the
 * world. A declared vocabulary plus a checked emitter keeps the vocabulary open and the
 * mechanism shut.
 *
 * The check deliberately does NOT consult `assembly.enabled()`. The assembly's registries
 * include disabled plugins' contributions on purpose, and whether a door may fire while its
 * plugin is off is that door's question (D12), asked one rung earlier in the dispatch ladder.
 * Asking it twice, in two vocabularies, is how two answers happen.
 */

/**
 * `ctx.emit` — the ONE emission call, handed to action handlers and to the host's lifecycle
 * sites. It takes a REF, never a topic string: the address is compiler-joined and
 * `formatManifoldUri` is the only joiner in the tree, which is what keeps the topic namespace
 * out of `REGISTRY.md` §Runtime-joined namespaces rather than in it.
 *
 * It answers nothing. An emission is a notification, so there is no delivery count to act on,
 * and a handler that branched on one would be reading the shape of the audience — which is
 * precisely the coupling "no queue semantics" removes.
 */
export type EmitEvent = (ref: ManifoldRef, kind: EventKind, payload?: EventPayload) => void;

/**
 * Why one emission was refused, as the sentence a log line prints — or null when it is legal.
 *
 * Two rules, and no more:
 *
 *   THE KIND IS DECLARED BY THIS EMITTER. Not merely declared by somebody: `terminal_exited`
 *   belongs to whoever claimed it, and an emitter borrowing another plugin's kind would publish
 *   under a vocabulary it does not own, which makes the roster's declaration a lie.
 *
 *   A PLUGIN NODE IS ITS OWNER'S. Collection-level facts (a container born, a machine
 *   enrolled) have no node of their own, so they ride the declaring plugin's node — which makes
 *   `manifold://plugin/<id>` the one address form where the topic itself names a party, and the
 *   one that must therefore be checked against the emitter. Every other form addresses a node
 *   nobody owns exclusively: a container event is legitimately emitted by whichever door
 *   committed the change.
 */
export function emissionRefusal(
  assembly: Assembly,
  pluginId: string,
  ref: ManifoldRef,
  kind: string,
): string | null {
  const declared = assembly.events.get(kind);
  if (declared === undefined) {
    return `plugin "${pluginId}" emitted event kind "${kind}", which no manifest declares in contributes.events`;
  }
  if (declared.plugin !== pluginId) {
    return `plugin "${pluginId}" emitted event kind "${kind}", which is declared by "${declared.plugin}"`;
  }
  if (ref.kind === "plugin" && ref.pluginId !== pluginId) {
    return `plugin "${pluginId}" emitted "${kind}" on ${formatManifoldUri(ref)}, which is another plugin's node`;
  }
  return null;
}

/**
 * The boundary as a predicate, for the fan-out path that has already logged the refusal or has
 * nothing to say about it. It is defined in terms of {@link emissionRefusal} rather than beside
 * it so the rule has one statement: a guard that could answer `true` where the sentence answers
 * "no" is the drift this pairing exists to make impossible.
 */
export function emitterMayEmit(
  assembly: Assembly,
  pluginId: string,
  ref: ManifoldRef,
  kind: string,
): boolean {
  return emissionRefusal(assembly, pluginId, ref, kind) === null;
}
