// The design system's names, for code that lists them: the Storybook's token pages and src/design-system.test.ts,
// which checks each name here against tokens.css and tailwind.config.ts. Values live in tokens.css only.

/** Every colour token, in the groups the guide describes them in. */
export const COLOR_TOKENS = {
  surface: ["background", "card", "muted", "accent", "overlay", "run-error-surface"],
  text: ["foreground", "card-foreground", "muted-foreground", "accent-foreground"],
  brand: ["primary", "primary-foreground", "primary-text"],
  tone: ["success", "success-text", "warning", "warning-text", "destructive", "destructive-text", "info", "info-text"],
  line: ["border", "border-strong", "input", "ring"],
  run: ["run-active"],
  workflow: ["wf-jev", "wf-parallel", "wf-openrouter", "wf-tool", "wf-exit"],
} as const;

/** The type scale: the class, its size, and what it is for. */
export const TYPE_SCALE = [
  { name: "micro", px: 10, use: "A chip, a badge on the workflow graph." },
  { name: "label", px: 11, use: "A caps label, a table heading, the smallest button." },
  { name: "small", px: 12, use: "A button, a tab, a note under a field, metadata." },
  { name: "body", px: 13, use: "The console's text: rows, fields, paragraphs in a panel." },
  { name: "lead", px: 14, use: "A page's opening sentence, prose in a card." },
  { name: "prose", px: 15, use: "Long text someone reads: an answer, a note." },
  { name: "base", px: 16, use: "A report's paragraphs, a callout's first line." },
  { name: "lg", px: 18, use: "A section heading." },
  { name: "xl", px: 20, use: "A panel or dialog title, a run's title." },
  { name: "figure", px: 22, use: "A headline number, the wordmark." },
  { name: "2xl", px: 24, use: "The page title: one h1 a page." },
  { name: "display", px: 32, use: "A report's title." },
] as const;

/** Layers, lowest first. */
export const LAYERS = [
  { name: "raised", use: "Over its neighbours in the same panel: a chart's hover label." },
  { name: "sticky", use: "Stays while the page scrolls under it: a table's heading, a run's header." },
  { name: "overlay", use: "A scrim of your own over the page. Dialog draws its own." },
  { name: "dialog", use: "A dialog's panel, a full-screen viewer." },
  { name: "popover", use: "A menu, a picker's list, a tip. Above a dialog, which can open one." },
  { name: "toast", use: "A toast, over everything." },
] as const;

export const DURATIONS = [
  { name: "fast", use: "A hover, a switch, a colour change." },
  { name: "base", use: "A panel, a toast or a menu arriving." },
  { name: "slow", use: "A state settling: a graph node changing colour, a bar growing." },
] as const;

export const CONTROL_SIZES = [
  { name: "sm", use: "A toolbar, a table row, a dialog's footer." },
  { name: "md", use: "A form's fields and its buttons. The default." },
  { name: "lg", use: "The one action of an empty page or the sign-in page." },
] as const;

/** Text and background pairs that must pass WCAG 2.2 AA (4.5:1), in both themes. `wash`: the tone's fill at 10% over
 *  the page, as a Chip and a Banner use it. */
export const TEXT_PAIRS: readonly { text: string; on: string; wash?: string }[] = [
  ...["background", "card", "muted"].flatMap((on) => ["foreground", "muted-foreground", "primary-text", "success-text", "warning-text", "destructive-text", "info-text"].map((text) => ({ text, on }))),
  { text: "card-foreground", on: "card" },
  { text: "accent-foreground", on: "accent" },
  { text: "primary-foreground", on: "primary" },
  { text: "background", on: "foreground" },
  { text: "destructive-text", on: "run-error-surface" },
  { text: "primary-text", on: "background", wash: "primary" },
  { text: "success-text", on: "background", wash: "success" },
  { text: "warning-text", on: "background", wash: "warning" },
  { text: "destructive-text", on: "background", wash: "destructive" },
  { text: "info-text", on: "background", wash: "info" },
];

/** Edges and indicators that must be findable (WCAG 1.4.11, 3:1) against the page, in both themes. The focus ring is
 *  drawn 2px off its control, so the surface it must show against is the page's, not the control's own fill. */
export const NON_TEXT_PAIRS: readonly { mark: string; on: string }[] = [
  { mark: "input", on: "background" },
  { mark: "input", on: "card" },
  { mark: "ring", on: "background" },
  { mark: "ring", on: "card" },
  { mark: "ring", on: "muted" },
];
