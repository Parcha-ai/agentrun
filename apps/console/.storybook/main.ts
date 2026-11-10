import type { StorybookConfig } from "@storybook/react-vite";

// The viewport toolbar is part of Storybook's core, so the phone stories (`globals: { viewport: { value: "mobile1" } }`)
// need no addon.
const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  // addon-mcp serves the catalogue to agents at /mcp on the dev server; addon-vitest runs the stories as tests, which the
  // MCP test tool needs (its project is in vitest.project.ts).
  addons: ["@storybook/addon-vitest", "@storybook/addon-mcp"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};
export default config;
