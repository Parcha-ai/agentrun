import { isAsyncFunction, isPromise } from "node:util/types";

// Literal workflow JavaScript runs in the host process. Only execute workflows from trusted
// authors. Shadowing common globals catches some mistakes; it is NOT a security
// boundary, an isolation mechanism, a guarantee of purity, or a deadline for arbitrary code.

// `import` and `eval` cannot be shadowed as strict-mode parameters. Code-node validation does
// not prohibit them or prevent access to globals through other expressions. Executor-specific
// lint is separate and does not make code nodes safe for untrusted authors.
const DENIED_GLOBALS = [
  "require", "module", "exports", "process", "global", "globalThis", "__dirname", "__filename",
  "fetch", "XMLHttpRequest", "Function", "Buffer",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Promise", "Date",
];

/** Words after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const IDENTIFIER_START = /[A-Za-z_$\u0080-\uffff]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/** The denied globals a transform's source names, in DENIED_GLOBALS order: a lexical scan of the source
 *  that skips comments, string and template text and regular-expression literals, and ignores a name
 *  read as a property (after `.` or `?.`). A name used as an object key or a local binding is still
 *  named: the lint refuses rather than guesses. It is a lint for untrusted authors, never a boundary:
 *  a host that runs such code isolates it (deps.runCode). */
export function deniedGlobalReferences(src: string): string[] {
  const denied: ReadonlySet<string> = new Set(DENIED_GLOBALS);
  const found = new Set<string>();
  const braces: ("brace" | "template")[] = [];
  const n = typeof src === "string" ? src.length : 0;
  let i = 0;
  // The previous significant token: a word, a value (literal, closing bracket), or punctuation.
  let prev: { kind: "word" | "value" | "punct"; text: string } | null = null;
  /** Template text from i: true when it stopped at `${` (code follows), false at its closing backtick. */
  const templateText = (): boolean => {
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") { i += 1; return false; }
      if (src[i] === "$" && src[i + 1] === "{") { i += 2; braces.push("template"); return true; }
      i += 1;
    }
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); i = end < 0 ? n : end; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < n && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1; prev = { kind: "value", text: c }; continue;
    }
    if (c === "`" || (c === "}" && braces[braces.length - 1] === "template")) {
      if (c === "}") braces.pop();
      i += 1;
      prev = templateText() ? null : { kind: "value", text: "`" };
      continue;
    }
    if (c === "/") {
      const regex = prev === null || (prev.kind === "punct" && !")]}".includes(prev.text)) || (prev.kind === "word" && REGEX_AFTER_WORDS.has(prev.text));
      if (regex) {
        i += 1;
        let inClass = false;
        while (i < n && (inClass || src[i] !== "/")) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inClass = true; else if (src[i] === "]") inClass = false;
          i += 1;
        }
        i += 1;
        while (i < n && IDENTIFIER_PART.test(src[i])) i += 1;
        prev = { kind: "value", text: "/" }; continue;
      }
    }
    if (IDENTIFIER_START.test(c)) {
      const start = i;
      while (i < n && IDENTIFIER_PART.test(src[i])) i += 1;
      const word = src.slice(start, i);
      if (denied.has(word) && !(prev?.kind === "punct" && prev.text === ".")) found.add(word);
      prev = { kind: "word", text: word }; continue;
    }
    if (/[0-9]/.test(c)) { while (i < n && IDENTIFIER_PART.test(src[i])) i += 1; prev = { kind: "value", text: "0" }; continue; }
    if (c === "." && src.startsWith("...", i)) { i += 3; prev = { kind: "punct", text: "..." }; continue; }
    if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] ?? "")) { i += 2; prev = { kind: "punct", text: "." }; continue; }
    if (c === "{") braces.push("brace");
    if (c === "}") braces.pop();
    i += 1;
    prev = c === ")" || c === "]" || c === "}" ? { kind: "value", text: c } : { kind: "punct", text: c };
  }
  return DENIED_GLOBALS.filter((name) => found.has(name));
}

function createTransformFactory(src: string): (...denied: undefined[]) => (value: any, ctx?: any) => any {
  if (typeof src !== "string" || !src.trim()) throw new Error("code transform source must be a non-empty string");
  let factory: (...denied: undefined[]) => (value: any, ctx?: any) => any;
  try {
    factory = new Function(
      ...DENIED_GLOBALS,
      `"use strict";\nconst __fn = (${src});\nif (typeof __fn !== "function") throw new Error("code must evaluate to a single (value) => value function");\nreturn __fn;`,
    ) as any;
  } catch (e: any) {
    throw new Error(`code transform failed to compile: ${e?.message || e}`);
  }
  return factory;
}

/** Parse the same expression as trusted execution, without evaluating it or calling its body.
 * Syntax validity does not prove that the expression produces a function or a valid patch. */
export function compileTransformSyntax(src: string): void {
  createTransformFactory(src);
}

export function compileTransform(src: string): (value: any, ctx?: any) => any {
  const fn = createTransformFactory(src)(...DENIED_GLOBALS.map(() => undefined));
  if (isAsyncFunction(fn)) throw new Error("code transforms are synchronous; async functions are not supported");
  return (value: any, ctx?: any) => {
    const result = fn(value, ctx);
    if (isPromise(result)) {
      void Promise.prototype.then.call(result, undefined, () => {});
      throw new Error("code transforms are synchronous; returned a Promise or thenable");
    }
    if (result && typeof result.then === "function") {
      throw new Error("code transforms are synchronous; returned a Promise or thenable");
    }
    return result;
  };
}
