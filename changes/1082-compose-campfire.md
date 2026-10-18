---
section: Changed
issue: 1082
---

The landing concept's campfire scene is now a preset of the `outdoor` composer (ADR 0062 Phase 2b), in six layers drawn through its low seat: the `pines` backdrop, the `clearing` ground, the `camp` (tent and pack), the `campfire` itself (its light falling on every other layer, its fuel bed in the records atlas), and its `smoke` and `sparks`. Below the treeline it draws as before; its sky is the World's (stars, the Milky Way, shooting stars, and now fog, rain and snow at the composed depth, the clearing wet and snowed on), and its giant planet is the first of the World's planets, which the scene opens with: a scene may now open with planets of its own (`SkyPlanets.defaults`; a link without the `planets` key holds them, `planets=` none, and the lab's reset puts them back). The carved M's key is `campfireMark`, shooting stars are the World's `meteors`, and the giant's `planet*` knobs became that planet's own fields.
