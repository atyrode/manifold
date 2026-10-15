---
section: Fixed
issue: 1082
---

In the landing concept lab, switching the Countryside's or the Meadow's optional parts on and off no longer freezes the page for seconds at a time. Instead of compiling a new shader program for each change, each scene now builds one program holding all of its optional parts, once and in the background (ahead of time while the lab is open), and draws exactly the same picture with it. The page without the lab keeps its lean program.
