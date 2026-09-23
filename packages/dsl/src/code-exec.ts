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
