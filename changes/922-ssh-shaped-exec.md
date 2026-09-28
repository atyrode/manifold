---
section: Added
issue: 922
---

The terminal client adds `manifold ssh [options] <machine> <command…>`, an ssh-shaped way to run a command on another fleet machine through the same brokered terminal doors as `manifold exec`. The command runs under `/bin/sh -c` with pipes instead of a terminal, so remote stdout and stderr arrive separately and byte for byte, the remote exit status becomes the client's, piped stdin is forwarded up to a bound, and Windows console programs reached through WSL no longer wait on a terminal reply. `-t` keeps the terminal for programs that need one, every Manifold-side failure exits 255 with one diagnostic line, and `--receipt` keeps the JSON result. `manifold --help`, `manifold context` and the packaged `manifold-terminal` skill now recommend it for ordinary remote commands; targets also need `od` and `dd`, plus `base64` to forward stdin.
