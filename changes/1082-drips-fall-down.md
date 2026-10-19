---
section: Fixed
issue: 1082
---

Drips no longer rise while things dry after rain in the landing concept. The shared edge drips (`rainDrips`: eaves, lintels, ledges and fronds in the sill, the waterfall, the bar, the train, the street, the garden, the meadow and the forest), the canopy drips (`canopyDrip`: forest and bamboo) and the splash crowns (`weatherSplash`) computed each beat's phase as the clock over a period that followed the rain amount; as an edge dried the period grew, so a few minutes after the page opened the phase ran backward and the drops climbed toward their edge, faster the longer the page was open. Each beat is now fixed in time, and the amount sets how many beats drip at the rate the old period gave, so drizzle and steady rain drip as often as before, and a downpour's edges about a third less often.
