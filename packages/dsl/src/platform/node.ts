import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as nodeIsDeepStrictEqual, types as utilTypes } from "node:util";
import { Compile } from "typebox/compile";
import type { SchemaValidator } from "./contract.js";

/** The Node platform (see contract.ts): the `node:` built-ins and typebox's compiler, exactly as the interpreter
 *  used them before the platform seam. */
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
export const isDeepStrictEqual = (a: unknown, b: unknown): boolean => nodeIsDeepStrictEqual(a, b);
export const isProxy = (value: unknown): boolean => utilTypes.isProxy(value);
export const compileSchema = (schema: unknown): SchemaValidator => Compile(schema as never) as unknown as SchemaValidator;
export const documentSchema: unknown = createRequire(import.meta.url)("../../schema/workflow.schema.json");

// Literal workflow JavaScript runs in the host process, compiled by the one module that does it (code-exec.ts): trusted authors only.
export { compileTransform, compileTransformSyntax } from "../code-exec.js";
