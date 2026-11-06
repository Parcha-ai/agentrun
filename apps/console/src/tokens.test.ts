// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "../tailwind.config";
import { checkTokenFiles, declaredProperties, readTokenFiles, STYLES_CSS, TOKENS_CSS, VOCABULARY } from "../tokens-check.mjs";

// The console's colours, radii and theme come from the generated src/tokens.css and the vocabulary vendored beside it.
// Every Tailwind colour class and every var(--…) the source reads must be a token that stylesheet declares, so a class
// never compiles to an undefined colour and a token is never typed by hand.
const files = readTokenFiles(new URL("..", import.meta.url));
const vocabulary = JSON.parse(files.vocabularyText) as { tokens: Record<string, { class: string | null }> };
const declared = declaredProperties(files.tokensCss);

// Custom properties set at run time rather than by a palette: WorkflowGraph.tsx sets --wf-phase on its svg, and the
// Headless UI listbox sets --button-width on its options.
const RUNTIME_PROPERTIES = new Set(["wf-phase", "button-width"]);

/** Tailwind's nested colour object as flat class names: `card.foreground` is `card-foreground`, `card.DEFAULT` is `card`. */
const flatten = (colors: Record<string, unknown>, prefix = ""): [string, unknown][] =>
  Object.entries(colors).flatMap(([key, value]) => {
    const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
    return typeof value === "object" && value !== null ? flatten(value as Record<string, unknown>, name) : [[name, value]];
  });

// styles.css and every module under src but the tests, as text.
const sources: [string, string][] = [
  [`./${STYLES_CSS.slice("src/".length)}`, files.stylesCss],
  ...Object.entries(import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true })),
];

describe("the vendored design tokens", () => {
  it("are the generated stylesheet, unedited, beside the vocabulary it was generated from", () => {
    expect(checkTokenFiles(files)).toEqual([]);
  });

  it("fail when the stylesheet is edited by hand", () => {
    const tokensCss = files.tokensCss.replace("--primary: 30 100% 50%;", "--primary: 25 100% 50%;");
    expect(tokensCss).not.toBe(files.tokensCss);
    expect(checkTokenFiles({ ...files, tokensCss })).toEqual([`${TOKENS_CSS} was edited after it was generated`]);
  });

  it("fail when the vocabulary beside it is from another generation", () => {
    const vocabularyText = files.vocabularyText.replace('"Page"', '"Pages"');
    expect(checkTokenFiles({ ...files, vocabularyText })).toEqual([`${VOCABULARY} is not the vocabulary ${TOKENS_CSS} was generated from`]);
  });

  it("fail when styles.css types a token value again", () => {
    const stylesCss = `${files.stylesCss}\n:root { --run-active: 239 83.3% 67%; }\n`;
    expect(checkTokenFiles({ ...files, stylesCss })).toEqual([
      `${STYLES_CSS} declares the token --run-active; token values belong in ${TOKENS_CSS}`,
    ]);
  });

  it("back every Tailwind colour class with a declared token of the same class name", () => {
    const colors = flatten(config.theme.extend.colors);
    expect(colors.length).toBeGreaterThan(0);
    for (const [name, value] of colors) {
      const token = /^hsl\(var\(--([a-z0-9-]+)\) \/ <alpha-value>\)$/.exec(String(value))?.[1];
      expect(token, `${name}: ${String(value)}`).toBeDefined();
      expect(declared.has(token!), `${name} reads --${token}, which ${TOKENS_CSS} does not declare`).toBe(true);
      expect(vocabulary.tokens[token!]?.class, `${name} maps --${token}, whose vocabulary class differs`).toBe(name);
    }
  });

  it("declare every custom property the source reads", () => {
    expect(sources.length).toBeGreaterThan(10);
    const undeclared = sources.flatMap(([file, text]) =>
      [...text.matchAll(/var\(--([a-z0-9-]+)/g)]
        .map((match) => match[1])
        .filter((name) => !declared.has(name) && !RUNTIME_PROPERTIES.has(name))
        .map((name) => `${file}: --${name}`),
    );
    expect(undeclared).toEqual([]);
  });
});
