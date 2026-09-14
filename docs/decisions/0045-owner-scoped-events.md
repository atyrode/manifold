# 0045 — Owner-scoped event kinds and manifest quarantine

Date: 2026-09-14
Status: accepted
Ratified: 2026-09-14, issue #601 and the operator's implementation assignment

## Context

The integrated development hub stopped booting when `core.access` began declaring
`run_changed`: an already-installed `atyrode.babel` declared the same local event kind.
ADR 0012 D5 claimed kinds globally. That makes independently released plugins reserve one
shared vocabulary even though subscriptions select nodes, not kinds. Renaming one of the
current declarations only postpones the next collision.

Assembly also treated an installed plugin's incompatible manifest as a reason to refuse the
whole hub. Core and installed bundles do not update atomically. An authoring error or drift
in one independently installed plugin must remain visible without taking unrelated workspaces
and the plugin manager down.

## Decision

### 1. Event kinds belong to their declaring plugin

This amends [ADR 0012 D5](0012-event-plane.md#decision). The declared-events index is keyed
by `(pluginId, kind)`. `contributes.events[].id` remains a bare, bounded `snake_case` name.
Different plugins may declare the same kind; duplicate declarations within one manifest are
still an assembly problem and refused at install or replacement.

The event frame is `{ type: "event", topic, plugin, kind, at, actor, payload }`.
`plugin` is the originating plugin id, supplied by the host from the emitter context, never
chosen by the payload. Emission checks the emitter's own declaration. Another plugin having
declared a kind grants no right to originate it.

### 2. Subscription remains a relation over nodes

`subscribe` and `unsubscribe` still take `ManifoldRef` topics. `topicMatches`, read-grant
admission, delivery-time authority checks, and collection fan-out are unchanged. An event
addressed to a specific node is still delivered to that node and the emitting plugin's
collection, with the same origin on both deliveries. There is no kind filter, wildcard,
replay, acknowledgement or new address grammar.

A consumer interpreting a kind checks both `event.plugin` and `event.kind`. A topic-only
invalidation consumer, including `usePolledResource`, needs no kind or origin filter. Two
plugins may legitimately emit `run_changed` on their own nodes without either declaration
or either collection subscriber becoming ambiguous.

### 3. Refuse the conflicting manifest, not the workspace

Assembly attributes problems to manifests. A non-core manifest with a problem is held and
excluded from serving registries and lifecycle order. Required dependents are held
transitively. Core or engine-builtin problems remain fatal with the named assembly refusal;
core cannot be removed to make another plugin fit. Conflicts never silently select a winner
between third-party claimants.

A held manifest remains a discoverable roster row, with `enabled: false` and
`held: { reason: string, by?: string }`. Its own reason is the assembly problem text. A
required dependent reports `reason: "held_by_dependency:<pluginId>"` and `by: "<pluginId>"`.
The plugin manager and `GET /api/plugins` show the same reason. Enabling a held row refuses
with that reason; it does not retry unsafe contributions. Compatible replacement reassembles
the workspace and clears holds that no longer apply.

Install and replacement still preflight candidate bundles strictly and refuse conflicts
before publishing the candidate. Quarantine is recovery from installed-bundle drift, not a
way to admit a known-invalid new bundle. A held plugin retains its data and install metadata;
quarantine is neither uninstall nor purge.

### 4. Coordinate the session-wire transition

The required origin field changes the session contract. Consumers and frame validators move
with the schema, in a dedicated `protocol:` revision commit after the revision allocated to
#584. Old browser sessions must reconnect using the served matching client. This changes no
machine or instance frame; their acceptance sets retain all previously compatible versions
and admit the new shared revision under the unchanged-wire rule. No fleet restart is implied.

## Alternatives rejected

- **Rename `core.access.run_changed`.** Fixes one incident but preserves global collisions and
  unnecessary third-party renames.
- **Put the owner in the kind string.** Duplicates identity in manifest declarations and forces
  authors to migrate names. An explicit frame origin is easier to validate and inspect.
- **Infer origin from the topic.** A container or run node does not identify the emitting plugin;
  collection delivery also rewrites the delivered topic. Origin is independent frame data.
- **Keep refusing the whole hub.** Makes a previously valid install an availability hazard after
  a core update and hides the recovery UI behind the boot failure.
- **Ignore conflicts or silently pick a claimant.** Violates the no-shadowing contract and can
  reinterpret capabilities or persistent data. Holds must be named and visible.

## Consequences and proof

Existing manifest event ids and subscription topics do not change. Consumers matching bare
kinds across plugins must qualify their matches, recorded as a Breaking Changes fragment.
The published protocol vocabulary documents origin as well as each declaring owner.

Regression coverage proves cross-plugin same-kind assembly, same-manifest duplicate refusal,
non-core quarantine with transitive dependents, fatal core conflicts, strict install refusal,
origin-bearing node-isolated delivery, consumer origin qualification, and a real hub boot with
an installed held plugin. No new dependency or event transport is introduced.
