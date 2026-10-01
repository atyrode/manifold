# Prepared action authority fences

Date: 2026-10-01
Status: accepted

## Problem

An action's declared arguments do not always contain every authority target. A read-only
preparation can resolve an enrolled machine or a stored execution before the handler runs.
Checking only the initial action requirement, or resolving the target again in the handler,
leaves conditional requirements vulnerable to substitution and authority withdrawal across
awaited transport boundaries. A delayed native effect also needs the hub's correlated
credential ceiling; the independently signed native wire is not a lossless carrier for it.

This decision covers the generic mechanism for #957. Ordinary shell selection and its
conditional `machines:shell` requirement remain authored terminal-plugin policy.

## Decision

Reuse the existing action parser before and after a pure, read-only preparer. Admit only
requirements within the manifest's sealed additional-cap ceiling, bind the admission to the
same input and executable code, and keep an invocation-private live authority fence through
all effect boundaries. Built-in preparation identity is derived from the executable bytes,
or from the resolved source dependency bytes in source execution, rather than an environment
label or a repository revision that cannot describe dirty source.

Retain a hub-only authority snapshot for deferred native work. It preserves the correlated
scope, carried grants, attenuated capability ceiling, separate action ceiling and prepared
binding. Restore it through the central live evaluator. Absence is a legacy record, while an
explicit empty scope remains no authority. Project only the released native wire vocabulary
into signed requests; do not rewrite existing signed requests to add the hub's snapshot.

Separate admission-only transport/readiness guards from ongoing authority and identity:
retire the former only after owner acknowledgement, while the latter survive committed
birth and restart. Restore against the current installed ceiling for the actual admitted
mode, not the union of every alternative. An exact trusted-session relaunch captures fresh
native demand and extends the same sealed fence conjunctively before reservation; missing
generic recipes retain their known signed admission, and failed attempts retire only their
new private credential, never the incumbent Run.

The living contracts are [Pure conditional preparation](../PLUGINS.md#pure-conditional-preparation),
[Protocol and compatibility](../CONTRACTS.md#protocol-and-compatibility) and the executable
inventories in [REGISTRY.md](../../REGISTRY.md). This adds no pillar, hidden door, plugin-specific
engine route, authority issuer, third-party dependency or configuration key.

## Floor admission

The following files join existing pillars under the [Foundation law](../../AXIOMS.md#foundation-law).
The same three-part admission applies to each file, not merely to the initiative as a whole.

### `packages/server/src/action-authority-fence.ts` — assembly-engine

- **Bootstrap circularity:** admitted handlers and their host-provided effect services need the
  fence before guest code executes; a guest cannot supply the host's admission boundary.
- **Neutrality:** it binds parsed input, code identity, requirements and credential scope without
  naming a favorite plugin or choosing a domain's requirements. Replacing the roster changes
  the requirements supplied to it, not the mechanism.
- **Arbitration:** it compares original admission with current authority and executable identity
  across awaited effects. The handler cannot be the arbiter of its own continued admission.

### `packages/server/src/builtin-code-identity.ts` — assembly-engine

- **Bootstrap circularity:** the loader must identify its executable preparation implementation
  before admitting any built-in handler; a plugin-loaded identity provider would be too late.
- **Neutrality:** it hashes the assembly's executable dependency closure or compiled executable,
  not a feature name, manifest preference or asserted version label.
- **Arbitration:** it prevents one code body from claiming an admission sealed for another. The
  executing plugin cannot choose the host's code identity evidence.

### `packages/server/src/authority-snapshot.ts` — transport

- **Bootstrap circularity:** transport and deferred-effect admission must retain and restore hub
  authority before invoking the receiving execution, irrespective of which plugin requested it.
- **Neutrality:** it carries credential ceilings and exact action/native binding using protocol
  vocabulary. It does not choose shell policy, grant sources or plugin-specific allow rules.
- **Arbitration:** it keeps separately attenuated action and native authority from laundering one
  another, and subjects delayed effects to the central evaluator rather than receiver claims.

These modules introduce no separate dispatch surface. Existing roster doors, denial ladder,
structured outcomes and durable traces remain the self-description and accountability boundary.

## Alternatives

- **A terminal-specific host bypass:** rejected because it duplicates admission and cannot
  protect other plugins' conditional targets or downstream effects.
- **Re-resolving after admission:** rejected because the effect may select a different machine
  than the one whose capability was checked.
- **Flattening scopes into caps and targets:** rejected because it invents their Cartesian
  product and loses the container anchor's independent meaning.
- **Sending new authority fields in the old signed native wire:** rejected because it changes
  signature semantics and conflates independently versioned transport with hub enforcement.
- **Using only a Git SHA or build label:** rejected because source edits and helper dependency
  changes can alter executable preparation without changing either label.

## Verification obligations

Prove no effect after scope, source, policy, parent, machine eligibility or code withdrawal;
prove ordinary creation and restart require their separate home and exact-machine legs;
prove governed execution retains its native requirements without acquiring a shell leg.
Exercise both trusted and hardened guest preparation, deferred snapshot reload, explicit empty
scope, legacy absence, real PTY/browser interaction and the selected high-risk CI registry.
