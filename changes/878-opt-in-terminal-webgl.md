---
section: Added
issue: 878
---

Terminals offer an experimental **GPU** toggle for a device-local WebGL renderer while keeping DOM as the default. Renderer changes preserve the same terminal, input, current screen and history; unsupported initialization or unresolved context loss falls back to DOM with a visible notice, without automatic retries. Pinch-to-zoom over a focused terminal now reaches the canvas even with populated scrollback, without scrolling that history or sending terminal input; ordinary scrolling is preserved in both renderers. A bounded Mac/PC evaluation card records native correctness and performance separately from software-renderer checks.
