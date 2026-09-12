/**
 * THE WAYS A GUEST'S CALL INTO THE ENGINE FAILS, as classes a plugin may catch by name.
 *
 * Both guest runtimes map an uncaught instance of any of them to the named refusal their wire
 * allows — `{ ok: false, rule: "refused" }` for a server dispatch, a `hooked { ok: false }` for
 * a lifecycle hook, a `fault` for a panel — so an author who does not catch them still gets a
 * sentence at the door rather than a hang (ADR 0016 §6).
 */

/**
 * A slice of the engine's context that stage 1 does not serve across the boundary
 * (`docs/CONTRACTS.md` §Hardened plugins): the runner raises this the moment a guest reaches
 * for one, naming the member, instead of handing back `undefined` and letting a `TypeError`
 * happen three lines later.
 */
export class IsolateSliceUnavailable extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`${method} is not served to an isolated plugin`);
    this.name = "IsolateSliceUnavailable";
    this.method = method;
  }
}

/**
 * The host answered a `call` with `ok: false`. `detail` is the host's own error sentence,
 * verbatim — the guest never invents a reason on the engine's behalf.
 */
export class HostCallError extends Error {
  readonly method: string;
  readonly detail: string;

  constructor(method: string, detail: string) {
    super(`${method}: ${detail}`);
    this.name = "HostCallError";
    this.method = method;
    this.detail = detail;
  }
}

/**
 * A REFUSED DATABASE OPERATION (ADR 0034 §4), by the name the contract promises: a statement
 * over its size, too many parameters, an oversize batch, a keyword that would reach outside
 * this plugin's own file, or a plugin that never declared a database at all. The guest raises
 * it for the bounds it can judge BEFORE the round trip and for the host's own refusal after
 * one, so a plugin has exactly one class to catch whichever side decided — the same promise
 * `PluginDatabaseError` makes to an in-realm plugin, kept here without reaching into the
 * engine's package (see `server.ts` §the database rules).
 */
export class PluginDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDatabaseError";
  }
}
