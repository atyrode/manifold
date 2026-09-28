---
section: Added
issue: 922
---

The terminal client adds `manifold ssh [options] <machine> <command…>`, an ssh-shaped way to run a command on another fleet machine through the same brokered terminal doors as `manifold exec`. The command runs under `/bin/sh -c` with pipes instead of a terminal, so remote stdout and stderr arrive separately and byte for byte, the remote exit status becomes the client's, piped stdin is forwarded up to a bound, and Windows console programs reached through WSL no longer wait on a terminal reply. `-t` keeps the terminal for programs that need one, stopping a run terminates the command's whole process group, the exit status and `--receipt` JSON result wait until local output is delivered, and every Manifold-side failure exits 255 with one diagnostic line. `manifold --help`, `manifold context` and the packaged `manifold-terminal` skill now recommend it for ordinary remote commands; targets also need `od` and `dd`, plus `base64` to forward stdin.
