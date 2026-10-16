import type { TLocalizedValidationError } from "typebox/error";

/** What the interpreter needs from its platform: one contract, two implementations. `node.ts` is the Node one (the
 *  `node:` built-ins and typebox's compiler); `browser.ts` is the browser one (no `node:` import, no `Buffer`, no
 *  `eval` or `new Function`). package.json `imports` maps `#platform` to the browser file under the `browser`
 *  condition and to the Node file otherwise, so a bundler for the browser never reaches a Node built-in. */
export type SchemaValidator = {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<TLocalizedValidationError>;
};

export type Platform = {
  /** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
  sha256Hex(text: string): string;
  /** Node's `isDeepStrictEqual` semantics for the values a workflow's state holds. */
  isDeepStrictEqual(a: unknown, b: unknown): boolean;
  /** Whether `value` is a Proxy. The browser cannot tell and answers false. */
  isProxy(value: unknown): boolean;
  /** A validator for a JSON Schema; throws for a schema that cannot be compiled. */
  compileSchema(schema: unknown): SchemaValidator;
  /** The workflow document's JSON Schema (`schema/workflow.schema.json`). */
  documentSchema: unknown;
  /** Compile a code node's source to a transform. The browser never compiles code: a host supplies `runCode`. */
  compileTransform(src: string): (value: any, ctx?: any) => any;
  /** Parse a code node's source without running it. The browser never parses code. */
  compileTransformSyntax(src: string): void;
};
