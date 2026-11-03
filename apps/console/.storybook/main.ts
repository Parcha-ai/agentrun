import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-viewport"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal(config) {
    // Storybook's development catalog includes its own runtime. The public dependency guard applies to distributable console builds.
    config.plugins = config.plugins?.filter((plugin) => !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "agentrun-console-boundary"));
    return config;
  },
};
export default config;
