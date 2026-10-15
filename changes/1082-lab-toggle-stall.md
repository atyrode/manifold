---
section: Fixed
issue: 1082
---

In the landing concept lab, switching the Countryside's or the Meadow's optional parts on and off no longer freezes the page on a computer with a graphics card. Instead of compiling a new shader program for each change, each scene builds one program holding all of its optional parts, once and in the background (ahead of time while the lab is open), and draws exactly the same picture with it. The page without the lab keeps its lean program. Software rendering, which would run every part of such a program in every frame, still builds each setting's own program, without the page waiting on it.
