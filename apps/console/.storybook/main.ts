import type { StorybookConfig } from "@storybook/react-vite";
import type { PluginOption } from "vite";

// Storybook builds from the console's vite.config.ts, with the stories and fixtures the console's own build refuses. Its
// output (dist/storybook) is never shipped, so the credential gate (credential-gate.mjs), which guards the shipped
// bundle, is left out of it.
const withoutGate = (plugins: PluginOption[]): PluginOption[] =>
  plugins
    .map((plugin) => (Array.isArray(plugin) ? withoutGate(plugin) : plugin))
    .filter((plugin) => !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "agentrun-credential-gate"));

// The viewport toolbar is part of Storybook's core, so the phone stories (`globals: { viewport: { value: "mobile1" } }`)
// need no addon.
const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  // addon-mcp serves the catalogue to agents at /mcp on the dev server; addon-vitest runs the stories as tests, which the
  // MCP test tool needs (its project is in vitest.project.ts).
  addons: ["@storybook/addon-vitest", "@storybook/addon-mcp"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal: (config) => ({ ...config, plugins: withoutGate(config.plugins ?? []) }),
};
export default config;
