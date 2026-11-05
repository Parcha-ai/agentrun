import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// The hosted AgentRun theme: shadcn's variables, orange accents and the same two fonts.
const hsl = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
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
        primary: { DEFAULT: hsl("primary"), foreground: hsl("primary-foreground") },
        destructive: { DEFAULT: hsl("destructive"), text: hsl("destructive-text") },
        success: { DEFAULT: hsl("success"), text: hsl("success-text") },
        warning: { DEFAULT: hsl("warning"), text: hsl("warning-text") },
        info: hsl("info"),
        border: { DEFAULT: hsl("border"), strong: hsl("border-strong") },
        input: hsl("input"),
        ring: hsl("ring"),
        "run-active": hsl("run-active"),
        "run-error": hsl("run-error-surface"),
      },
    },
  },
  // `short:`, a viewport too low for a page's every panel (a phone in landscape). A variant, not a screen: a raw screen
  // would turn off the `max-*` variants, which need every screen to be a plain min-width.
  plugins: [plugin(({ addVariant }) => addVariant("short", "@media (max-height: 500px)"))],
} satisfies Config;
