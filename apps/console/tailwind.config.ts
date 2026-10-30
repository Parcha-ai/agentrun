import type { Config } from "tailwindcss";

// The AgentRun look: shadcn's variables, an orange primary, two fonts, and no rounded corners anywhere.
const hsl = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    borderRadius: { none: "0", DEFAULT: "0" },
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
} satisfies Config;
