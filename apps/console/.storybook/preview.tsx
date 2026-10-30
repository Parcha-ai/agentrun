import type { Preview } from "@storybook/react";
import "../src/styles.css";

// The console is dark by default, as the reference is: the variables hang off <html class="dark">.
document.documentElement.classList.add("dark");

const preview: Preview = {
  parameters: { layout: "fullscreen", backgrounds: { disable: true } },
  decorators: [(Story) => <div className="dark min-h-screen bg-background font-sans text-foreground"><Story /></div>],
};
export default preview;
