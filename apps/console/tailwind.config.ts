import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// The AgentRun look as Tailwind names. Every value is a token in src/tokens.css (docs/console-design-system.md is the
// guide); a scale set here replaces Tailwind's own, so a class off the scale (`text-sm`, `z-40`, `rounded-md`) makes no
// CSS.
const hsl = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    borderRadius: { none: "0", DEFAULT: "var(--radius)" },
    // The type scale. The six small steps carry no line height: text takes its parent's (1.5 from the page) or a
    // `leading-*` class. Sizes are px on purpose: the console is a dense tool and its text does not scale with a root size.
    fontSize: {
      micro: "10px",
      label: "11px",
      small: "12px",
      body: "13px",
      lead: "14px",
      prose: "15px",
      base: ["16px", "24px"],
      lg: ["18px", "28px"],
      xl: ["20px", "28px"],
      figure: "22px",
      "2xl": ["24px", "32px"],
      display: ["32px", "40px"],
    },
    fontWeight: { normal: "400", semibold: "600" },
    zIndex: {
      auto: "auto",
      0: "0",
      raised: "var(--layer-raised)",
      sticky: "var(--layer-sticky)",
      overlay: "var(--layer-overlay)",
      dialog: "var(--layer-dialog)",
      popover: "var(--layer-popover)",
      toast: "var(--layer-toast)",
    },
    boxShadow: { none: "none", float: "var(--shadow-float)" },
    transitionDuration: { DEFAULT: "var(--duration-fast)", fast: "var(--duration-fast)", base: "var(--duration-base)", slow: "var(--duration-slow)" },
    transitionTimingFunction: { DEFAULT: "var(--ease-standard)", standard: "var(--ease-standard)", linear: "linear" },
    extend: {
      fontFamily: {
        sans: ['"Schibsted Grotesk"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        background: hsl("background"),
        foreground: hsl("foreground"),
        card: { DEFAULT: hsl("card"), foreground: hsl("card-foreground") },
        muted: { DEFAULT: hsl("muted"), foreground: hsl("muted-foreground") },
        accent: { DEFAULT: hsl("accent"), foreground: hsl("accent-foreground") },
        overlay: hsl("overlay"),
        primary: { DEFAULT: hsl("primary"), foreground: hsl("primary-foreground"), text: hsl("primary-text") },
        destructive: { DEFAULT: hsl("destructive"), text: hsl("destructive-text") },
        success: { DEFAULT: hsl("success"), text: hsl("success-text") },
        warning: { DEFAULT: hsl("warning"), text: hsl("warning-text") },
        info: { DEFAULT: hsl("info"), text: hsl("info-text") },
        border: { DEFAULT: hsl("border"), strong: hsl("border-strong") },
        input: hsl("input"),
        ring: hsl("ring"),
        "run-active": hsl("run-active"),
        "run-error": hsl("run-error-surface"),
        wf: { jev: hsl("wf-jev"), parallel: hsl("wf-parallel"), openrouter: hsl("wf-openrouter"), tool: hsl("wf-tool"), exit: hsl("wf-exit") },
      },
      spacing: { sidebar: "var(--sidebar-width)", "control-sm": "var(--control-sm)", "control-md": "var(--control-md)", "control-lg": "var(--control-lg)" },
      maxWidth: { page: "var(--page-width)", "page-wide": "var(--page-width-wide)" },
      keyframes: { "toast-in": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } } },
      animation: { "toast-in": "toast-in var(--duration-base) var(--ease-standard)" },
      outlineWidth: { focus: "var(--focus-ring-width)" },
      outlineOffset: { focus: "var(--focus-ring-offset)" },
    },
  },
  // `short:`, a viewport too low for a page's every panel (a phone in landscape). A variant, not a screen: a raw screen
  // would turn off the `max-*` variants, which need every screen to be a plain min-width.
  plugins: [plugin(({ addVariant }) => addVariant("short", "@media (max-height: 500px)"))],
} satisfies Config;
