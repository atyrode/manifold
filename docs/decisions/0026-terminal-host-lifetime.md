# ADR 0026: Terminal lifetime is independent of the networking agent

Date: 2026-09-05
Status: accepted
Ratified: operator-requested terminal-preserving unattended agent updates after the production incident; implementation and rollout tracked in #278.

- Normative contracts: `docs/CONTRACTS.md` (machine channel and terminal maintenance); `REGISTRY.md` (transport pillar).

## Context

A host activation changed a machine agent's executable path and environment without changing its displayed release version. Home Manager stopped the changed service. The agent's signal handler killed its PTYs, and its service cgroup included the terminal workloads. A replacement connected successfully with an empty inventory. Availability recovered; the work did not.

The shell being a separate process does not make its terminal independent. The process owning the PTY master, in-memory output sequence, and screen mirror is load-bearing. An update to a networking process must not replace that owner.

## Decision

Separate the terminal host from the networking agent. The terminal host owns PTY masters, subprocesses, output rings, screen mirrors, terminal identity and admission state. It receives no hub machine credential. The networking agent owns the authenticated machine connection and reconnect policy, and communicates with the terminal host through a private Unix socket. It owns no terminal subprocesses.

The two processes are independently supervised. The networking process never auto-spawns the host inside its own service cgroup. A transport stop or crash releases its connection, not its terminals. A host stop is distinct maintenance: admission is closed atomically and live workloads must finish before a non-destructive replacement can proceed. Installing a transport update must not restart the running terminal host. The host starts through a stable managed-profile path, while the transport uses its versioned package path. Home Manager therefore leaves an unchanged loaded host definition alone; Linux additionally uses `X-SwitchMethod=keep-old` and `RefuseManualStop=true`. Installed code and the retained host's runtime build are distinct facts, not silently reported as the same version.

The local boundary reuses machine command and event schemas. Extra local handshake/status schemas belong to `packages/protocol`, not to parallel ad-hoc wire definitions. Bun's maintained Unix-socket API carries bounded newline-delimited JSON; no second WebSocket client or external runtime dependency is introduced. Frames and queues are bounded. Terminal bytes and screen snapshots stay in memory, never in a durable queue.

Snapshot serialization remains entirely inside the PTY owner. The local boundary carries a completed `(seq, data)` result; reading the sequence and serializing the mirror in separate remote calls would break the no-gap invariant.

One transport may mutate a host at a time. The hub cannot infer destruction from a second connection possessing the same machine token or advertising less state. Drain is a registered machine-plugin action and a latched admission state, not a sampled count followed by a restart. Unknown or unavailable maintenance state refuses rather than assuming idle.

## Alternatives evaluated

- **Retain the current process and improve warnings:** rejected. It leaves routine replacement destructive and relies on every caller recognizing a hidden workload boundary.
- **Change systemd KillMode or detach the shells:** rejected. The agent still owns and closes the PTY masters, and deliberate shutdown still invokes terminal termination. Process-group separation alone cannot preserve the master or its screen state.
- **Inherited PTY descriptors / hot exec (#149):** not selected. The installed Bun 1.3.13 `Bun.Terminal` prototype exposes write, resize, close, flags and ref/unref, but no public descriptor adoption API. More importantly, a cooperative descriptor handoff cannot preserve terminals through a transport crash after the owner itself dies. It would also require atomically transferring the sequence/ring/mirror state. A separate owner handles both planned transport replacement and transport failure without serializing terminal bytes to disk.
- **tmux as the terminal engine:** not selected for this change. It would replace the current terminal and screen-state contract, rather than only separate process ownership, and introduce a second screen/terminal management model. Existing xterm serialization, byte sequencing, environment injection and attach behavior remain authoritative. Revisit only as an explicit terminal-engine decision, not an invisible upgrade workaround.
- **One additional WebSocket state machine:** rejected. Local IPC needs no second machine-channel implementation; the existing networking agent retains that responsibility.

## Foundation admission

The new local byte-transport boundary joins the existing transport pillar, not a new pillar or a privileged plugin.

- **Bootstrap:** plugin terminal actions require an available byte transport and cannot load the transport by invoking themselves.
- **Neutrality:** the host executes declared terminal commands and carries bytes without importing or preferring any plugin. Maintenance policy remains in the machines plugin.
- **Arbitration:** the host fences competing transport attachments and serializes terminal admission, ownership and snapshot boundaries; no caller may arbitrate its own competing attachment.

All public maintenance mutations use the ordinary registered action ladder and trace ledger. Local protocol records are exported schemas, and the new files remain indexed by the transport pillar. This decision adds no exemption to the plane rule.

## Limits and rollout

Terminal-host failure, host reboot, explicit terminal deletion and credential revocation remain different events with their own consequences. This design does not claim ordinary processes survive machine loss. User-owned unrestricted execution remains unrestricted; the operator explicitly declined an OS-identity/sandbox migration.

The deployed combined agent cannot retroactively transfer its existing PTYs into the new host. Its first migration requires a deliberate non-destructive drain and closure of those legacy terminals, not a same-token overlap smoke test. Upgrade the target hub before installing newer-protocol agents. Publishing a release never authorizes production promotion or fleet activation.

Proof must exercise actual disposable processes: same terminal IDs and workload PIDs, usable input/output and snapshot-plus-contiguous-output behavior across transport termination, crash, replacement and rejected duplicate attachment. A connected replacement with zero terminals is not a preservation verdict.
