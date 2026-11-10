import type { StorybookConfig } from "@storybook/react-vite";

// The viewport toolbar is part of Storybook's core, so the phone stories (`globals: { viewport: { value: "mobile1" } }`)
// need no addon.
const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};
export default config;
