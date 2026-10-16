import type { Platform } from "./contract.js";
import { isDeepStrictEqual } from "./deep-equal.js";
import { documentSchema } from "./document-schema.generated.js";
import { compileSchema } from "./browser-schema.js";
import { sha256Hex } from "./sha256.js";

/** The browser platform (see contract.ts): no `node:` import, no `Buffer`, no `eval` and no `new Function`. */
const NO_CODE = "this entry never runs code itself: a code node runs only through the host's runCode";

export const compileTransform: Platform["compileTransform"] = () => { throw new Error(NO_CODE); };
/** A code node's source is not parsed here (parsing it takes `new Function`); the host's runCode owns its syntax. */
export const compileTransformSyntax: Platform["compileTransformSyntax"] = () => {};
/** A Proxy cannot be told from its target without `node:util`; documents reach a page as JSON or a structured clone. */
export const isProxy: Platform["isProxy"] = () => false;
export { compileSchema, documentSchema, isDeepStrictEqual, sha256Hex };
