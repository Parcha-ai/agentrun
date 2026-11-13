import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge drops the earlier of two classes that set one property. It knows Tailwind's own scales; the console's
// (tailwind.config.ts) are named here, or `text-body` reads as a colour and loses to `text-primary-text`.
const merge = extendTailwindMerge({
  // A size carries no line height here (the small steps set none), so it never removes a `leading-*` before it.
  override: { conflictingClassGroups: { "font-size": [] } },
  extend: {
    theme: { spacing: ["sidebar", "control-sm", "control-md", "control-lg"] },
    classGroups: {
      "max-w": [{ "max-w": ["page", "page-wide"] }],
      "font-size": [{ text: ["micro", "label", "small", "body", "lead", "prose", "figure", "display"] }],
      z: [{ z: ["raised", "sticky", "overlay", "dialog", "popover", "toast"] }],
      shadow: [{ shadow: ["float"] }],
      duration: [{ duration: ["fast", "base", "slow"] }],
      ease: [{ ease: ["standard"] }],
      "outline-w": [{ outline: ["focus"] }],
      "outline-offset": [{ "outline-offset": ["focus"] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs));
