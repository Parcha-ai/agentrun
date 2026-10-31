import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-viewport"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};
export default config;
