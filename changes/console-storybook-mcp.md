---
packages: repo
kind: ci
---
The console's Storybook moves from 8.6.14 to 10.6.4, with Vitest 4.1.12 (from 2.1.9) and Vite 6.4.5 (from 5.4.21) under it; the console's runtime dependencies do not change, and its build is the same static files with the same third-party notices. `npm run storybook` in `apps/console` now serves the catalogue to coding agents over MCP at `http://127.0.0.1:6006/mcp`, whose tools list the components and stories, show their documentation, give preview URLs and run story tests. `npm run test-storybook` runs every story as a test in headless Chromium (the first run needs `npx playwright install chromium`); `npm test` runs the same unit tests as before and no story tests. The viewport toolbar is now Storybook's own, so `@storybook/addon-viewport` is gone, and the toolbar gains a Theme switch for the page stories, while the design-system stories still show light and dark side by side.
