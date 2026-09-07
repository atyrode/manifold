# Live panes remain stationary while choosing a drop target

Date: 2026-09-07
Status: accepted
Ratified: operator selected “Stable panes; animate after drop” for #372.

## Context

In `A | (B / C)`, carrying B previously projected the prospective source removal onto C. C visibly expanded while hit testing still used the current layout. Keeping the hit geometry stable avoided a moving-target feedback loop, but transforming the live panes made that geometry disagree with what the reader saw.

Recomputing targets from the transformed preview would make each preview change its own targets. Continuously changing the canonical layout would turn an uncommitted carry into shared document edits. Neither is the requested interaction.

## Decision

The carried pane reserves its current seat until placement is accepted. It may fade, but neither it nor another live pane moves or scales during hover. The destination ghost describes the proposed final insertion, swap or replacement over the unchanged, targetable panes. A ghost may therefore extend beyond the currently aimed pane when the accepted placement would prune the source branch.

Only an accepted canonical structural change animates settlement. Cancellation and refusal restore the source fade without a speculative layout rollback. Divider motion remains continuous layout, not a placement animation. The same already-arbitrated projection handles local and remote carries, fullscreen compositions and canvas portals; this is not a per-mode preference.

This replaces ADR 0024's live-pane hover projection policy, not its shared motion machinery, source-carry relay, placement algebra or terminal lifetime contracts. The normative text is `docs/CONTRACTS.md` §Presence.

## Evidence

The tile-drop gate samples every painted hover frame, checks local/remote agreement, preserves terminal layout dimensions and records no hover-time PTY resize. The nested three-terminal case cancels without changing layout or xterm nodes, then commits B beside C into the promised destination. An independent native Chromium drag showed zero A/B/C geometry drift, a source-only fade, unchanged A/C xterms after commit, and final `A | C | B` geometry within 1.5 pixels of the ghost. Real hover and settlement screenshots were visually inspected.
