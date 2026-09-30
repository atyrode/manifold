# External plugin Fast Refresh belongs to the existing development lens

Date: 2026-09-30
Status: accepted

## Context

Issue #953 adds frontend source iteration for installed external in-realm plugins. The ordinary kit development loop compiles an immutable artifact and replaces the admitted installation. A changed pin makes the browser reimport that artifact and remount its components. Unsaved React state cannot survive that path by changing its cache key or compiling a production bundle with development JSX.

Manifold already uses Vite and its React plugin for the development lens. Vite owns the source graph, CSS update lifecycle, component registrations and React Refresh runtime; packed modules instead use the host's shared namespace registry. These are different source transports for one lens and one installed-plugin composition, not two applications.

## Decision

The normative behavior is [External plugin Fast Refresh](../CONTRACTS.md#external-plugin-fast-refresh); the author workflow is [Fast Refresh](../PLUGINS.md#fast-refresh).

The kit starts an explicit, process-local development session for canonical approved source roots. The existing Vite frontend transforms those sources with the host's React/floor namespaces. The browser may select a source definition only for an authenticated enabled installed in-realm row with a matching manifest and unchanged admitted pin. It retains the authenticated packed baseline and restores that definition and its stylesheet when the source lease ends or loses its transport. Production builds have no active source registration.

The source process does not acquire owner authority, install an artifact, alter the global authored-directory switch or persist a workstation path in the hub. Manifest, server, capability, dependency and native-resource changes remain ordinary installation/review transitions. Hardened execution is not silently converted. Native action and identity transports remain the existing portable lens and action plane; this feature does not create preview audiences or an authentication shortcut.

Compatible component and CSS edits use the existing React Refresh and Vite CSS machinery. A descriptor bridge is needed because a plugin exports registration metadata as well as components; it is not another refresh engine. Incompatible component signatures or registration changes may remount, and errors must remain visible and recoverable.

## Foundation litmus

The browser source-selection helper joins the existing `web-plugin-host` pillar.

**Bootstrap.** Installed external contributions cannot enter the existing assembly without the host choosing their admitted module source and owning its lifetime. A plugin cannot implement this loader ahead of its own loading.

**Neutrality.** Selection uses installed metadata, approved source identities and the shared module namespace. It has no provider, plugin-id, panel-kind or application-specific branch; Code is an external consumer, not an exception in the floor.

**Arbitration.** The helper decides which source may supply a currently admitted contribution and retires that source on pin, eligibility or lifetime changes. The installed roster, capability checks and execution mode remain authoritative. The same assembly and outlets mount either transport.

The registry records the helper in both the pillar and floor inventories in the implementation commit. There is no axiom, wire-schema, capability or persistent-format change.

## Library evaluation

Reuse the workspace's existing Vite and `@vitejs/plugin-react` versions. Their source graph and refresh runtime provide component-family/signature tracking, dependency invalidation, CSS updates and error recovery. A separate plugin app would duplicate the host and React; a custom WebSocket/module evaluator would duplicate the HMR engine and its compatibility rules. Switching the production packer to development mode is incompatible with its shared production JSX runtime. The kit's development dependency declaration exposes the already-used Vite toolchain to its public coordinator; it does not add a production runtime library or alter published packed artifacts.

## Evidence boundary

Real-browser acceptance must prove visible component and CSS changes while unsaved input and counter state survive, then prove error recovery and packed fallback without leaked source styles or a full page reload. Source-boundary tests must reject traversal, symlink and secret reads. The existing installed/unpacked artifact proofs remain independently required. Passing module compilation alone is not this decision's behavioral evidence.
