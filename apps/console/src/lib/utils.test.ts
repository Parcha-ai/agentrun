import { describe, expect, it } from "vitest";
import config from "../../tailwind.config";
import { cn } from "./utils";

// cn drops the earlier of two classes that set the same property, and must know the console's own scales to tell a
// size from a colour.
describe("cn", () => {
  it("keeps a size from the type scale beside a text colour", () => {
    for (const size of Object.keys(config.theme.fontSize)) expect(cn(`text-${size}`, "text-primary-text"), size).toBe(`text-${size} text-primary-text`);
  });
  it("lets a later size, height, layer, shadow or duration replace an earlier one", () => {
    expect(cn("text-body", "text-small")).toBe("text-small");
    expect(cn("text-[13px]", "text-body")).toBe("text-body");
    expect(cn("h-control-md", "h-9")).toBe("h-9");
    expect(cn("h-10", "h-control-sm")).toBe("h-control-sm");
    expect(cn("w-full", "w-sidebar")).toBe("w-sidebar");
    expect(cn("max-w-page", "max-w-3xl")).toBe("max-w-3xl");
    expect(cn("z-raised", "z-popover")).toBe("z-popover");
    expect(cn("shadow-float", "shadow-none")).toBe("shadow-none");
    expect(cn("duration-fast", "duration-slow")).toBe("duration-slow");
  });
  it("keeps a line height written before a size", () => {
    expect(cn("leading-[1.6]", "text-label")).toBe("leading-[1.6] text-label");
  });
  it("keeps the focus ring's width and offset beside its colour", () => {
    expect(cn("outline-focus", "outline-offset-focus", "outline-ring")).toBe("outline-focus outline-offset-focus outline-ring");
  });
  it("knows every layer and duration the config names", () => {
    const layers = Object.keys(config.theme.zIndex).filter((k) => k !== "auto" && k !== "0");
    for (const l of layers) expect(cn("z-0", `z-${l}`), l).toBe(`z-${l}`);
    for (const d of Object.keys(config.theme.transitionDuration).filter((k) => k !== "DEFAULT")) expect(cn("duration-fast", `duration-${d}`), d).toBe(`duration-${d}`);
  });
});
