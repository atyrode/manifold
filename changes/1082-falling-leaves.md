---
section: Changed
issue: 1082
---

The landing concept's autumn park now lets its leaves fall through the shared falling things (`src/composer/falling.ts`), as a new `leaf` kind: the maple names its crown, the air that carries the leaves (the wind, the gusts, a gust's swirl, the passage's flurry and whirl) and the lawn and path they land on, and each leaf flutters or tumbles down as a plate, eases flat where it lands and joins the carpet of fallen leaves, or lies a while and fades with the carpet off. Leaves are drawn cell by cell into the shared speck map in the tree's palette, so the shader no longer loops over every leaf for every pixel: the park draws in about half the GPU work. The defaults change only in the leaves in the air; a leaf no longer shows its veins and takes one of eight hues.
