// Keyless Exa's faux switch and serve's words for its free limit. The provider itself (Exa's public MCP endpoint) is
// @parcha/agentrun-web's providers/exa-keyless.ts.
import { RATE_LIMITED } from "./keyless-mcp.js";

export { RATE_LIMITED };
/** Under `--faux` only: a module whose default export is the fetch Exa's MCP exchange goes through (the tests' fake
 *  MCP server), in place of Exa's endpoint. */
export const FAUX_EXA_ENV = "AGENTRUN_SERVE_FAUX_EXA";
