import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

// The Vitest project that runs each story as a test in headless Chromium. vite.config.ts adds it only when
// VITEST_STORYBOOK=true, which @storybook/addon-vitest sets inside the Storybook process (the MCP test-run tool runs
// through it); `npm test` never loads it. It takes the console's aliases and not its boundary plugin, as main.ts does.
export function storybookProject(alias: Record<string, string>) {
  return defineProject({
    plugins: [react(), storybookTest({ configDir: fileURLToPath(new URL(".", import.meta.url)) })],
    resolve: { alias },
    test: {
      name: "storybook",
      browser: { enabled: true, headless: true, provider: playwright({}), instances: [{ browser: "chromium" }] },
    },
  });
}
