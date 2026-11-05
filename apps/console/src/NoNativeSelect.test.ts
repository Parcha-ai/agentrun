import { describe, expect, it } from "vitest";

// Every dropdown in the console is its Picker (components/ui/picker.tsx), never a native <select>, which a phone opens
// as a full-height native list detached from the field. The console's source, read as text (Vite's raw import, no Node
// API): no `<select` in any component or page, outside tests, stories, and picker.tsx's own comment naming it.
const sources = import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

describe("the console's dropdowns", () => {
  it("are all the Picker: no native <select> in the source", () => {
    const shipped = Object.entries(sources).filter(([path]) => !/\.(test|stories)\.tsx?$/.test(path) && !path.startsWith("./test/"));
    expect(shipped.length, "the scan reads the source").toBeGreaterThan(50);
    const found = shipped.flatMap(([path, text]) => text.split("\n").flatMap((line, i) => {
      if (!/<select\b/i.test(line)) return [];
      // picker.tsx says what it replaces, in a comment.
      if (path === "./components/ui/picker.tsx" && /^\s*(\/\/|\*|\/\*)/.test(line)) return [];
      return [`${path}:${i + 1}`];
    }));
    expect(found).toEqual([]);
  });
});
