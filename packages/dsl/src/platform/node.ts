import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as nodeIsDeepStrictEqual, types as utilTypes } from "node:util";
import { isAsyncFunction, isPromise } from "node:util/types";
import { Compile } from "typebox/compile";
import { DENIED_GLOBALS } from "../denied-globals.js";
import type { SchemaValidator } from "./contract.js";

/** The Node platform (see contract.ts): the `node:` built-ins and typebox's compiler, exactly as the interpreter
 *  used them before the platform seam. */
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
export const isDeepStrictEqual = (a: unknown, b: unknown): boolean => nodeIsDeepStrictEqual(a, b);
export const isProxy = (value: unknown): boolean => utilTypes.isProxy(value);
export const compileSchema = (schema: unknown): SchemaValidator => Compile(schema as never) as unknown as SchemaValidator;
export const documentSchema: unknown = createRequire(import.meta.url)("../../schema/workflow.schema.json");

// Literal workflow JavaScript runs in the host process. Only execute workflows from trusted authors; see code-exec.ts.
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
