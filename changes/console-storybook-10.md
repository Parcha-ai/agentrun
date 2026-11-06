---
packages: repo
kind: ci
---
The console's Storybook runs on Storybook 10.6.6 instead of 8.6.19. Its toolbar has a Theme switch that puts `dark` or `light` on the page as the console's own theme switch does, and the catalogue gains stories for the primitives in `apps/console/src/components/ui`: Button (every variant and size, enabled and disabled, with an icon), Chip (every tone), Select (closed, placeholder, open, disabled, no option available), Switch (off, on, disabled, busy, labelled) and Tip (closed, and shown at each alignment). The viewport toolbar is Storybook's own, so `@storybook/addon-viewport` is gone; stories import their types from `@storybook/react-vite`.
