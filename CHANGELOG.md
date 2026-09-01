# Changelog

## [Unreleased]

### Breaking Changes

- One word per concept, everywhere: the app, its API and its database now speak a single canonical vocabulary — a **container** holds one of two **disciplines** (a freeform canvas or a tiled composition), a **terminal** is a shell while a **session** is your connection, and the sidebar's one tree is the **Index**. Capabilities (`containers:read`, `containers:write`, `scenes:write`, `terminals:spawn`, `terminals:write`), HTTP routes, wire fields and the SQLite schema were renamed in place: your containers, terminals, folders and tokens are migrated for you behind a pre-migration backup, and protocol v16 needs the server and every enrolled machine agent restarted together. (#69, #70)

### Added

- A plugin engine: core features now load through one registry, hot enable/disable from the new sidebar Plugins section takes effect everywhere without a reload — a disabled plugin's chrome vanishes while its data stays as named ghosts — and essential plugins refuse disable. (#69, #70)
- The workspace shell is itself a tile composition of plugin panels — the sidebar and the container view are panels in a per-principal layout tree, and the sidebar/canvas divider is a real tile divider whose position is saved to your workspace. (#69, #70)
- One action door for mutations: `POST /api/actions/:name` with a published, machine-readable vocabulary (`GET /api/protocol`, `GET /api/plugins`) and named refusals — terminal rename/kill are the first occupants, and all future mutations land here. (#69, #70)
- Sidebar sections (Machines, Index, Plugins), freehand drawing, and vantage — the tool in hand, what someone is editing, whether their sidebar is open — are core plugins; a stranger's agent can author its own against `docs/PLUGINS.md`. (#69, #70)
- `manifold://` addresses for everything — terminals, containers, elements, tiles, principals, plugins, actions — with a `GET /api/resolve` door and `/uri/…` deep links that navigate the app. (#69, #70)
- Manifold instances now share with each other: mint a share naming any container, hand its token to another instance, and their people open it live through your instance's own doors — same canvas, same terminals, same presence, revocable in one action that severs live viewers. (#74, #75)
- Remote collaborators carry their home instance as visible identity data (`origin`) — one pipeline renders everyone; nothing anywhere branches on where a principal lives. (#74, #75)
- Observable vantage: collaborators' active tool shows beside their name, and a consent-guarded spotlight action can center a peer's canvas on any address — with a dismissible chip and an ignore switch. (#69, #70)
- Purging a disabled plugin's data is now a two-press affordance in the Plugins section, showing what the plugin declared it stores and reporting exactly what was removed. (#69, #70)
- An audit door: `core.events.list` exposes the server's lifecycle event log to owners through the same action vocabulary as everything else. (#69, #70)
- Layout primitives (Stack, Cluster, Sidebar, Switcher, Cover, Frame) in the plugin UI library: intrinsically responsive building blocks every plugin composes from day one, backing a rebuilt sidebar that survives any width without overflow, clipping, or overlap. (#69, #70)
- Live updates: what one person does now shows up in everybody else's workspace in well under a second — a new container, a renamed one, a terminal opening or dying, a machine coming online, somebody arriving or leaving — with no refresh and no waiting for the next poll. Plugins can join in: a manifest declares the events it originates, and the engine emits them at the doors that already commit the change. (#72, #73)
- Permission is now per-node, not per-token. Authority lives in **grants** — one row saying who, at which `manifold://` node, which capabilities, allow or deny, and how far down — evaluated fresh on every request by walking from the workspace root to the node in question: the deepest rule wins, a named person beats a class, and a denial beats a grant only between equals. So "this agent may write this one container", "any human here may read but not write" and "everyone except her" are all sayable now, they take effect on the next action with no reconnect or re-login, and revoking one takes effect the same way. Your existing tokens changed nothing about what they can do — every one of them was migrated into the grant it always stood for, and the migration is fixture-proven to answer every authority question identically. Three new root-only doors (`core.access.grant` / `revokeGrant` / `listGrants`) administer the rows; a share now writes a grant on the container it shares, so a guest instance's reach is a row you can read, narrow and revoke like any other. (#77, #78)
- F8 toggles arrange mode — a workspace-wide, collaborator-visible state where content goes inert and the workspace's parts become grabbable (pointer or arrow keys): manifest order stays the default, your arrangement is saved to your workspace, and Escape or F8 exits. (#79, #84)
- Arrange mode moves PANELS too, not just sidebar sections: grab the sidebar or the container view by its pane and drop it on another pane's edge, seam or exact spot — the same drag vocabulary a composition already uses, with the destination previewed before you release — or nudge it across its row with an arrow key. Your workspace tree is per-principal and saved, so where you put your sidebar is where it stays, on every device. (#85, #87)
- The workspace you get before you have arranged one is now composed from the plugins you have on, not from a layout baked into the engine: a plugin declares where its panels ask to sit (`contributes.seats`) and the default tree follows from the roster, so installing a panel plugin puts it in a fresh workspace with nothing to configure. Today's workspace is unchanged — the shell asks for exactly the sidebar-left, container-view-right split it always had — and a workspace you HAVE arranged is never recomposed. (#85, #87)
- Every last piece of the sidebar is now a plugin's row, including the parts that used to be painted into the frame: the wordmark and version, the three "New …" creators, the connection line, the Keys control and your identity footer. Each one belongs to the plugin that owns the concept — "New canvas" is the canvas plugin's, "New folder" is the Index's — so turning a plugin off removes its row and its offer along with it, turning it back on returns it to the exact place you arranged it, and arrange mode (F8) now moves all of them, not just the collapsible sections. The rail looks and behaves as it did; nothing about it is hard-coded any more. (#85, #87)
- The sidebar animates its own reordering: nudge a row with an arrow key, drag one to a new place, or switch a plugin on or off, and the rows slide to where they now belong instead of jumping. It respects your system's "reduce motion" setting by not moving at all. (#85, #87)
- Keybindings are declared, not hard-coded: plugins contribute bindings to one composed table (collisions refuse loudly, naming both offenders), and a "Keys" control at the bottom of the sidebar opens a modal listing every binding with its owning plugin. F9's zone probe was the first migration. (#79, #84)
- Arrange mode is now SCOPED, so the two things it can move stopped fighting over the same square inch. Press F8 and you are arranging the workspace: each panel wears its name, and a panel that holds an arrangement of its own offers a way in on that name (the sidebar's reads "Sidebar rows"). Step in and the workspace's panels stop being grabbable while that panel's own rows do — one arrangement live at a time, named in a breadcrumb you can click your way back out of. Escape goes up one level and then leaves; F8 always leaves outright. Which panels have something inside to arrange is declared by the plugin that owns them, so a stranger's panel gets the same affordance with one line of manifest and no engine change. (#88, #92)
- Your workspace now keeps a record of who was allowed to do what. Every action anyone takes — yours, a collaborator's, an agent's, over the app or over the API — leaves one durable line in the workspace's own journal: when, who, the authority it went through, which door, what it touched, the arguments, and how it ended. **Refusals are kept too**, which is the half nobody usually keeps: "who tried to open my terminal and was told no" is now a question the workspace can answer, and so is "what did that agent actually do in here yesterday". Read it through the same door that already reads the workspace's history (`core.events.list`, owners only) — there is no second place to look. Secrets and terminal output never enter it, and the record is written BEFORE the work is done, so nothing can change your workspace without its line already being there. (#93, #100)
- Traceability is now constitutional rather than a feature: axiom A6 says every exercise of authority leaves a trace, it names its own exemptions (live presence, terminal keystrokes, in-progress document edits — each traced at the point it commits, where it has one), and a new gate check dispatches every registered action against a real server and fails RED if any of them leaves no record. A future feature cannot quietly opt out of being auditable. (#93, #100)
- Press F10 and point at anything to be told what it is. The inspector names the thing under your pointer — a sidebar row, a pane, a terminal's tile, a canvas element, a button — along with its `manifold://` address (copyable, and it resolves: paste it into a link and it takes you there), the plugin that owns it with its version, and which registered component paints it. Click to pin the reading as a card: the path it sits in, with every hop you can navigate to, how much it contains, every door reachable underneath it, and who is in the room. It is read-only by construction — it dispatches nothing and writes nothing — and while it is armed your collaborators can see you are inspecting rather than working. Nothing about it is new knowledge: it is the self-describing engine turned around to face you. (#90, #103)
- The sidebar's non-negotiables are seats of their own now, and the rail's foot reads as one line: the wordmark, version and release history are **Brand**, the key table is **Keys**, and both — with **Plugins** — refuse to be switched off, because a workspace with no name on it, no way to read its keys or no ledger of what is on is broken rather than minimal. Keys and Plugins sit side by side at the bottom of the rail; any plugin can ask for that by naming a cluster in its manifest, and rows that name the same one are drawn together wherever the earliest of them sits. (#91, #103)
- The Plugins list is a proper manager: the rail row opens a modal with a search box, on/off filters, core seats grouped apart from installed ones, and each plugin showing what it needs and what needs it, in both directions. An **Installed** tab and a **Browse** tab, where Browse says plainly that installing plugins from elsewhere is a later wave rather than pretending to be empty. (#91, #103)
- Keys are yours to change. The Keys modal is now an editor: press Rebind on any row, press the key you want, and it takes effect immediately — saved to you rather than to this browser, so it follows you to every device. A key another row already answers is refused out loud, naming both offenders, and nothing is written; every row offers a reset, and one control puts every key back to what its plugin declared. Plugins still declare the defaults, and the workspace answers to exactly one composed table. (#91, #103)
- If a workspace ever boots with its essential plugins switched off — only possible by changing the database behind the app's back, since the door refuses it — the first screen now offers "Restore default plugins" and puts every shipped seat back in one press, recording each one in the workspace journal. (#91, #103)
- Arrange mode has a toolbar. Press F8 and a floating bar appears at the bottom of the screen carrying seven tools that edit the workspace by clicking instead of by dragging: stack every pane into a row or into a column, drop in a **spacer** — an empty tile that simply holds a gap open where you want one — even out everybody's share, swap two panes by tapping each and pressing Swap, take a panel off the workspace onto a shelf in the bar and put it back with one press, or reset to the arrangement your plugins asked for. While the mode is armed every container in the tree is outlined with a mark for the direction it stacks in, so the structure you are editing is visible instead of inferred, and it disappears the moment you leave — it is painted over your workspace, never inside it, so arming the mode still moves nothing. The bar itself is yours to place: drag it anywhere by its handle and it stays where you left it on this screen, across reloads. Tools that make no sense where you are standing — the workspace's own, while you are zoomed into a panel's rows — go grey rather than refusing after the fact. (#89, #103)
- The `core.` plugin namespace is now defended, not merely conventional: a plugin that is not part of the shipped distribution can no longer publish itself as `core.anything` and read as official on your roster — composition refuses it by name, and the list of what counts as shipped is derived from the two files that register plugins rather than kept as a second list that could drift. The prefix still confers no privilege whatsoever, which is the point of writing the rule down: `docs/PLUGINS.md` now carries the three orthogonal facts about a plugin — who registered it (`source`), whether it may be turned off (`essential`), and who wrote it (its namespace) — as a table, and the words `core`, `builtin` and `essential` have canonical `REGISTRY.md` lexicon rows. (#99, #101)
- The sidebar's arrangement can nest. Drop a stack between two rows and drag rows into it, and they sit side by side instead of one under the other — four levels deep if you want it, arranged with the same drag as everything else. It is saved to you rather than to this browser, so it follows you to every device and it is still there after a reload. (#104, #122)
- The permission model now describes itself. `GET /api/protocol` carries a `grantContract` section beside the placement, plugin and event vocabularies, so an agent or integrator learns the whole authority shape — what a grant row is, that `allow`/`deny` and `node`/`subtree` are closed pairs it must decide rather than leave to a default, that a grant's WHERE is a `manifold://` address, and exactly what the three grant doors take and answer — from the running server instead of from this repository. (#115, #121)
- A plugin's web half can no longer take over another plugin's ground by accident. All six channels a plugin registers through in the browser — the renderer for a container discipline, the two kinds of overlay, the terminal viewer, the keys, and the paths it answers on — now refuse a duplicate out loud, naming both offenders, instead of handing the concept to whichever plugin happened to load last. Paths are also declared now: a plugin claims its URL space in its manifest (`/uri/…` is the deep-link plugin's), so the roster publishes which paths this workspace answers on, a claimed path with nothing to draw it says so by name, and a component for a path nobody claimed does nothing. (#112, #121)
- Your workspace can finally answer "which browsers hold my key". A new **Sessions** section in the sidebar lists every identity it knows about — a person or an agent, where it came from, when it arrived, how many live credentials it holds and when the soonest one stops working — and offers a two-press Withdraw on each, which kills every credential that identity holds and drops its open tabs on the spot. The **Machines** section grows the same affordance: withdrawing a machine's credential cuts the box off immediately and keeps it in the inventory, so you can still see what you just cut off and put it back by re-enrolling. Reading the list needs the same permission as revoking from it, and it never shows a secret or anything derived from one. (#108, #PR)
- Sessions now expire. A credential minted for a browser lives **14 days** — long enough that a normal week never meets it, short enough that a key pasted into a browser and forgotten stops working inside a fortnight — and an expired one is refused with a distinct answer the app acts on by asking you to bootstrap again, rather than the flat "unauthorized" it used to be. **Machine and agent credentials never expire**, deliberately: an agent cannot re-authenticate through a browser, so shortening its credential would take your fleet off the canvas in the name of security. **The owner key never expires either** — it is the break-glass path, and one that can lock you out is not break-glass. Nothing already issued was shortened. (#108, #PR)
- Every use of the owner key is now on the record. The one credential that is root everywhere used to leave nothing behind; it now writes a durable line in the workspace journal — at most one per hour, never one per request, because a journal that grows with your page loads is unreadable by the person it exists for — and every identity created through the owner-key bootstrap writes one too, saying whether the key itself opened that door. Read them where you read everything else (`core.events.list`). Neither line carries the key or any fragment of it. (#108, #PR)

### Changed

- The plugin manager says dependencies only when there are any — an absent line now means independence — and every named plugin is a link that jumps to its row, clearing whatever search or filter was hiding it. (#105, #106)
- Closing a tile is an action like everything else. The last bespoke HTTP route that changed your workspace — `DELETE /api/containers/:id/tiles/:tileId` — is gone, and leaf removal is now `core.space.removeTile { containerId, tileId }`: same authority, same rules, same refusals, and now the same journal line every other action leaves, so "who closed that terminal" is a question the workspace can answer. The app behaves exactly as it did; a script or agent that called the old route dispatches the action instead. (#114, #121)

- Terminal rename and kill moved from bespoke HTTP routes to `core.terminals.rename` / `core.terminals.kill` actions; killing a terminal keeps working even while the terminals plugin is disabled. (#69, #70)
- Sidebar width, collapse, and section order left this device: width lives in your server-saved workspace layout, collapse is shared presence state, and section order comes from plugin manifests. (#69, #70)
- Sidebar section order is personal again — arrange mode (F8) reorders it per principal through the saved workspace layout, restoring what the plugin conversion had reduced to manifest order only. (#79, #84)
- The workspace listens instead of asking. The five things the shell and sidebar used to re-fetch on a timer — the container index, the terminal listing, terminals by home, who is present, the machine roster — now subscribe to the workspace over the connection that was already open, read once when they mount, and re-read only when something actually happened. A timer returns only while the connection is down, because a client with no connection learns nothing by waiting. (#72, #73)
- Arrange mode stopped drawing handles. A row you can move is shown by its tint, not by a grip icon in its corner: the whole row is the grab surface, so a corner icon was pointing at a fraction of what was live, and a rail of them read as clutter instead of as an offer. Rows still announce themselves to a screen reader and still move with the arrow keys. (#94, #97)
- The two debug probes are their own seat now: F9's drop-zone probe left `core.shell` for a new **Diagnostics** plugin (`core.debug`), beside the F10 inspector. A probe is an instrument you bring to the workspace, never part of the frame — so the Keys table names the plugin that implements each key, and turning Diagnostics off takes F9 and F10 away together, chrome and all. F9 behaves exactly as it did. (#90, #103)
- The F8 editor left the frame and became a plugin (`core.arrange`): the toolbar, the pane grips, the live drop preview and the wireframe are all its own, painted through the same overlay channel any plugin's chrome uses, and the workspace itself keeps only the one line that blanks its panes while somebody is arranging. Turning Arrange off takes its key, its toolbar and its grips away together and hands the workspace back interactive on the spot. Contributed tools now say which toolbar they belong to, which is also what stopped the canvas's toolbar from showing tools that were never the canvas's — a plugin declaring a tool picks its bar, and a bar shows exactly the tools that named it. (#89, #103)
- The F8 toolbox is a palette you drag out of instead of a row of buttons you press. Take a **Stack row**, a **Stack column** or a **Spacer**, drag it to where you want it — into the workspace's own tree, into a composition, or into the sidebar's own rows — and the place you release is the place it lands, previewed under your pointer before you let go and saved at release. A stack arrives empty, so you drop one and then drag things into it; an empty one takes up no room at all until you are arranging or carrying something. (#104, #122)

### Fixed

- A tab with two rooms open no longer streams events nobody is watching any more. When one room ends for good — its container deleted while the other keeps working on the same connection — the departing room now withdraws the nodes it had asked about instead of abandoning its claim on them, so the last watcher letting go really does stop the traffic. Before this, that connection stayed subscribed for the rest of its life. (#111, #121)

- A drag that began before the workspace index had catalogued a just-born terminal's home now still streams live motion to every collaborator — movement is unconditional, classification catches up. (#69, #70)
- A canvas no longer re-renders in a loop while you do nothing: idle CPU on an open canvas dropped to near zero, node drags cost a tenth of their previous script time, and both improvements land below the v0.5.0 baseline. (#69, #70)
- The browser stopped hammering the API: one shared poll per resource instead of one per component, unchanged answers render nothing, and a hidden tab makes zero requests — enforced by a new performance-budget gate. (#69, #70)
- An idle workspace now costs nothing on the network: zero requests a minute with a canvas open and a live terminal on screen, measured against 132 a minute immediately before this change — and 232 before the shared feeds landed — with the performance-budget gate's ceilings lowered to zero to keep it there. The gate also checks that each feed is genuinely subscribed, so the zero cannot be a broken feature quietly passing. (#72, #73)
- The sidebar keeps up with the canvas again. Parking a terminal or putting a portal away from a canvas now goes through the same placement door every other move uses, and a commit is heard by the workspace-wide listings as well as by the room it happened in — so a terminal you park reappears at the top of the Index, and a terminal you open shows up there, immediately and without a refresh. Before this, those listings only learned of it from a timer that no longer exists. (#72, #73)
- A collaborator's cursor now leaves when they do: pointer leaving the canvas, a cancelled gesture, or a hidden tab retracts it for everyone, and a staleness backstop sweeps a cursor whose final frame was lost — no more frozen ghosts parked over your work. (#54, #84)
- Half-open connections now die instead of lingering: the server pings every session and reaps one that stops answering, and a client that hears nothing closes and reconnects on its own — so presence returns to truth within about a minute of a network drop, and a backgrounded tab (whose timers browsers throttle) is never mistaken for a dead one. (#55, #84)
- Pressing F8 no longer moves anything. Arming arrange mode used to be the first thing that rearranged your workspace: a grabbable floor grew under the sidebar rows that draw nothing until they have something to say, so the stack shifted the instant you asked to look at it — exactly backwards for a mode you enter to SEE an arrangement. Every affordance the mode adds now sits above the frame rather than taking space in it, and the gate measures a sidebar row and the container view across the keystroke to keep it that way. (#88, #92)
- Sidebar rows are reachable in arrange mode again. The panel grip covered the whole pane, including the rows underneath it, so with both legs of the mode armed at once the sidebar's own rows could not be grabbed at all. Only one arrangement is live at a time now, so the pane's grip is simply not there while you are arranging what is inside it. (#88, #92)
- Dragging a sidebar row in arrange mode no longer fights itself. Rows used to flicker between two orders under the pointer and then stop, leaving the row you were holding a seat or two short of where you were aiming. Three faults were compounding: the stack swapped the moment your pointer entered a neighbouring row rather than when it passed that row's middle, the reordering ANIMATED while you dragged so the gesture measured rows mid-slide, and reordering the row in your hand cut the browser's hold on it. A row now changes places when you cross a neighbour's midpoint, holds still while you hold it, and follows your pointer across as many rows as you like — landing where you let go, including on a slow hand rocking back and forth over one boundary. (#94, #97)
- A canvas text element's committed box now matches what you typed: the height patched to the scene came from counting `\n` characters alone, which agreed with itself until a line actually wrapped inside the box — then the note kept the editor's own scrollbar to hide the shortfall while you typed, and clipped the same content the moment you clicked away. The commit now comes from the editor's own measured content height instead, the one place wrap width and font metrics already get resolved for free, and the editor's font was quietly a browser default rather than the app's — so what wraps while you edit is exactly what the confirmed box shows, on this client and every collaborator's. (#98, #102)

### Removed

- Sidebar section drag-reordering (rows still navigate, rename, and kill; item drag-and-drop survived on the plugin foundation, and section order now comes from manifests). (#69, #70)
- The Stack and Swap buttons on the arrange toolbar. Dragging a stack out of the palette does what Stack did and does it where you point instead of to the whole workspace, and two panes trade places by dropping one onto the middle of the other. Equalize, Shelf and Reset are unchanged. (#104, #122)

## [0.5.0] - 2026-08-30

### Changed

- Replaced the terminal-only canvas with a React Flow collaborative canvas backed by Yjs, adding smooth live terminal moves and resizes, text editing, freehand drawing, selection presence, and undo. Terminals resize from their frame border like a desktop window, with no selection step. (#15, #57)
- Dragging follows the pointer without trailing: only the moved element re-renders per drag frame instead of the whole canvas. (#15, #57)
- Remote cursors and gestures now favor accuracy over smoothing: twice the update rate with just enough easing to round the edges. (#15, #57)
- A user's sibling tabs now render numbered cursor labels ("name (2)") so several tabs of one identity stay tellable apart. (#15, #57)
- Terminals are now first-class workspace citizens: the park button minimizes a terminal into a sidebar "Terminals" pool unbound from any pad, and pool rows drag back onto any canvas or pad. The X button now deliberately kills the terminal, and Backspace parks instead of deleting. (#15, #57)
- Terminals are presented like pads: renameable, durably ordered sidebar rows with the same menu, inline rename, keyboard, and drag grammar; terminal names show in titlebars and session rows. (#15, #57)
- Terminals and pads compose into views: drag one terminal over another and release on a snap zone to build a tiled split, expand a terminal to transmute it into a shared view in place (its canvas slot becomes a live widget with occupant avatars), drag tiles back out onto the canvas, and pin, rename, or split a view to keep it forever — unsplit ephemeral views pop back to a plain terminal when everyone leaves. Views tile terminals and live pad canvases side by side with draggable dividers, and portal elements embed any container on any canvas. (#15, #57)
- Sidebar sections (Machines, Pads, Terminals) are uniform, collapsible, and reorderable by dragging their headers; row drag handles are gone — the cursor is the cue. Freehand drawings are now selected by clicking the ink itself, not their bounding box. (#15, #57)
- Live cursors now render in composed views too: presence moved up to the renderer, so canvases and tiled views both show collaborators' pointers (view cursors track tiles across any window size). The sidebar stays personal — no cursors over it. (#15, #57)
- Every node carries one standardized titlebar — icon, name (double-click to rename in place), origin, then minimize / maximize / close — on terminals, view widgets, and the view renderer alike; view widgets on a canvas gained real minimize (back to the sidebar) and close, and views now live in their own sidebar "Views" section while Pads lists only canvases. (#15, #57)
- View widgets on a canvas are now fully interactive: click a tile to engage — your keystrokes reach the terminal and your avatar appears inside the view; click elsewhere to disengage back to watching. Watching alone never occupies a view. (#15, #57)
- The Machines "+" works inside composed views too: the new terminal is born straight into the view as a tile. (#15, #57)
- One vocabulary for arranging work: a "view" is any way to see your items — a freeform "pad" or a tiled "composition" — and the sidebar now indexes them all in one Views section (folders hold either kind, discipline glyphs tell them apart, old sidebar arrangements migrate automatically). (#59)
- Placement is now an algebra, not a feature list: every item kind declares what it composes with, one `POST /api/place` places anything anywhere legality allows, refusals come back as named rules ("views never nest"), and the whole vocabulary is discoverable through the protocol schema — for humans, agents, and future mods alike. (#59)
- Pad tiles inside a composition carry their own titlebar: jump into the pad, detach the tile, or delete the pad — full parity with every other item. (#59)
- Dragging is one grammar everywhere: a single typed payload carries any item, every target previews legality live during the drag (illegal drops show their named rule as prose, mid-hover), and the old per-pair drop handlers are gone — a composition row drops onto a canvas as a live widget, a terminal drops onto a sidebar composition row as a tile, and text blocks now tile into compositions alongside terminals. (#59)
- Errors and notices are one system: a bottom-center toast layer with auto-fading notices and sticky failures (with ✕), visible regardless of sidebar state; a burst of refusals can never bury a real failure, and previously-silent failures (pool kills, drop failures) now report. (#59)
- View widgets resize from their frame border exactly like terminals. (#59)
- One WebSocket per tab: session traffic is multiplexed over channels (protocol v12), so widgets, previews, and engagement never open extra connections and role changes are instant. (#59)
- Every terminal now lives in its own composition from birth: what sits on a canvas is a live window onto it, so "fullscreen" is just entering something that already exists — no temporary views, no pinning, nothing appears or vanishes when you look closer. Dragging one terminal onto another merges their compositions ("A + B"); pulling a tile out re-homes it; compositions merge, never nest. (#59)
- The Terminals section folded into the one sidebar index: an unparked terminal shows under the composition or canvas that holds it, and an unplaced one stands at the top level with its own icon — the sidebar lists what exists, wherever it lives. (#59)
- Grabbing anything by its titlebar now shows collaborators the carried item live — a ghost with its name tracks the pointer in canvases and compositions alike, and the source mutates in real time. (#59)
- Double-clicking a titlebar only renames when you double-click the name itself; anywhere else on the bar triggers the bar's action. The sidebar updates live when others create or delete things, and navigation mounts the right renderer instantly instead of showing loading text. (#59)
- One icon language across the app, drawn from Lucide: items (terminal, canvas, composition, note, machine, folder), titlebar controls, sidebar chrome, carry ghosts, and remote cursors all share it — the unicode glyphs, hand-drawn SVGs, and CSS shapes are gone. (#59)
- Destruction is direct: no more two-step confirmations on delete or kill anywhere, killing a terminal removes it everywhere instantly (no lingering "exited" husk — a naturally-exited shell still shows its real code), and creating a canvas or composition is one click with an "Untitled" name you rename in place. (#59)
- A composition widget on a canvas is now literally the composition renderer at a smaller scale: engage it and its tile dividers drag exactly like fullscreen; watching leaves them visibly inert. Composition and canvas icons refined (LayoutDashboard / dashed surface). (#59)
- The center drop zone now means "this exact spot": over an empty tile it fills as before, over an occupied one it swaps the two placements — shown with an orange highlight and a swap glyph instead of yesterday's guaranteed-failure full highlight. Tiles gained edge-drop rearranging inside and across compositions (an edge moves the tile, center trades places), and drags that carry nothing to trade simply snap to the nearest edge. (#59)
- Dropping onto a composition now aims at the exact tile under the pointer, at any depth: every tile offers its four edges and its center, and the area's outer band splits the whole composition at the top level. The preview is the real thing — the panes glide and squeeze into their prospective places while you hover, so the highlight IS the outcome you get on release. (#59)
- The exact spot of an occupied tile now also accepts items with nothing to trade: the carried item takes the tile and the displaced occupant moves out into its own composition at the top level of the index — previewed in violet with a "moves out" caption. A note cannot be displaced and says so in prose before you release. (#59)
- Splits can now grow FLAT: dropping on a tile's edge along its row's own direction joins that row as a new sibling instead of nesting a two-way split, and dividers are drop targets — release on a seam to wedge the item in exactly there. A seam's outer ends split the whole group the seam belongs to (how a nested `C | D` pair grows a pane across its full width), in both orientations. (#60)
- A terminal dragged FROM a canvas onto the exact spot of an occupied tile now TRADES instead of parking anyone: the displaced occupant moves into the carried terminal's home, and the canvas widget — same element, same geometry — simply starts showing it. Sidebar rows still displace, because they hold no seat to give back. (#62)
- Inserting between two panes now reads as BETWEEN: an interior same-axis drop takes a third from each neighbor, so the newcomer arrives an equal citizen (equal neighbors yield exact thirds) and the live preview shows both panes ceding — dropping on a pane's flank no longer looks like nesting into one side. End-of-row drops still split the edge pane's own space. (#60)
- Aims no longer flutter at zone boundaries: a held zone keeps the aim until the pointer travels a real margin past it, so centers stay easy to hold while the preview glides panes around. (#59)
- F9 toggles a debug view of the drop zones: a live-sampled painting of exactly what the drop resolver answers across a composition — ring, seams, seam ends, bands and centers — updating in real time with the layout. (#59)
- While a drop target is armed, the node you are holding eases into a ghost — and back — so the live preview underneath stays readable. (#59)
- Dividers are far easier to grab: a seam's pointer target is now wider than its slim paint at any zoom, and a watching widget's inert dividers explain how to make them live (click a tile to engage). (#59)
- The seam between two panes is now a real drop BAND — as wide as the area's outer ring at any zoom, not a hairline — and it is the only place that means "wedge in between": both neighbors cede a third. Deeper into a pane's flank the drop splits THAT pane alone (it cedes half, its neighbor untouched), so the grouped `(A|C)|B` shapes are reachable again alongside flat thirds, told apart purely by where you hover. The F9 debug view paints the seam band its own color. (#60)
- Collaborators now watch your drag think: while you hover a drop target, your resolved aim rides your carry frames, and every watching browser re-derives the same landing slot and pane glide through the same geometry kernel — cleared the instant your drag leaves a target or goes silent. Agents driving a placement through the SDK will paint identically: the multiplayer path is the only path. (#61)
- A seam now answers as ONE object across its whole band, at every depth: the middle wedges between its two panes and the outer stretches split the group the seam belongs to — with no hairline where the two meanings interleave side by side, one canonical addressing for the between gesture, and where two seams cross, the deeper one deterministically owns the pixel. Hysteresis is bounded by each band's own thickness on the seams AND the area's outer ring, so no zone can latch shut or become unreachable by approach. F9 shows the true field. (#64)
- A collaborator's drag preview is now pixel-identical to the dragger's — same colors, glyphs, and captions — the carried item eases away for every watcher (not just the dragger), and a refused drop shows viewers the same denial prose the dragger sees. One producer-agnostic pipeline builds every preview from the same wire data your own pointer normalizes into first, so local and remote cannot diverge by construction; each widget on a canvas now previews its own peer independently, and a stale peer aim releases the panes within half a second even if its final frame is lost. (#61)
- Dragging a divider inside a canvas widget resizes again at any zoom: the seam's grab band is now a constant on-screen thickness equal to the fullscreen route's (it used to shrink with the widget's own scale and lose half its width under the neighboring pane). (#65)
- A structural write that would brick a composition for everyone — persist a tree the readers then refuse — is now validated and refused before it touches the document; the drop that caused it reads as a conflict instead. A 17-wide flat row could really do this. (#66)
- The changelog dialog now separates every release into its own dated section: dev builds ship as real 0.x versions through the one release path instead of `-dev.N` suffixes accumulating under a single in-progress block, so release history reads per version from here on. (#63)

### Fixed

- The Machines sidebar section no longer disappears on view routes or the workspace root; without a canvas to author into it lists machines read-only. (#15, #57)
- Collapsing the Pads sidebar section now releases its height instead of leaving a blank gap. (#15, #57)
- Closing a tab no longer strands a dead ghost cursor on the canvas when the same user keeps another tab open. (#15, #57)
- The workspace status now shows real autosave times instead of permanently reading "Not saved". (#15, #57)
- An unengaged view widget now dims its terminals like any resting terminal; engaging undims only the tile you clicked. (#59)
- Deleting a tile from a three-or-more-way split no longer leaves a dead black band: split ratios are relative, and the renderer now normalizes them, so the surviving panes always fill the area and the drop highlights line up with what is painted. (#60)
- Closing a canvas tile inside a composition no longer toasts "Could not delete this canvas" after a delete that succeeded: the server's delete already prunes the leaf, and the client stopped chasing it. (#59)
- Engaging and disengaging a view widget no longer refreshes its terminals: the tiles keep their DOM identity across the socket swap and replay in a single frame. (#59)
- Drop zones on a composition widget no longer count the title strip as part of the tiles, so edge and center drops land where the highlight says they will. (#59)
- A terminal tile's minimize button now really releases the terminal to the top level of the index; it used to be refused every time. (#59)
- Committing a split no longer rebuilds the terminals it rearranges: every pane keeps its screen, scrollback and selection across structural edits. (#59)

## [0.4.4] - 2026-08-27

### Added

- Releases now attach a compiled `manifold-agent-linux-x64` binary for fleet consumers; the nix flake's bun-deps derivation proved non-reproducible across machines and stays development-only (#51, #52).

## [0.4.3] - 2026-08-27

### Changed

- Duplicate machine rows are now retired by rename instead of deleted during the uniqueness migration, preserving machine and session history (#48, #49).

## [0.4.2] - 2026-08-27

### Fixed

- Machine names are now unique in storage; duplicate enrollments left by the old always-mint path are deduplicated to the most recently seen machine, and their stale tokens revoked (#46, #47).

## [0.4.1] - 2026-08-27

### Fixed

- Fixed release verification failing to start the browser on GitHub's updated CI image (#44, #45).

## [0.4.0] - 2026-08-27

### Added

- Added Nix flake packages that build `manifold-agent` and `manifold-server` as standalone binaries for fleet machines (#40, #43).
- Added `MANIFOLD_MACHINE_TOKEN_FILE` so an agent can read its machine token from a private file instead of the environment (#40, #43).

### Changed

- Re-enrolling an existing machine name now returns the enrolled machine unchanged; pass `rotateToken` to explicitly replace a lost token (#40, #43).
- Cut per-frame validation cost on the terminal and canvas hot paths: the server serializes each terminal frame once per broadcast, and the SDK and canvas skip re-validating payloads they constructed or already deduplicated (#38, #39).
- Stopped re-sending full terminal snapshots on same-connection scene resyncs (#38, #39).

### Fixed

- Terminals that exit while their machine is disconnected now report their real exit code after reconnect instead of a signal death (protocol v4) (#38, #39).
- The agent now bounds its memory under a slow server connection, shuts down within a grace period even when a child traps signals, and no longer leaks terminal mirrors on failed spawns (#38, #39).
- Reconnecting to a restarted server no longer restores stale presence, and secrets are verified absent from process logs (#38, #39).

## [0.3.1] - 2026-08-26

### Fixed

- Restored the trail behind the eraser during right-button drags (#34, #35).

## [0.3.0] - 2026-08-26

### Changed

- Standardized issue and pull-request references across the repository and in-app changelogs (#31, #33).

### Fixed

- Restored the eraser cursor while erasing with a right-button drag (#30, #32).

## [0.2.2] - 2026-08-26

### Changed

- Removed the drag-and-drop instruction text above the pad list.

## [0.2.1] - 2026-08-26

### Fixed

- Fixed canvas right-clicks opening the browser context menu on top of Excalidraw’s menu.

## [0.2.0] - 2026-08-26

### Added

- Added recursive folders that organize pads and folders together in one ordered sidebar tree.
- Added inline pad and folder creation, renaming, and delete confirmation without modal dialogs.
- Added pointer and keyboard reordering for pads and folders, including moving either into nested folders.

### Changed

- Unified pads, machines, terminal sessions, presence, connection state, and release information in the persistent workspace sidebar.
- Made the full tree row draggable and applied pad and folder moves optimistically before the server response arrives.
- Made right-button dragging activate the canvas eraser on the first pointer movement while preserving the context menu for a stationary click.

### Fixed

- Fixed prolonged folder hover during a native drag unmounting the React root and blanking the canvas.
- Fixed sidebar drag targeting failing because the virtual root returned nullable item data to Headless Tree.
- Fixed container builds showing an unknown web build identifier instead of the deployed revision.

## [0.1.0] - 2026-08-26

### Added

- Added multiplayer Excalidraw canvases with presence, viewport memory, and embedded terminals.
- Added persistent pads, machine-backed terminal sessions, and reconnect-safe scene storage.
- Added an authenticated self-hosted web application with public-origin verification.
