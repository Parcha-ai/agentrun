---
packages: repo
kind: feature
---
The console's colour, radius and theme tokens come from a generated stylesheet, `apps/console/src/tokens.css`, vendored with the design-token vocabulary it was generated from. The console's tests and `scripts/check-generated.mjs` fail when either file is edited by hand or the two come from different generations.

Orange text and indicators use `--brand-accent`: links, selected tabs, navigation and options, indicator icons, the `primary` button's label and a working run (`--run-active` follows it). It is a darker orange (#AD5700) in the light theme, which clears 4.5:1 on the page and cards, and the brand orange in the dark theme. Orange fills and borders keep `--primary`, and text on an orange fill, such as the solid button's label, uses the dark `--primary-foreground`.

The radius properties are `--radius-control`, `--radius-card` and `--radius-composer`. A host that set `--ar-control-radius`, `--ar-card-radius` or `--ar-composer-radius` sets the new names.
