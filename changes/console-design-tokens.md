---
packages: repo
kind: feature
---
The console's colour, radius and theme tokens come from a generated stylesheet, `apps/console/src/tokens.css`, vendored with the design-token vocabulary it was generated from. The console's tests and `scripts/check-generated.mjs` fail when either file is edited by hand or the two come from different generations.

A working run is drawn in the brand orange: `--run-active` follows `--brand-accent`. Text on the orange fill, such as the solid button's label, uses the dark `--primary-foreground`.

The radius properties are `--radius-control`, `--radius-card` and `--radius-composer`. A host that set `--ar-control-radius`, `--ar-card-radius` or `--ar-composer-radius` sets the new names.
