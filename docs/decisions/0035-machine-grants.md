# ADR 0035: A grant may be scoped to one machine, and a plugin may declare capabilities of its own

Date: 2026-09-12
Status: proposed

## Context

[#506](https://github.com/atyrode/manifold/issues/506) states the gap from a plugin author's
side: "back up sessions on this machine" and "observe this repository" had no node to hang a
grant on, and `CAPS` was a closed enum with no word for either. It arrives out of
[atyrode/babel#240 §7](https://github.com/atyrode/babel/issues/240), where a plugin's whole
subject is a fleet — one machine's session stores, one machine's archives — and its authority is
therefore per machine and per verb the engine has never heard of.

Half of the node question has since been answered by another wave and should not be re-answered
here. `manifold://machine/<id>` is already one of `ManifoldRefSchema`'s forms, `containmentPath`
already walks it directly under the root with operations, jobs, outputs, locations and services
beneath it, and `AuthService.allowsRef` already evaluates at it — that is what ADR 0033's
governed runtime discharges `machines:run` and `jobs:read` against. What #506 asks of this
decision is the rest: a grant **scoped to one enrolled machine** must be reachable by a
PLUGIN's door, and the capability it grants must be allowed to be the plugin's own.

The capability half is the real design question, and it is a closed-set question. ADR 0010's
door intersects what an action DECLARES with what the caller is evaluated to hold; ADR 0011
resolves the caller's side per capability over the grant rows on the node path, expanding `*`
once into the engine's concrete set. Every one of those mechanisms is written against an enum,
and the enum is load-bearing: `GOVERNED_CAPS` is a subset of it, `NATIVE_DELEGATE_CAPS` is a
subset of it, and the wildcard's expansion IS it. Adding `atyrode.babel:archive` to `CAPS` would
make the engine's closed vocabulary grow with every installed row, which is the opposite of
closed. Leaving a plugin with only the engine's words is worse: it forces `containers:write` —
"create, rename, move and delete containers" — to stand in for "archive this machine's
sessions", which is a lie in the one place a reader audits authority.

## Decision

### 1. A machine is a grant node, and the door that reaches it is a declared requirement

A grant row may name `manifold://machine/<id>`; a `subtree` row there is authority over that
machine and everything the fleet addresses through it, and a `node` row is authority over the
machine alone. This is ADR 0011's walk unchanged — it is syntactic, so evaluation reads the path
off the URI and consults no inventory.

The CALL SITE is `AuthService.allowsRef`, reached from an action's declared
`requirements: [{ cap, target }]`. `allows(context, cap)` asks at a container or at the
credential's anchor and can therefore never see a machine row; the requirement names the node
from the caller's own arguments, which is exactly the shape ADR 0033's job doors already use.
Nothing else is widened to reach it: ADR 0011 §8 refused to invent `allows()` call sites to
justify element-grade rows, and this decision refuses the same for `core.machines`' fleet doors,
whose arguments carry a bare machine id rather than a reference. Grading those doors at their
machine is a later change to those doors' arguments, not to authority.

Two consequences are stated so nobody discovers them:

- **The write does not check enrollment.** A row naming a machine this workspace never enrolled
  is inert — no walk can reach a node no ref formats — and refusing it here would make a write
  depend on inventory the evaluator deliberately never reads. It is the rule container nodes
  already follow.
- **A container-scoped credential is refused at a machine.** A machine is not inside a
  container, so `allowsRef`'s immutable scope ceiling refuses it however the rows read. An
  administered row cannot widen a credential past the scope its mint chose.

### 2. The capability vocabulary is closed for the engine and open for a plugin

`CAPS` stays an enum and gains nothing. A plugin may declare capabilities in its OWN namespace,
`<pluginId>:<name>` — the same `<pluginId>.<local>` discipline every other published name
follows, with `:` instead of `.` so a capability can never be read as an action. Grants and
actions may name one exactly as they name a built-in. Three rules make that safe:

- **The declaring side is namespace-checked.** `PluginManifestSchema` refuses a manifest whose
  `capabilities` name another plugin's namespace, and an action's caps must be within its
  manifest's ceiling as they always were. So a plugin declares its own words and nobody else's,
  and the check lives in the schema every reader of a manifest goes through — the bundle door,
  the kit's `pack`, the unpacked watcher, assembly itself.
- **The granting side is not.** A grant is written by a PRINCIPAL, not by a plugin, so a row may
  name any well-formed capability. Authority administered before an install, or left behind
  after an uninstall, must neither be refused at the write nor vanish from the table; what makes
  such a row inert is the door, since an action nobody declared cannot be dispatched.
- **`*` does not expand into a plugin's namespace.** The wildcard is the engine's "everything",
  and the open half has no enumeration that does not depend on which plugins happen to be
  installed — an authority answer that moved with the roster would be a denial that depends on
  bookkeeping. So the evaluator contests the engine's closed set plus every plugin capability
  some applicable row NAMES, and a root credential (the owner key included) holds a plugin's
  capability only where a row names it.

The types carry this split without a second vocabulary: `Cap` is the engine's enum, `PluginCap`
is `` `${string}.${string}:${string}` `` — the plugin id's mandatory dot is what keeps
`AuthoredCap = Cap | PluginCap` from collapsing into "any string with a colon", so
`containers:reed` is still a compile error. `AskableCap` is the same union without the wildcard:
what an authority QUESTION may name.

### 3. What a plugin capability deliberately is not

- **Not in a credential.** A mint attenuates the engine's flat cap array; a plugin capability is
  held by a row at a node. That is what lets a plugin's authority over one machine be
  administered without re-minting whatever token its holder carries, and it is the widening
  behaviour ADR 0011 §3 describes rather than a new one. `mintToken` refuses one by schema.
- **Not governed, and never in a job's admission evidence.** Governed consent (ADR 0033) binds a
  capability to an artifact or resource REVISION the engine acquired and pinned; a namespaced
  name has none to bind. An action may declare both kinds — the door asks each at its own
  target — and only the engine's enter `AuthorityRequirement`, so every entry in a job's
  evidence stays re-dischargeable against consent at each deferred effect.
- **Not a delegate.** `delegates` is a NATIVE API ceiling and the native APIs are the engine's.
- **Not withheld by an installer's grant.** An install's `grantedCaps` may name plugin
  capabilities (a grant can never exceed a declaration), and a plugin's own capabilities are
  granted by DEFAULT: the high-risk set exists because `*`, `tokens:mint` and `plugins:manage`
  hand a stranger's code authority over the workspace, while a name in the plugin's own
  namespace confers authority over nothing but that plugin's own doors, whose callers still need
  a row. Withholding one would install a plugin with its own doors dead, which the enablement
  toggle already says out loud.
- **Not a node.** #506's second example, "observe this repository", stays unsayable and is not
  smuggled in: a repository is a plugin's own datum, not a node the workspace addresses, so
  scoping to one is the plugin's own data question. Inventing `manifold://plugin/<id>/<thing>`
  would mean a resolver, a census and an ownership story for nodes only one plugin can read.
  Revisit when two plugins must express authority over the same plugin-owned thing.

## Alternatives rejected

- **Adding the caps a product needs to `CAPS`.** `babel:archive` in the engine's enum makes the
  engine's vocabulary a registry of its consumers, and the enum is what `GOVERNED_CAPS`,
  `NATIVE_DELEGATE_CAPS` and the wildcard expansion are subsets of.
- **Letting a plugin reuse an engine capability as a stand-in.** `containers:write` for "archive
  this machine's sessions" misdescribes authority exactly where it is audited.
- **A free-form capability string.** Without the namespace there is nothing to check a
  declaration against, and two plugins would race for one word — the same failure the element
  type and event kind reservations already refuse by name.
- **Expanding `*` over the roster's declared capabilities.** It makes authority depend on which
  plugins are installed, so revoking a plugin would silently narrow a credential and installing
  one would silently widen it.
- **A machine-scoped TOKEN (`containerScope`'s sibling).** Scope is the credential's immutable
  ceiling and a second kind of it would double every scope comparison in the mint ladder, to say
  what a row at the machine says already.

## Revisit when

`core.machines`' fleet doors take a reference rather than a bare machine id — at which point
`machines:mint` can be discharged at `manifold://machine/<id>` and a machine-scoped grant reaches
the engine's own fleet administration, not only a plugin's door; or when a plugin needs authority
over a thing it owns that the workspace does not address (§3's last item).
