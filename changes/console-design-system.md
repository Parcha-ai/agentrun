---
packages: repo
kind: feature
---
The console has a design system: its colours, type sizes, control heights, layers and durations are tokens in `apps/console/src/tokens.css`, its controls and messages are primitives in `apps/console/src/components/ui` (now with Field, Input, Textarea, Checkbox, Radio, Banner, Dialog, ConfirmDialog, Menu, Toast, Tabs, Segmented, NavItem and Spinner), and [docs/console-design-system.md](docs/console-design-system.md) says which to use. The Storybook's "Design system" pages show every token and primitive in the light and the dark theme side by side. What you see change: the keyboard focus ring is 2px in the text colour (the 1px orange ring was 2.5:1 on white), secondary and error text are darker in the light theme so they pass 4.5:1 on every surface, a working run's colour is the brand's instead of purple, text on the solid orange button is the token's dark instead of a literal black, and someone whose OS asks for reduced motion gets no animation.
