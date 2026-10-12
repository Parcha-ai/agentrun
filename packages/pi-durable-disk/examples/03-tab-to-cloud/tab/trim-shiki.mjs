// An esbuild plugin for the page's bundle: @pierre/diffs loads its highlighter languages and themes by dynamic import, one chunk each (about 300 files, 10+ MB), and the page has to carry
// everything it loads (it goes offline). The agent writes TypeScript, Python, shell, JSON and a little markup, so only those grammars and one dark theme are bundled; any other language or theme
// resolves to an empty module (the code then shows as plain text). The oniguruma wasm engine is never used (the JavaScript regex engine is the default) and is left out.
const LANGS = new Set(["typescript", "javascript", "tsx", "jsx", "json", "jsonc", "python", "shellscript", "markdown", "xml", "css", "html", "yaml", "toml", "diff"]);
const THEMES = new Set(["github-dark"]);
export const trimShiki = {
  name: "trim-shiki",
  setup(b) {
    const empty = { path: "empty", namespace: "trim-shiki-empty" };
    b.onResolve({ filter: /^@shikijs\/langs\/.+$/ }, (a) => (LANGS.has(a.path.split("/").pop()) ? undefined : empty));
    b.onResolve({ filter: /^@shikijs\/themes\/.+$/ }, (a) => (THEMES.has(a.path.split("/").pop()) ? undefined : empty));
    b.onResolve({ filter: /^shiki\/wasm$/ }, () => empty);
    b.onLoad({ filter: /.*/, namespace: "trim-shiki-empty" }, () => ({ contents: "export default []", loader: "js" }));
  },
};
