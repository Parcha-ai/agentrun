---
packages: repo
kind: ci
---
The console's Storybook serves its catalogue to coding agents over MCP: `@storybook/addon-mcp` answers at `/mcp` on the running dev server (`npm run storybook` in `apps/console`) with tools to list the components and their stories, show a component's documentation and run story tests. `@storybook/addon-vitest` runs each story as a test in headless Chromium, through Storybook or with `npm run test-storybook`; the first run on a machine needs `npx playwright install chromium`. `npm test` runs the same unit tests as before.
