// How every harness sees a computer: the `computer` object's types (api.ts), the one core that answers a script, a
// per-step tool and a claim's MCP endpoint alike (core.ts), its outline (outline.ts), and the script binding (script.ts).
export type * from "./api.js";
export { actText, cardOf, chordKeys, createSurface, MAX_READ_BYTES, opsOf, stepName, SURFACE_OPS, SurfaceError, withoutImageData } from "./core.js";
export type { Surface, SurfaceAnswer, SurfaceOp } from "./core.js";
export { lineOf, OUTLINE_MAX_CHARS, outlineOf } from "./outline.js";
export { bindComputer, COMPUTER_CALL_GLOBAL, scriptPrelude } from "./script.js";
