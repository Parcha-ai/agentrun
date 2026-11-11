import type { Decorator, Preview } from "@storybook/react-vite";
import { applyTheme } from "../src/lib/theme";
import "../src/styles.css";

// The console is dark by default, as the reference is. The toolbar's Theme puts `dark` or `light` on <html> through the
// console's own applyTheme, so a page story shows the tokens the console shows for that pick. The design-system stories
// show both themes side by side whatever the pick (src/design/Themes.tsx): each panel carries its own theme's class.
const withTheme: Decorator = (Story, { globals }) => {
  applyTheme(globals.theme === "light" ? "light" : "dark");
  return <div className="min-h-screen bg-background font-sans text-foreground"><Story /></div>;
};

const preview: Preview = {
  parameters: { layout: "fullscreen", backgrounds: { disable: true } },
  globalTypes: {
    theme: {
      description: "The console's colour theme",
      toolbar: { title: "Theme", icon: "mirror", items: [{ value: "dark", title: "Dark", icon: "moon" }, { value: "light", title: "Light", icon: "sun" }], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "dark" },
  decorators: [withTheme],
};
export default preview;
