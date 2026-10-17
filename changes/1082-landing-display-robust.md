---
section: Fixed
issue: 1082
---

The landing concept's dither no longer bands on scaled displays: its cells now land on whole device pixels (at 125 % scaling the dot size rounds to 3 device pixels instead of alternating 2 and 3), and a large screen gets coarser cells rather than more than the scenes' 960 × 540 budget. The page draws at most 60 frames a second on fast displays and stops redrawing a still picture (paused, reduced motion or motion 0) until the next input. It no longer freezes while a scene's shader compiles, on first load, on a cut or a retry: the bare page or the previous scene stays on screen meanwhile. It recovers from a lost graphics context, reports a shader that fails to assemble on the failure screen, keeps at most eight compiled programs, reads simulation textures at full precision on mobile GPUs, keeps the ordered dither exact on very tall screens, and the lab's panels no longer re-blur the moving scene behind them every frame.
