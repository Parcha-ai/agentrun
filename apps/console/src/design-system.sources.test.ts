import { describe, expect, it } from "vitest";

// The console's sources use the design system's names and no value of their own (docs/console-design-system.md). Each
// rule below is one sentence of the guide; a line that breaks one is named with what to write instead. An exception is
// listed in ALLOWED with its reason, and an entry that no longer matches anything fails too, so the list only shrinks.
const sources = import.meta.glob("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.entries(sources)
  .filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.startsWith("./fixtures/") && !path.startsWith("./design/") && path !== "./lib/api.generated.ts")
  .map(([path, text]) => ({ path: path.slice(2), lines: text.split("\n") }));

/** `tag`: the rule reads a whole opening tag of these elements, however many lines it is written on, as one line. */
type Rule = { id: string; says: string; fix: string; find: RegExp; unless?: RegExp; skip?: (path: string) => boolean; tag?: boolean };
const outsideUi = (path: string) => path.startsWith("components/ui/");
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const RULES: Rule[] = [
  { id: "literal-colour", says: "A colour is a token, never a hex, rgb() or hsl() value.", fix: "a token class (bg-card, text-muted-foreground, border-border-strong); see the guide's colour table",
    find: /\[#[0-9a-fA-F]{3,8}\]|(?:color|background|fill|stroke|border)[^;"'`\n]{0,24}#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\((?!var\()/ },
  { id: "palette-colour", says: "Tailwind's own palette, white and black are not the console's colours.", fix: "bg-background, text-foreground, bg-overlay/70, or a tone token",
    find: new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|accent|divide|from|to|via|placeholder)-(?:white|black|(?:${PALETTE})-\\d{2,3})\\b`) },
  { id: "token-by-hand", says: "A token has a class; do not spell its variable out.", fix: "text-run-active, bg-primary/[0.28], accent-primary",
    find: /\b(?:text|bg|border|accent|fill|stroke|ring|outline|decoration)-\[hsl\(var\(/ },
  { id: "off-scale-size", says: "Text is one of the type scale's steps.", fix: "text-micro 10, text-label 11, text-small 12, text-body 13, text-lead 14, text-prose 15, text-base 16, text-lg 18, text-xl 20, text-figure 22, text-2xl 24, text-display 32",
    find: /\btext-\[\d[^\]]*\]|\btext-(?:xs|sm|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/ },
  { id: "off-scale-weight", says: "There are two weights: font-normal and font-semibold.", fix: "font-semibold",
    find: /\bfont-(?:thin|extralight|light|medium|bold|extrabold|black)\b/ },
  { id: "numbered-layer", says: "A layer has a name.", fix: "z-raised, z-sticky, z-overlay, z-dialog, z-popover, z-toast",
    find: /(?<![\w-])-?z-(?:[1-9]\d*|\[)/ },
  { id: "rounded", says: "Every corner is square.", fix: "delete the class", find: /(?<![\w-])rounded(?![\w(])(?:-[a-z0-9[\]]+)*(?=[\s"'`])/ },
  { id: "shadow", says: "There is one shadow, under what floats over the page.", fix: "shadow-float; for a halo round a mark, ring-*",
    find: /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl|inner|\[)|(?<![\w-])shadow(?=[\s"'`])(?=[^<>]*")/ },
  { id: "off-scale-motion", says: "A duration and an easing are tokens.", fix: "duration-fast, duration-base, duration-slow; ease-standard",
    find: /\bduration-(?:\d+|\[)|\bease-(?:in|out|in-out)\b|\bdelay-(?:\d+|\[)/ },
  { id: "caps-by-hand", says: "Mono caps is the .caps class.", fix: "caps", find: /(?<![\w-])uppercase\b(?=[\s"'`])/, skip: (path) => path === "components/ui/tip.tsx" },
  { id: "dark-variant", says: "Tokens change with the theme; a component never does.", fix: "the token whose two values you need, or a new one", find: /(?<![\w-])dark:[a-z]/ },
  { id: "focus-removed", says: "outline-none comes with a focus-visible: replacement.", fix: "drop outline-none (the global ring shows), or add focus-visible:outline-offset-0 and friends",
    find: /(?<![\w:-])outline-none\b/, unless: /focus-visible:(?!outline-none)|focus:(?!outline-none)|data-\[focus\]|tabIndex=\{-1\}/ },
  { id: "button-by-hand", says: "An action is a Button.", fix: '<Button size="xs|sm|md"> from @/components/ui', find: /^<button\b.*["`\s]caps\s[^"`]*\bborder\b(?!-[blrtxy]\b)|^<button\b.*["`\s]border\s[^"`]*\bcaps\b/, skip: outsideUi, tag: true },
  { id: "field-by-hand", says: "A field is Input, Textarea, NativeSelect or Picker.", fix: "the primitive from @/components/ui, inside a Field",
    find: /^<(?:select|textarea)\b|^<input\b(?!.*\btype="(?:hidden|file|checkbox|radio)")/, skip: outsideUi, tag: true },
  { id: "choice-by-hand", says: "A checkbox or a radio shows in the brand's colour.", fix: "Checkbox or Radio from @/components/ui, or accent-primary on the input; a segment's own radio is sr-only",
    find: /^<input\b.*\btype="(?:checkbox|radio)"/, unless: /sr-only|accent-primary/, skip: outsideUi, tag: true },
];

/** An exception: the rule, the file, a string the line holds, and why the guide's sentence does not apply to it. */
const ALLOWED: { rule: string; file: string; has: string; why: string }[] = [
  { rule: "palette-colour", file: "components/NodeDrawer.tsx", has: "bg-white", why: "A page of a document is shown on paper white in both themes, as the document is." },
  { rule: "focus-removed", file: "components/ui/field.tsx", has: "bareFieldClass", why: "A bare control sits in a fieldBoxClass box, which draws the ring while the control has the focus." },
  { rule: "focus-removed", file: "components/ui/menu.tsx", has: "shadow-float outline-none", why: "An open menu holds the focus itself and shows it on the active item (data-[focus]:bg-accent)." },
  { rule: "focus-removed", file: "components/ui/picker.tsx", has: "shadow-float outline-none", why: "An open list holds the focus itself and shows it on the active option (data-[focus]:bg-accent)." },
];

/** Each opening tag of a native control in a source, joined onto one line, with the line it starts on. A `>` inside
 *  braces (an arrow function, a comparison) is not the tag's end. */
function controlTags(text: string): { line: number; text: string }[] {
  const tags: { line: number; text: string }[] = [];
  for (const m of text.matchAll(/<(?:button|input|select|textarea)\b/g)) {
    let end = m.index + m[0].length;
    for (let depth = 0; end < text.length; end++) {
      const c = text[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({ line: text.slice(0, m.index).split("\n").length, text: text.slice(m.index, end + 1).replace(/\s+/g, " ") });
  }
  return tags;
}

const breaks = (rule: Rule, text: string) => rule.find.test(text) && !rule.unless?.test(text);
const hits = RULES.flatMap((rule) => files.filter((f) => !rule.skip?.(f.path)).flatMap((f) => {
  if (rule.tag) return controlTags(f.lines.join("\n")).filter((t) => breaks(rule, t.text)).map((t) => ({ rule: rule.id, file: f.path, line: t.line, text: t.text }));
  return f.lines.flatMap((line, i) => (!/^\s*(?:\/\/|\/?\*)/.test(line) && breaks(rule, line) ? [{ rule: rule.id, file: f.path, line: i + 1, text: line.trim() }] : []));
}));
const allowed = (h: (typeof hits)[number]) => ALLOWED.some((a) => a.rule === h.rule && a.file === h.file && h.text.includes(a.has));

describe("the console's sources follow the design system", () => {
  it("reads the sources", () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.path === "components/Shell.tsx")).toBe(true);
  });
  for (const rule of RULES) {
    it(`${rule.id}: ${rule.says}`, () => {
      const found = hits.filter((h) => h.rule === rule.id && !allowed(h)).map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 160)}`);
      expect(found, `Write instead: ${rule.fix}.`).toEqual([]);
    });
  }
  it("reads a control's whole opening tag, however it is wrapped", () => {
    const rule = (id: string) => RULES.find((r) => r.id === id)!;
    const one = (source: string) => controlTags(source).map((t) => t.text);
    const wrapped = '<button type="button" onClick={() => go(a > b)}\n  className="caps border px-2">Go</button>';
    expect(one(wrapped)).toEqual(['<button type="button" onClick={() => go(a > b)} className="caps border px-2">']);
    expect(breaks(rule("button-by-hand"), one(wrapped)[0]!)).toBe(true);
    expect(breaks(rule("button-by-hand"), one('<button type="button"\n  className={cn("flex w-full border-b text-left", on && "caps")}>')[0]!)).toBe(false);
    expect(breaks(rule("choice-by-hand"), one('<input type="checkbox" checked={on}\n  className="mt-1 accent-primary" />')[0]!)).toBe(false);
    expect(breaks(rule("choice-by-hand"), one('<input type="radio"\n  name="x" />')[0]!)).toBe(true);
    expect(breaks(rule("field-by-hand"), one('<input\n  type="hidden" name="manifest" />')[0]!)).toBe(false);
    expect(breaks(rule("field-by-hand"), one('<input\n  name="q" />')[0]!)).toBe(true);
  });
  it("every exception still names a line that needs it", () => {
    const stale = ALLOWED.filter((a) => !hits.some((h) => h.rule === a.rule && h.file === a.file && h.text.includes(a.has))).map((a) => `${a.rule} ${a.file} "${a.has}"`);
    expect(stale).toEqual([]);
  });
});
