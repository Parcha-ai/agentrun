import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

// The Vitest project that runs each story as a test in headless Chromium. vite.config.ts adds it only when
// VITEST_STORYBOOK=true: `npm run test-storybook` sets it, and so does @storybook/addon-vitest inside the Storybook process
// (the toolbar's test run and the MCP test tool go through it). `npm test` never loads it. It takes the console's aliases,
// not its build plugins. storybookTest() finds this folder as `.storybook` under the working directory, apps/console for
// both; it imports nothing of Node, so the console's typecheck needs no Node types.
export function storybookProject(alias: Record<string, string>) {
  return defineProject({
    plugins: [react(), storybookTest()],
    resolve: { alias },
    test: {
      name: "storybook",
      browser: { enabled: true, headless: true, provider: playwright({}), instances: [{ browser: "chromium" }] },
    },
  });
}
